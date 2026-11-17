import fs from 'node:fs/promises';
import {Worker} from 'node:worker_threads';

// Large immutable reports must never be parsed/stringified on the HTTP thread.
export function createInsightReportCache(filename,{knowledgeFilename}={}){
  const cache=new Map(),pending=new Map();
  async function load(snapshotKey=null){
    if(snapshotKey&&!/^[a-f0-9]{64}$/.test(snapshotKey))throw Error('报告快照标识无效');
    const stat=snapshotKey?null:await fs.stat(filename).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    if(!snapshotKey&&!stat)return null;
    const version=snapshotKey?`snapshot-company-v1-${snapshotKey}`:`province-company-v1-${stat.size}-${stat.mtimeMs}`;
    if(cache.has(version))return cache.get(version);
    if(pending.has(version))return pending.get(version);
    const request=new Promise((resolve,reject)=>{
      const worker=new Worker(new URL('./insight-report-worker.mjs',import.meta.url),{workerData:{filename,knowledgeFilename,snapshotKey}});
      worker.once('message',result=>{
        if(result.error){reject(new Error(result.error));return;}
        if(result.missing){resolve(null);return;}
        const cached={version,raw:Buffer.from(result.raw),gzip:Buffer.from(result.gzip)};cache.set(version,cached);
        while(cache.size>3)cache.delete(cache.keys().next().value);resolve(cached);
      });
      worker.once('error',reject);
      worker.once('exit',code=>{if(code!==0)reject(new Error('报告读取进程异常退出'));});
    }).finally(()=>{pending.delete(version);});
    pending.set(version,request);return request;
  }
  return {load};
}
