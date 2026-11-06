import fs from 'node:fs/promises';
import path from 'node:path';
import {taskWriteContext,mirrorTaskWrite} from './task_output_backup.mjs';
import {recordStorageDiagnostic} from './collector_storage_diagnostics.mjs';
// Windows readers can briefly deny rename. Retry only the atomic rename, never
// remove the destination or retry platform requests to hide a persistent lock.
export async function renameWithSharingRetry(source,destination,{rename=fs.rename,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),onFailure=()=>{}}={}) {
  const delays=[100,250,500];
  for(let attempt=0;;attempt++) {
    try{return await rename(source,destination);}
    catch(error){
      const retry=['EBUSY','EPERM'].includes(error.code)&&attempt<delays.length;
      onFailure({attempt:attempt+1,at:new Date().toISOString(),code:error.code||'unknown',errno:error.errno??null,syscall:error.syscall||null,delayMs:retry?delays[attempt]:0},error);
      if(!retry)throw error;
      await sleep(delays[attempt]);
    }
  }
}
export function createAtomicWriter({contextFor=taskWriteContext,writeFile=fs.writeFile,rename=fs.rename,sleep,mirror=mirrorTaskWrite,diagnose=recordStorageDiagnostic}={}){
const queues=new Map();
return function writeAtomic(file,text){
  const key=path.resolve(file);
  const previous=queues.get(key)||Promise.resolve();
  const task=previous.catch(()=>{}).then(async()=>{
    const temporary=`${file}.tmp-${process.pid}`;
    const started=Date.now(),attempts=[];
    let context=null,phase='context',committed=false,temporaryWritten=false,lastRenameError=null;
    const log=async(error,outcome)=>{
      try{return await diagnose({context,file,temporary,phase,committed,temporaryWritten,intendedBytes:Buffer.byteLength(text,'utf8'),elapsedMs:Date.now()-started,attempts,error,outcome});}
      catch(loggingError){
        try{console.error(`[存储诊断] 日志记录失败 ${loggingError.code||'unknown'}；原始错误 ${error?.code||'unknown'}；阶段 ${phase}；文件 ${file}`);}catch{}
        return {path:null,loggingError:{code:loggingError.code||'unknown'}};
      }
    };
    try{
      context=await contextFor(file);
      phase='write_temporary';
      await writeFile(temporary,text,'utf8');temporaryWritten=true;
      phase='rename';
      try{await renameWithSharingRetry(temporary,file,{rename,sleep,onFailure:(attempt,error)=>{attempts.push(attempt);lastRenameError=error;}});}
      catch(cause){throw Object.assign(new Error(`文件无法原子替换（${cause.code||'未知错误'}），原文件未覆盖；本轮数据保存在 ${temporary}`),{code:'OUTPUT_LOCKED',stopChannel:true,cause});}
      committed=true;
      if(lastRenameError)attempts.push({attempt:attempts.length+1,at:new Date().toISOString(),code:null,delayMs:0,success:true});
      phase='mirror_backup';
      try{await mirror(context,Buffer.from(text,'utf8'));}
      catch(cause){throw Object.assign(new Error(`断点已写入，但独立备份失败，已停止采集以免无保护运行：${cause.message}`),{code:'OUTPUT_LOCKED',stopChannel:true,cause});}
    }catch(error){
      const diagnostic=await log(error,'failed');
      error.storageDiagnostic=diagnostic;
      if(diagnostic.path)error.message+=`；诊断日志：${diagnostic.path}`;
      throw error;
    }
    if(lastRenameError){phase='rename';await log(lastRenameError,'recovered');}
  });
  queues.set(key,task);
  const clear=()=>{if(queues.get(key)===task)queues.delete(key);};task.then(clear,clear);
  return task;
};
}
export const writeAtomic=createAtomicWriter();
export function writeJsonAtomic(file,value){return writeAtomic(file,JSON.stringify(value,null,2));}
