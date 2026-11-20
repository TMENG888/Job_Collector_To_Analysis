import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {Worker} from 'node:worker_threads';
import {writeJsonAtomic} from './collector_storage.mjs';
import {QUALITY_VERSION} from './job_data_quality.mjs';

const read=async(file,fallback)=>{try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return fallback;throw error;}};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function createQualityService({database,directory=path.join('E:/Codex/work/job-data-quality',createHash('sha256').update(path.resolve(database)).digest('hex').slice(0,16))}){
  let pending=null,mutations=Promise.resolve();
  const file=id=>{if(!uuid.test(String(id)))throw Error('质量报告标识无效');return path.join(directory,id+'.json');};
  const indexFile=path.join(directory,'reports.json'),statesFile=path.join(directory,'issue-states.json');
  const serialized=action=>{const result=mutations.then(action);mutations=result.catch(()=>{});return result;};
  async function decorate(report,reused=true){return {report,states:await read(statesFile,{}),reused};}
  async function load(id){const report=await read(file(id),null);if(!report)throw Error('质量报告不存在，请重新检查');return report;}
  async function history(){return read(indexFile,[]);}
  async function report({taskId='all',platform='all',reportId}={}){
    if(reportId)return decorate(await load(reportId));
    if(typeof taskId!=='string'||typeof platform!=='string'||taskId.length>200||platform.length>80)throw Error('质量检查筛选参数无效');
    const db=new DatabaseSync(database,{readOnly:true});let revision,batchStamp;
    try{revision=db.prepare("SELECT value FROM metadata WHERE key='revision'").get()?.value;const has=db.prepare("SELECT 1 FROM sqlite_master WHERE name='ingestion_batches'").get();batchStamp=has?db.prepare('SELECT COUNT(*) AS n,MAX(created_at) AS stamp FROM ingestion_batches').get():null;}finally{db.close();}
    const key=JSON.stringify([QUALITY_VERSION,revision,batchStamp,taskId,platform]);
    const saved=(await history()).find(r=>r.cacheKey===key);if(saved)return decorate(await load(saved.id));
    if(pending){await pending;return report({taskId,platform});}
    pending=(async()=>{
      const result=await new Promise((resolve,reject)=>{
        const worker=new Worker(new URL('./job_data_quality.mjs',import.meta.url),{workerData:{kind:'job-quality',database,options:{taskId,platform}}});
        let settled=false;
        const timer=setTimeout(()=>{worker.terminate();reject(Error('质量检查超时，请稍后重试；未修改岗位数据'));},120000);
        worker.once('message',message=>{settled=true;clearTimeout(timer);message.ok?resolve(message.report):reject(Error(message.error));});
        worker.once('error',error=>{settled=true;clearTimeout(timer);reject(error);});
        worker.once('exit',code=>{clearTimeout(timer);if(!settled)reject(Error('质量检查进程退出（'+code+'），未修改岗位数据'));});
      });
      await fs.mkdir(directory,{recursive:true});await writeJsonAtomic(file(result.id),result);
      await serialized(async()=>{const entries=await history();await writeJsonAtomic(indexFile,[{id:result.id,createdAt:result.createdAt,revision:result.revision,total:result.total,scope:result.scope,cacheKey:result.revision===Number(revision)?key:null},...entries].slice(0,40));});
      return result;
    })();
    try{return await decorate(await pending,false);}finally{pending=null;}
  }
  async function mark({reportId,issueId,state}){
    if(!['pending','retained','resolved'].includes(state)||typeof issueId!=='string')throw Error('处理状态无效');
    const report=await load(reportId);if(!report.samples.some(s=>s.id===issueId))throw Error('报告中没有此问题样例');
    return serialized(async()=>{const states=await read(statesFile,{});states[issueId]={state,updatedAt:new Date().toISOString(),basis:'人工标记，不改写原始岗位或报告数量'};await writeJsonAtomic(statesFile,states);return states[issueId];});
  }
  return {report,history,mark};
}
