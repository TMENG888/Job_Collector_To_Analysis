import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {knowledgeDatabasePath} from './knowledge_storage.mjs';
import {PROCESSING_VERSION,PROCESSING_HASH,normalizeJobFields,jobProcessingChanges,plainJobText,jobInputUsability} from './job_processing_rules.mjs';
import {processingDirectory,readProcessingBatch} from './job_processing_cache.mjs';

export const processingStages=[
  {id:'raw',title:'采集源数据',note:'任务内原始字段'},
  {id:'merged',title:'身份合并',note:'平台＋岗位ID去重'},
  {id:'cleaned',title:'字段清洗',note:'薪资、地区、学历经验'},
  {id:'ready',title:'洞察输入',note:'正文与身份可用'},
];
function scopeOf(input={}){
  const scope={taskId:String(input.taskId||'all'),platform:String(input.platform||'all'),q:String(input.q||'').trim(),stage:String(input.stage||'merged'),page:Number(input.page||1),pageSize:Number(input.pageSize||50)};
  if(!['merged','cleaned','ready','issues'].includes(scope.stage)||!Number.isSafeInteger(scope.page)||scope.page<1||!Number.isSafeInteger(scope.pageSize)||scope.pageSize<1||scope.pageSize>100||scope.taskId.length>200||scope.platform.length>80||scope.q.length>120)throw Error('处理数据筛选参数无效');
  return scope;
}
function openKnowledge(database){
  const db=new DatabaseSync(database,{readOnly:true});db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=3000; BEGIN');
  db.function('processing_input',{deterministic:true},value=>{try{const r=jobInputUsability(JSON.parse(value));return Number(r.identity&&r.bodyUsable);}catch{return 0;}});
  return db;
}
function filterOf(scope){
  const args=[],where=[`EXISTS (SELECT 1 FROM memberships m JOIN tasks t ON t.task_id=m.task_id WHERE m.job_key=j.job_key AND t.archived=0${scope.taskId==='all'?'':' AND m.task_id=?'})`];
  if(scope.taskId!=='all')args.push(scope.taskId);
  if(scope.platform!=='all'){where.push('j.platform=?');args.push(scope.platform);}
  if(scope.q){const like='%'+scope.q.replace(/[\\%_]/g,'\\$&')+'%';where.push("(j.job_id LIKE ? ESCAPE '\\' OR "+['job_name','company_name','city','job_description'].map(k=>`CAST(json_extract(j.raw,'$.${k}') AS TEXT) LIKE ? ESCAPE '\\'`).join(' OR ')+')');args.push(...Array(5).fill(like));}
  return {sql:where.join(' AND '),args};
}
function openCache(cacheFile,write=false){
  const db=new DatabaseSync(cacheFile,{readOnly:!write});
  db.exec('PRAGMA busy_timeout=5000');
  if(write)db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS processed(job_key TEXT PRIMARY KEY,content_hash TEXT NOT NULL,rules_hash TEXT NOT NULL,data TEXT NOT NULL,processed_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS run_items(run_id TEXT,job_key TEXT,content_hash TEXT NOT NULL,input_usable INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(run_id,job_key));`);
  return db;
}
function cacheReader(cacheFile){
  let db,statement;
  try{db=openCache(cacheFile);statement=db.prepare('SELECT data,processed_at FROM processed WHERE job_key=? AND content_hash=? AND rules_hash=?');}catch{db?.close();return {get:()=>null,runs:()=>[],close:()=>{}};}
  return {get:row=>{const found=statement.get(row.job_key,row.content_hash,PROCESSING_HASH);return found?{processed:JSON.parse(found.data),processedAt:found.processed_at}:null;},runs:()=>db.prepare('SELECT data FROM runs ORDER BY rowid DESC LIMIT 20').all().map(r=>JSON.parse(r.data)),close:()=>db.close()};
}
const provenance=(db,key)=>db.prepare('SELECT t.task_id AS id,t.label FROM memberships m JOIN tasks t ON t.task_id=m.task_id WHERE m.job_key=? AND t.archived=0 ORDER BY t.task_id').all(key);
export function queryProcessingRows(database,cacheFile,input={}){
  const scope=scopeOf(input),db=openKnowledge(database),cache=cacheReader(cacheFile);
  try{
    const tasks=db.prepare('SELECT t.task_id AS id,t.label,COUNT(m.job_key) AS rows FROM tasks t LEFT JOIN memberships m ON m.task_id=t.task_id WHERE t.archived=0 GROUP BY t.task_id ORDER BY t.label').all().map(t=>({...t,available:true}));
    if(scope.taskId!=='all'&&!tasks.some(t=>t.id===scope.taskId))throw Error('所选任务尚未同步到岗位知识库，请执行清洗');
    const indexedJobs=db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='jobs_processing_scope'").get()?'jobs j INDEXED BY jobs_processing_scope':'jobs j';
    const base=filterOf(scope),platformFilter=filterOf({...scope,platform:'all',q:''});
    const platforms=db.prepare(`SELECT j.platform,COUNT(*) AS rows FROM ${indexedJobs} WHERE ${platformFilter.sql} GROUP BY j.platform ORDER BY rows DESC`).all(...platformFilter.args);
    const merged=Number(db.prepare(`SELECT COUNT(*) AS n FROM ${indexedJobs} WHERE ${base.sql}`).get(...base.args).n);
    const revision=Number(db.prepare("SELECT value FROM metadata WHERE key='revision'").get()?.value||0);
    const matching=cache.runs().find(run=>run.status==='completed'&&run.rulesHash===PROCESSING_HASH&&run.revision===revision&&['taskId','platform','q'].every(k=>(run.scope[k]||'')===(scope[k]||'')));
    let from=indexedJobs,eligibility='processing_input(j.raw)';
    if(['ready','issues'].includes(scope.stage)&&existsSync(cacheFile)){
      db.prepare('ATTACH DATABASE ? AS processing_cache').run(cacheFile);
      from=`${indexedJobs} LEFT JOIN processing_cache.processed p ON p.job_key=j.job_key AND p.content_hash=j.content_hash AND p.rules_hash='${PROCESSING_HASH}'`;
      eligibility="CASE WHEN p.job_key IS NOT NULL THEN CAST(json_extract(p.data,'$.usability.input') AS INTEGER) ELSE processing_input(j.raw) END";
    }
    const extra=scope.stage==='ready'?` AND (${eligibility})=1`:scope.stage==='issues'?` AND (${eligibility})=0`:'';
    const total=extra?(matching?(scope.stage==='ready'?matching.ready:matching.pending):Number(db.prepare(`SELECT COUNT(*) AS n FROM ${from} WHERE ${base.sql}${extra}`).get(...base.args).n)):merged;
    const pages=Math.max(1,Math.ceil(total/scope.pageSize));scope.page=Math.min(pages,scope.page);
    const data=db.prepare(`SELECT j.job_key,j.content_hash,j.platform,j.job_id,j.raw FROM ${from} WHERE ${base.sql}${extra} ORDER BY j.job_key LIMIT ? OFFSET ?`).all(...base.args,scope.pageSize,(scope.page-1)*scope.pageSize);
    let cached=0;
    const rows=data.map(record=>{
      const raw=JSON.parse(record.raw),saved=cache.get(record),processed=saved?.processed||normalizeJobFields(raw),origins=provenance(db,record.job_key);if(saved)cached++;
      const fields={...raw,...(scope.stage==='merged'?{}:processed.fields),original_salary:raw.salary,original_city:raw.city,original_education:raw.education,original_experience:raw.experience,
        salary_usable:processed.usability.salary?'可统计':'不参与薪资统计',body_usable:processed.usability.body?'可用':'待补充/核对',region_usable:processed.usability.province?'可比较':'不参与省份对比',issues:processed.issues.join('；')||'未发现上述规则问题',processing_state:saved?'已保存清洗结果':'当前规则预览',source_tasks:origins.map(t=>t.label).join(' / ')};
      return {taskId:scope.taskId,taskLabel:fields.source_tasks,platform:record.platform,jobId:record.job_id,key:record.job_key,contentHash:record.content_hash,fields,descriptionPreview:(scope.stage==='merged'?String(raw.job_description||''):plainJobText(raw.job_description)).slice(0,180),descriptionLength:String(raw.job_description||'').length};
    });
    return {scope,total,pages,rows,tasks,platforms,warnings:[],revision,source:'knowledge-processing',stages:processingStages,counts:{merged,cleaned:merged,...(scope.stage==='ready'?{ready:total,issues:merged-total}:scope.stage==='issues'?{issues:total,ready:merged-total}:{})},cachedPageRows:cached,
      checkedAt:new Date().toISOString(),rulesVersion:PROCESSING_VERSION,rulesHash:PROCESSING_HASH,
      countPolicy:'合并后每个平台＋岗位ID一条；字段清洗保留全部记录。洞察输入仅检查身份、名称与正文，不等于已通过特定岗位分类；薪资、地区分别判断可用性。'};
  }finally{cache.close();db.close();}
}
export function queryProcessingDetail(database,cacheFile,input={}){
  const scope=scopeOf(input),db=openKnowledge(database),cache=cacheReader(cacheFile);
  try{const filter=filterOf({...scope,q:'',platform:'all'});
    const row=db.prepare(`SELECT j.* FROM jobs j WHERE ${filter.sql} AND j.job_key=?`).get(...filter.args,String(input.key||''));
    if(!row)throw Error('所选任务范围没有这条岗位');
    if(input.contentHash&&input.contentHash!==row.content_hash)throw Error('岗位已更新，请刷新表格再查看');
    const raw=JSON.parse(row.raw),saved=cache.get(row),processed=saved?.processed||normalizeJobFields(raw);
    return {raw,processed,changes:jobProcessingChanges(raw,processed),origins:provenance(db,row.job_key),processedAt:saved?.processedAt||null,contentHash:row.content_hash};
  }finally{cache.close();db.close();}
}
export async function runJobProcessing({dataDir,database,cacheFile,input,id=randomUUID(),synchronize=true,onProgress=()=>{}}){
  const scope=scopeOf({...input,stage:'cleaned'});
  let syncWarnings=[];
  if(synchronize){onProgress({phase:'sync',message:'正在同步采集入库并合并岗位身份…'});const {createKnowledgeStore}=await import('./job_knowledge_store.mjs');const result=await createKnowledgeStore(dataDir).sync({refresh:false});syncWarnings=result.sync_errors||[];}
  await fs.mkdir(path.dirname(cacheFile),{recursive:true});const cache=openCache(cacheFile,true),db=openKnowledge(database);
  const startedAt=new Date().toISOString();let transaction=false;
  const run={id,status:'running',scope,startedAt,version:PROCESSING_VERSION,rulesHash:PROCESSING_HASH,completed:0,reused:0,ready:0,pending:0,salary:0,warnings:syncWarnings};
  const save=()=>cache.prepare('INSERT OR REPLACE INTO runs VALUES(?,?)').run(id,JSON.stringify(run));
  try{
    if(scope.taskId!=='all'&&!db.prepare('SELECT 1 FROM tasks WHERE task_id=? AND archived=0').get(scope.taskId))throw Error('所选任务没有可处理的知识库数据');
    const filter=filterOf(scope);run.total=Number(db.prepare(`SELECT COUNT(*) AS n FROM jobs j WHERE ${filter.sql}`).get(...filter.args).n);
    run.revision=Number(db.prepare("SELECT value FROM metadata WHERE key='revision'").get()?.value||0);save();
    const get=cache.prepare('SELECT data FROM processed WHERE job_key=? AND content_hash=? AND rules_hash=?'),put=cache.prepare('INSERT OR REPLACE INTO processed VALUES(?,?,?,?,?)'),item=cache.prepare('INSERT INTO run_items VALUES(?,?,?,?,?)');
    cache.exec('BEGIN');transaction=true;
    for(const row of db.prepare(`SELECT j.job_key,j.content_hash,j.raw FROM jobs j WHERE ${filter.sql} ORDER BY j.job_key`).iterate(...filter.args)){
      const saved=get.get(row.job_key,row.content_hash,PROCESSING_HASH),processed=saved?JSON.parse(saved.data):normalizeJobFields(JSON.parse(row.raw));
      if(saved)run.reused++;else put.run(row.job_key,row.content_hash,PROCESSING_HASH,JSON.stringify(processed),new Date().toISOString());
      item.run(id,row.job_key,row.content_hash,Number(processed.usability.input),JSON.stringify(processed));
      run.completed++;if(processed.usability.input)run.ready++;else run.pending++;if(processed.usability.salary)run.salary++;
      if(run.completed%500===0){cache.exec('COMMIT');transaction=false;save();onProgress({...run,phase:'clean',message:`已清洗 ${run.completed.toLocaleString('zh-CN')} / ${run.total.toLocaleString('zh-CN')} 条`});cache.exec('BEGIN');transaction=true;}
    }
    cache.exec('COMMIT');transaction=false;run.status='completed';run.finishedAt=new Date().toISOString();save();return run;
  }catch(error){if(transaction)cache.exec('ROLLBACK');run.status='failed';run.error=error.message;run.finishedAt=new Date().toISOString();save();throw error;}
  finally{db.close();cache.close();}
}
export function createJobProcessingService(dataDir,{database=knowledgeDatabasePath(dataDir),directory=processingDirectory(dataDir)}={}){
  const cacheFile=path.join(directory,'processing.sqlite');let active=null;
  const invoke=(kind,input,onProgress)=>new Promise((resolve,reject)=>{
    const worker=new Worker(new URL(import.meta.url),{workerData:{kind,dataDir,database,cacheFile,input}});let settled=false;
    const timer=setTimeout(()=>{settled=true;void worker.terminate();reject(Error('处理查询超时，请缩小任务范围'));},kind==='run'?1800000:90000);
    worker.on('message',msg=>{if(msg.progress){onProgress?.(msg.progress);return;}settled=true;clearTimeout(timer);msg.ok?resolve(msg.result):reject(Error(msg.error));});
    worker.once('error',error=>{settled=true;clearTimeout(timer);reject(error);});worker.once('exit',()=>{clearTimeout(timer);if(!settled)reject(Error('处理进程中断，请重新执行；源数据保留'));});
  });
  return {list:input=>invoke('list',input),detail:input=>invoke('detail',input),
    transfer({id}){const run=readProcessingBatch(dataDir,id,{metadataOnly:true});if(!run.ready)throw Error('这批数据没有正文和身份可用的记录，请先补充原始数据');return {inputFile:`kb://processed/${run.id}`,run};},
    async status(){if(active)return active;if(!await fs.stat(cacheFile).catch(error=>{if(error.code==='ENOENT')return null;throw error;}))return null;const db=openCache(cacheFile);try{const saved=JSON.parse(db.prepare('SELECT data FROM runs ORDER BY rowid DESC LIMIT 1').get()?.data||'null');return saved?.status==='running'?{...saved,status:'failed',error:'上次清洗进程已中断，请重新执行；已完成的逐条结果可以复用'}:saved;}finally{db.close();}},
    start(input){scopeOf({...input,stage:'cleaned'});if(active?.status==='running')throw Error('已有清洗任务正在运行，请等待完成');active={id:randomUUID(),status:'running',scope:input,phase:'sync',message:'正在准备数据处理…',startedAt:new Date().toISOString()};
      void invoke('run',{...input,id:active.id},progress=>{active={...active,...progress,status:'running'};}).then(result=>{active=result;},error=>{active={...active,status:'failed',error:error.message,finishedAt:new Date().toISOString()};});return active;},
  };
}
if(!isMainThread&&workerData?.cacheFile){
  const {kind,dataDir,database,cacheFile,input}=workerData;
  try{const result=kind==='run'?await runJobProcessing({dataDir,database,cacheFile,input,id:input.id,onProgress:progress=>parentPort.postMessage({progress})}):kind==='detail'?queryProcessingDetail(database,cacheFile,input):queryProcessingRows(database,cacheFile,input);parentPort.postMessage({ok:true,result});}
  catch(error){parentPort.postMessage({ok:false,error:String(error.message).slice(0,300)});}
}
