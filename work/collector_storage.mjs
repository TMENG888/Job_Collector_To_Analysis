import fs from 'node:fs/promises';
import path from 'node:path';
const queues=new Map();
export function writeAtomic(file,text){
  const key=path.resolve(file);
  const previous=queues.get(key)||Promise.resolve();
  const task=previous.catch(()=>{}).then(async()=>{
    const temporary=`${file}.tmp-${process.pid}`;
    await fs.writeFile(temporary,text,'utf8');
    try{await fs.rename(temporary,file);}catch(cause){throw Object.assign(new Error(`文件被占用，原文件未覆盖；本轮数据保存在 ${temporary}`),{code:'OUTPUT_LOCKED',stopChannel:true,cause});}
  });
  queues.set(key,task);
  const clear=()=>{if(queues.get(key)===task)queues.delete(key);};task.then(clear,clear);
  return task;
}
export function writeJsonAtomic(file,value){return writeAtomic(file,JSON.stringify(value,null,2));}
