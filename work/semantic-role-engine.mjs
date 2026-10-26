import path from 'node:path';
import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createHash} from 'node:crypto';
import {roleSections} from './role-evidence-v2.mjs';
import {activeRoleReference,semanticRoleRoot} from './semantic-role-references.mjs';

const clean=value=>String(value||'').normalize('NFKC').replace(/<[^>]+>/g,' ').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[邮箱]').replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g,'[手机号]').replace(/https?:\/\/\S+|www\.\S+/gi,'[网址]').replace(/[ \t]+/g,' ').trim();
const prepared=new WeakMap();
export function semanticRoleInput(row){
  const titleRaw=row['岗位名称']??row.job_name??row.title,bodyRaw=row['岗位描述']??row.job_description??row.description??row.body;
  const previous=prepared.get(row);if(previous&&previous.titleRaw===titleRaw&&previous.bodyRaw===bodyRaw)return previous.input;
  const title=clean(titleRaw),body=clean(bodyRaw);
  const sections=roleSections({'岗位描述':body});
  const parts=location=>sections.filter(s=>s.location===location).map(s=>s.quote).join('；');
  const duties=parts('duties'),requirements=parts('requirements'),unsectioned=parts('unsectioned');
  const key=createHash('sha256').update(JSON.stringify([title,duties,requirements,unsectioned])).digest('hex');
  const value={key,title,duties,requirements,unsectioned,eligible:!!title&&(duties+requirements+unsectioned).replace(/\s/g,'').length>=80};
  prepared.set(row,{titleRaw,bodyRaw,input:value});return value;
}
const scoresByReference=new Map();
let worker=null,sequence=0,starting=null,idle=null,queue=Promise.resolve(),lastError='',lastProgress=null;
const awaiting=new Map();
function stopWorker(){if(worker){worker.stdin.end();worker.kill();worker=null;}}
process.once('exit',stopWorker);
export const semanticEngineStatus=()=>({workerReady:!!worker,busy:awaiting.size>0,progress:lastProgress,error:lastError});
export async function closeSemanticEngine(){clearTimeout(idle);stopWorker();}
function failAll(message){lastError=message;for(const {reject,timer}of awaiting.values()){clearTimeout(timer);reject(Error(message));}awaiting.clear();}
async function startWorker(){
  if(worker)return worker;
  if(starting)return starting;
  starting=(async()=>{
    const root=path.resolve(import.meta.dirname,'..'),runtime=semanticRoleRoot();await fs.mkdir(runtime,{recursive:true});
    const python=process.env.JOB_SEMANTIC_PYTHON||path.join(root,'work/role_screening_env/Scripts/python.exe');
    await fs.access(python);
    const child=spawn(python,['-B',path.join(import.meta.dirname,'semantic-role-worker.py')],{cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,JOB_SEMANTIC_ROLE_DIR:runtime,TEMP:runtime,TMP:runtime,PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1'}});
    worker=child;let diagnostic='';
    child.stderr.on('data',data=>{diagnostic=(diagnostic+data.toString()).slice(-1500);});
    child.on('error',()=>{if(worker===child){worker=null;failAll('本地语义模型进程无法启动；未回退逻辑回归');}});
    child.on('close',code=>{if(worker===child){worker=null;failAll('本地语义进程退出'+(code?` (${code})`:'')+'；未回退逻辑回归'+(diagnostic?'，请检查本地模型环境':''));}});
    child.stdin.on('error',()=>{if(worker===child){worker=null;failAll('本地语义进程通信中断');child.kill();}});
    createInterface({input:child.stdout}).on('line',line=>{
      let payload;try{payload=JSON.parse(line);}catch{return;}
      const entry=awaiting.get(payload.id);if(!entry)return;
      awaiting.delete(payload.id);clearTimeout(entry.timer);
      if(payload.error){lastError=payload.error;entry.reject(Error('语义计算失败：'+payload.error));}else{lastError='';entry.resolve(payload.result);}
      if(!awaiting.size){clearTimeout(idle);idle=setTimeout(stopWorker,120000);idle.unref();}
    });return child;
  })();
  try{return await starting;}finally{starting=null;}
}
async function request(ref,rows){
  clearTimeout(idle);const child=await startWorker(),id=++sequence;
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{awaiting.delete(id);reject(Error('语义计算超时，未回退旧分类器'));failAll('语义进程超时');stopWorker();},180000);timer.unref();
    awaiting.set(id,{resolve,reject,timer});
    child.stdin.write(JSON.stringify({id,action:'classify',references:ref.references,referenceHash:ref.sha256,rows})+'\n');
  });
}
export function validateSimilarityScores(scores,ref){
  return Array.isArray(scores)&&scores.length===ref.references.targets.length+ref.references.other.length&&scores.every(n=>Number.isFinite(n)&&n>=-1.00001&&n<=1.00001);
}
export async function prepareSemanticRoles(rows,{reference=activeRoleReference(),onProgress=()=>{}}={}){
  if(!reference)throw Error('尚未启用语义参照，请先生成并确认参照描述；不回退逻辑回归或规则');
  const run=async()=>{
    const cache=scoresByReference.get(reference.sha256)||new Map();scoresByReference.set(reference.sha256,cache);
    const unique=new Map();let eligible=0;
    for(const row of rows){const input=semanticRoleInput(row);if(input.eligible){eligible++;if(!cache.has(input.key))unique.set(input.key,input);}}
    const pending=[...unique.values()];let done=0;
    const progress=()=>{lastProgress={completed:done,total:pending.length,rows:rows.length,eligible,referenceHash:reference.sha256};onProgress(lastProgress);};progress();
    for(let offset=0;offset<pending.length;offset+=2000){
      const batch=pending.slice(offset,offset+2000),response=await request(reference,batch);
      if(response.referenceHash!==reference.sha256||response.rows.length!==batch.length)throw Error('语义结果参照版本或条数不一致');
      for(let i=0;i<batch.length;i++){const item=response.rows[i];if(item.key!==batch[i].key||!validateSimilarityScores(item.scores,reference))throw Error('语义结果内容校验失败');cache.set(item.key,item.scores);}
      done+=batch.length;progress();
    }
    return {reference,rows:rows.length,eligible,newScores:pending.length};
  };
  const result=queue.then(run);queue=result.catch(()=>{});return result;
}
export function semanticRoleDecision(scores,ref,family){
  if(!validateSimilarityScores(scores,ref))return {decision:'review',score:null,winner:null,otherScore:null,reason:'语义分数尚未计算或无效'};
  const entries=ref.references.targets.concat(ref.references.other),targetIndex=ref.references.targets.findIndex(r=>r.id===family);
  if(targetIndex<0)return {decision:'review',score:null,winner:null,otherScore:null,reason:'尚无该岗位语义参照'};
  const best=Math.max(...scores),ties=scores.filter(n=>Math.abs(n-best)<=1e-7).length,winnerIndex=scores.indexOf(best),winner=entries[winnerIndex].id;
  const otherScore=Math.max(...scores.slice(ref.references.targets.length));
  if(ties!==1)return {decision:'review',score:scores[targetIndex],winner,otherScore,reason:'最近参照存在并列，待复核'};
  const included=winnerIndex===targetIndex;
  return {decision:included?'include':'exclude',score:scores[targetIndex],winner,otherScore,reason:included?'最接近目标岗位参照；仍可能误纳':winnerIndex>=ref.references.targets.length?'更接近其他岗位参照':'更接近岗位参照：'+winner};
}
export function semanticRoleClassifier(family,reference=activeRoleReference()){
  if(!reference?.roles.includes(family))return null;
  const version='semantic-nearest-with-other:'+reference.sha256;
  const metadata={version,id:version,family,scope:family,profile:'semantic-nearest-with-other',algorithm:'local-bge-cosine-nearest-with-other',threshold:null,reference_sha256:reference.sha256,reference_id:reference.id,display_name:'语义相似度＋其他岗位参照',keywords:[],display_keywords:[],minimum_hits:null,training_seed_rows:[],rule_seed_candidates:0,training_background_rows:0,cold_start:false,annotation_type:'DeepSeek生成岗位参照；本地向量比较',provenance:{model:'BAAI/bge-small-zh-v1.5',dimensions:512,references:reference.roles.length,other_references:reference.references.other.length,reference_sha256:reference.sha256,evaluation:reference.evaluation},validation:null,seed_source:'DeepSeek岗位参照，不以待分析岗位拟合',selection_policy:'标题＋职责＋任职要求按固定输入压缩到256 Token；本地归一化语义向量与全部岗位及其他参照比较，唯一最近目标纳入；其他/并列/正文不足不纳入；无逻辑回归或规则回退；余弦相似度不是概率'};
  return {metadata,match(row){
    const input=semanticRoleInput(row),scores=scoresByReference.get(reference.sha256)?.get(input.key);
    const value=input.eligible?semanticRoleDecision(scores,reference,family):{decision:'review',score:null,winner:null,otherScore:null,reason:'标题缺失或有效正文不足80字，待复核'};
    const evidence={model_version:version,reference_sha256:reference.sha256,reference_id:reference.id,input_key:input.key,input_mode:'section-balanced-head-tail-max256-v1',score:value.score,threshold:null,winner:value.winner,other_score:value.otherScore,decision:value.decision,score_semantics:'归一化向量余弦相似度；非概率、非简历匹配度'};
    return {matched:value.decision==='include',decision:value.decision,method:metadata.display_name,confidence_band:value.decision==='include'?'语义纳入（非人工确认）':value.decision==='review'?'待复核':'非目标',reasons:[value.reason],topic_matches:[],joint_evidence:null,classifier_evidence:evidence,semantic_evidence:evidence,keyword_evidence:{hits:[],quotes:[],production_quotes:[],rule_seed:false,algorithm:metadata.algorithm,model_version:version}};
  }};
}
