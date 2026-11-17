import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';

export function createKnowledgeSnapshot(dataDir,uri){
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL(import.meta.url),{workerData:{dataDir,uri}});
    let received=false;
    worker.once('message',result=>{received=true;result.error?reject(new Error(result.error)):resolve(result.snapshot);});
    worker.once('error',reject);
    worker.once('exit',code=>{if(!received)reject(new Error(`岗位快照工作线程退出（${code}），请核对分析状态`));});
  });
}

if(!isMainThread){
  try{
    const {createKnowledgeStore}=await import('./job_knowledge_store.mjs');
    const snapshot=await createKnowledgeStore(workerData.dataDir).snapshot(workerData.uri,{synchronize:false});
    parentPort.postMessage({snapshot});
  }catch(error){parentPort.postMessage({error:error.message});}
}
