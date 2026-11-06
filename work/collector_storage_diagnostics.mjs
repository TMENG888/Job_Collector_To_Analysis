import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const clean=value=>String(value??'').replace(/((?:authorization|cookie|api[_-]?key|access[_-]?token)\s*[:=]\s*)[^\r\n]+/gi,'$1[REDACTED]').slice(0,12000);
function errorInfo(error,seen=new Set()){
  if(!error||seen.has(error)||seen.size>=5)return null;
  seen.add(error);
  return Object.fromEntries([...['name','message','code','errno','syscall','path','dest','stack'].filter(key=>error[key]!=null).map(key=>[key,typeof error[key]==='number'?error[key]:clean(error[key])]),...(error.cause?[['cause',errorInfo(error.cause,seen)]]:[])]);
}
async function fileInfo(file){
  if(!file)return null;
  try{const stat=await fs.stat(file);return {exists:true,bytes:stat.size,modifiedAt:stat.mtime.toISOString(),mode:stat.mode};}
  catch(error){return {exists:error.code==='ENOENT'?false:null,errorCode:error.code||'unknown'};}
}
export async function recordStorageDiagnostic(event,{root='E:/Codex/outputs/collector-storage-logs',emit=line=>console.error(line)}={}){
  const id=randomUUID(),at=new Date().toISOString();
  const taskId=event.context?.task?.id||process.env.JOB_COLLECTOR_TASK_ID||null;
  const taskKey=String(taskId||'unscoped').replace(/[^\p{L}\p{N}_.-]/gu,'_').slice(0,120);
  const directory=path.join(root,taskKey,at.slice(0,10));
  const diagnosticPath=path.join(directory,`${at.replace(/[:.]/g,'-')}-${id}.json`);
  const channel=/^(shixiseng|iguopin|jobonline|liepin|mohrss|zhaopin|job51)_/.exec(path.basename(event.file))?.[1]||null;
  const record={schema:'collector-storage-diagnostic-v1',id,at,taskId,channel,writerPid:process.pid,lockOwner:'unknown',phase:event.phase,outcome:event.outcome,committed:event.committed,temporaryWritten:event.temporaryWritten,file:path.resolve(event.file),temporary:path.resolve(event.temporary),intendedBytes:event.intendedBytes,elapsedMs:event.elapsedMs,attempts:event.attempts,backupRoot:event.context?.root||null,error:errorInfo(event.error)};
  let loggingError=null;
  try{
    [record.destinationState,record.temporaryState]=await Promise.all([fileInfo(event.file),fileInfo(event.temporary)]);
    await fs.mkdir(directory,{recursive:true});
    await fs.writeFile(diagnosticPath,JSON.stringify(record,null,2),'utf8');
  }catch(error){loggingError={code:error.code||'unknown',message:clean(error.message)};}
  const result={id,path:loggingError?null:diagnosticPath,...(loggingError?{loggingError}:{})};
  try{emit(`[存储诊断] ${event.outcome==='recovered'?'重试后恢复':'保存失败'} · 阶段 ${event.phase} · 系统码 ${event.error?.cause?.code||event.error?.code||'unknown'} · 替换尝试 ${event.attempts.length} 次 · 正式文件${event.committed?'已提交':'未提交'} · 文件 ${event.file} · 诊断 ${id} · ${loggingError?`独立日志写入失败 ${loggingError.code}`:diagnosticPath}`);}catch{}
  return result;
}
