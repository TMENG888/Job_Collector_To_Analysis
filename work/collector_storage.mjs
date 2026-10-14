import fs from 'node:fs/promises';
import path from 'node:path';
const queues=new Map();
// Windows readers can briefly deny rename. Retry only the atomic rename, never
// remove the destination or retry platform requests to hide a persistent lock.
export async function renameWithSharingRetry(source,destination,{rename=fs.rename,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}) {
  const delays=[100,250,500];
  for(let attempt=0;;attempt++) {
    try{return await rename(source,destination);}
    catch(error){
      if(!['EBUSY','EPERM'].includes(error.code)||attempt>=delays.length)throw error;
      await sleep(delays[attempt]);
    }
  }
}
export function writeAtomic(file,text){
  const key=path.resolve(file);
  const previous=queues.get(key)||Promise.resolve();
  const task=previous.catch(()=>{}).then(async()=>{
    const temporary=`${file}.tmp-${process.pid}`;
    await fs.writeFile(temporary,text,'utf8');
    try{await renameWithSharingRetry(temporary,file);}catch(cause){throw Object.assign(new Error(`文件无法原子替换（${cause.code||'未知错误'}），原文件未覆盖；本轮数据保存在 ${temporary}`),{code:'OUTPUT_LOCKED',stopChannel:true,cause});}
  });
  queues.set(key,task);
  const clear=()=>{if(queues.get(key)===task)queues.delete(key);};task.then(clear,clear);
  return task;
}
export function writeJsonAtomic(file,value){return writeAtomic(file,JSON.stringify(value,null,2));}
