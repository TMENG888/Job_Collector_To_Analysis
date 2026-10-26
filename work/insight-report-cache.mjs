import fs from 'node:fs/promises';
import {Worker} from 'node:worker_threads';

// Large immutable reports must never be parsed/stringified on the HTTP thread.
export function createInsightReportCache(filename){
  let cached=null,pending=null;
  async function load(){
    const stat=await fs.stat(filename).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    if(!stat)return null;
    const version=`${stat.size}-${stat.mtimeMs}`;
    if(cached?.version===version)return cached;
    if(pending){await pending;return load();}
    pending=new Promise((resolve,reject)=>{
      const worker=new Worker(new URL('./insight-report-worker.mjs',import.meta.url),{workerData:{filename}});
      worker.once('message',result=>{
        if(result.error){reject(new Error(result.error));return;}
        cached={version,raw:Buffer.from(result.raw),gzip:Buffer.from(result.gzip)};resolve(cached);
      });
      worker.once('error',reject);
      worker.once('exit',code=>{if(code!==0)reject(new Error('报告读取进程异常退出'));});
    }).finally(()=>{pending=null;});
    return pending;
  }
  return {load};
}
