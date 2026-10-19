import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';

export const defaultTaskBackupRoot=()=>path.resolve(process.env.JOB_TASK_BACKUP_ROOT||path.join(os.homedir(),'.job-collector','task-backups'));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const samePath=(a,b)=>process.platform==='win32'?path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase():path.resolve(a)===path.resolve(b);
const within=(base,file)=>{const relative=path.relative(path.resolve(base),path.resolve(file));return relative!==''&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);};
const fail=message=>Object.assign(new Error(message),{code:'OUTPUT_LOCKED',stopChannel:true});
async function atomic(file,bytes){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.tmp-${process.pid}-${randomUUID()}`;await fs.writeFile(tmp,bytes);await fs.rename(tmp,file);}
async function json(file){return JSON.parse(await fs.readFile(file,'utf8'));}
function safeId(id){if(!id||/[\\/:]|^\.{1,2}$/.test(id))throw fail('无效备份任务 ID');return id;}
function backupDirectory(task,root){const directory=path.join(path.resolve(root),safeId(task.id));if(samePath(directory,task.outputDir)||within(task.outputDir,directory)||within(directory,task.outputDir))throw fail('备份必须位于原任务目录之外，且不能互相包含');return directory;}
function critical(relative){return relative==='任务归属.json'||relative==='岗位配置.json'||relative==='统一采集数据.sqlite'||/^(断点数据|原始数据)[\\/].*\.json$/.test(relative)&&!relative.endsWith('.diagnostic.json');}
async function noLinks(base,file){let current=file;while(true){const stat=await fs.lstat(current).catch(error=>{if(error.code==='ENOENT')return null;throw error;});if(stat?.isSymbolicLink())throw fail('恢复/备份不接受符号链接或目录联接');if(path.resolve(current)===path.resolve(base))break;const parent=path.dirname(current);if(parent===current)throw fail('路径越界');current=parent;}}

async function acquireLock(lockPath){
  await fs.mkdir(path.dirname(lockPath),{recursive:true});let lock;
  for(let attempt=0;attempt<40;attempt++){
    try{lock=await fs.open(lockPath,'wx');await lock.writeFile(String(process.pid));break;}catch(error){
      if(error.code!=='EEXIST')throw error;
      const pid=Number(await fs.readFile(lockPath,'utf8').catch(()=>''));
      if(pid>0){try{process.kill(pid,0);}catch(probe){if(probe.code==='ESRCH'){await fs.unlink(lockPath).catch(()=>{});continue;}}}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
  }
  if(!lock)throw fail('独立备份文件繁忙，请稍后重试');
  return async()=>{await lock.close();await fs.unlink(lockPath).catch(()=>{});};
}
async function putVersion(directory,relative,bytes){
  const target=path.join(directory,'files',relative);if(!within(path.join(directory,'files'),target))throw fail('备份路径越界');
  await noLinks(directory,target);
  const release=await acquireLock(`${target}.lock`);
  try{
  const hash=digest(bytes),descriptor=`${target}.sha256`;
  const existing=await fs.readFile(target).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(existing&&digest(existing)===hash){const current=await json(descriptor).catch(()=>null);if(current?.sha256!==hash||current.bytes!==bytes.length)await atomic(descriptor,JSON.stringify({sha256:hash,bytes:bytes.length,updatedAt:new Date().toISOString()}));return;}
  if(existing){const old=await json(descriptor).catch(()=>null);if(old?.sha256===digest(existing)){await atomic(`${target}.previous`,existing);await atomic(`${descriptor}.previous`,JSON.stringify(old));}}
  await atomic(target,bytes);await atomic(descriptor,JSON.stringify({sha256:hash,bytes:bytes.length,updatedAt:new Date().toISOString()}));
  }finally{await release();}
}

// Only registered task roots are mirrored. A missing marker must never be repaired
// by a regular writer; restoration is a separate, explicit operation.
export async function taskWriteContext(file){
  let directory=process.env.JOB_TASK_OUTPUT_DIR&&within(process.env.JOB_TASK_OUTPUT_DIR,file)?path.resolve(process.env.JOB_TASK_OUTPUT_DIR):null;
  if(!directory){for(let current=path.dirname(path.resolve(file));path.dirname(current)!==current;current=path.dirname(current)){if(path.basename(path.dirname(current))==='任务数据'){directory=current;break;}}}
  if(!directory||path.basename(file)==='任务归属.json'&&path.dirname(path.resolve(file))===directory)return null;
  await noLinks(directory,file);
  let owner;try{owner=await json(path.join(directory,'任务归属.json'));}catch{throw fail(`任务目录/归属标记已丢失，已停止写入，禁止自动创建空目录：${directory}。请从独立备份恢复。`);}
  if(owner.task_id!==path.basename(directory)&&!process.env.JOB_TASK_OUTPUT_DIR)throw fail('任务目录与归属标记不匹配');
  if(process.env.JOB_COLLECTOR_TASK_ID&&owner.task_id!==process.env.JOB_COLLECTOR_TASK_ID)throw fail('当前采集进程与任务目录归属不匹配');
  const root=process.env.JOB_TASK_BACKUP_ROOT||owner.backup_root;
  return {task:{id:owner.task_id,outputDir:directory},root,relative:path.relative(directory,path.resolve(file))};
}

export async function mirrorTaskWrite(context,bytes){
  if(!context?.root||!critical(context.relative))return;
  const directory=backupDirectory(context.task,context.root),registration=await json(path.join(directory,'注册.json'));
  if(registration.task_id!==context.task.id||!samePath(registration.output_dir,context.task.outputDir))throw fail('备份注册信息与任务目录不一致');
  await putVersion(directory,context.relative,bytes);
}

export async function backupTaskDatabase(task,{root=defaultTaskBackupRoot()}={}){
  const file=path.join(task.outputDir,'统一采集数据.sqlite');if(!await fs.stat(file).catch(()=>null))return;
  const {DatabaseSync,backup}=await import('node:sqlite');
  const directory=backupDirectory(task,root),temporary=path.join(directory,`sqlite-${randomUUID()}.tmp`);
  await noLinks(root,directory);await noLinks(task.outputDir,file);
  const registration=await json(path.join(directory,'注册.json'));
  if(registration.task_id!==task.id||!samePath(registration.output_dir,task.outputDir))throw fail('备份注册信息与数据库任务不一致');
  const release=await acquireLock(path.join(directory,'sqlite-snapshot.lock'));let db;
  try{
    db=new DatabaseSync(file,{readOnly:true});
    if(db.prepare('SELECT task_id FROM metadata').get()?.task_id!==task.id)throw fail('数据库归属不符，拒绝备份');
    if(typeof backup!=='function')throw fail('SQLite 安全备份需要支持 node:sqlite backup 的 Node.js 版本');
    await backup(db,temporary);await putVersion(directory,'统一采集数据.sqlite',await fs.readFile(temporary));
  }finally{db?.close();await fs.unlink(temporary).catch(()=>{});await release();}
}

export async function snapshotTaskOutput(task,{root=defaultTaskBackupRoot()}={}){
  await noLinks(task.outputDir,task.outputDir);
  const owner=await json(path.join(task.outputDir,'任务归属.json'));if(owner.task_id!==task.id)throw fail('任务归属不符，拒绝备份');
  const directory=backupDirectory(task,root);await noLinks(root,directory);
  const registered=await json(path.join(directory,'注册.json')).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(registered&&(registered.task_id!==task.id||!samePath(registered.output_dir,task.outputDir)))throw fail('备份槽已绑定其他任务或目录');
  await atomic(path.join(directory,'注册.json'),JSON.stringify({task_id:task.id,label:task.label,output_dir:path.resolve(task.outputDir),updatedAt:new Date().toISOString()}));
  let count=0;
  async function walk(base){for(const entry of await fs.readdir(base,{withFileTypes:true})){if(entry.isSymbolicLink())throw fail('任务目录含链接，拒绝跟随');const file=path.join(base,entry.name),relative=path.relative(task.outputDir,file);if(entry.isDirectory()&&['断点数据','原始数据'].includes(relative))await walk(file);else if(entry.isDirectory()&&relative.startsWith('断点数据'+path.sep))await walk(file);else if(entry.isFile()&&critical(relative)&&relative!=='统一采集数据.sqlite'){await putVersion(directory,relative,await fs.readFile(file));count++;}}}
  await walk(task.outputDir);await backupTaskDatabase(task,{root});
  return {task_id:task.id,directory,files:count,updatedAt:new Date().toISOString()};
}

export async function inspectTaskBackup(task,{root=defaultTaskBackupRoot()}={}){
  const directory=backupDirectory(task,root);await noLinks(root,directory);const registration=await json(path.join(directory,'注册.json'));
  if(registration.task_id!==task.id||!samePath(registration.output_dir,task.outputDir))throw fail('备份任务归属/原路径不匹配');
  const files=[];
  async function walk(base){for(const entry of await fs.readdir(base,{withFileTypes:true})){if(entry.isSymbolicLink())throw fail('备份含链接，拒绝恢复');const file=path.join(base,entry.name);if(entry.isDirectory())await walk(file);else{const relative=path.relative(path.join(directory,'files'),file);if(relative.endsWith('.sha256')&&critical(relative.slice(0,-7))&&!await fs.stat(file.slice(0,-7)).catch(()=>null))throw fail(`备份校验失败：缺少 ${relative.slice(0,-7)}`);if(!critical(relative))continue;const bytes=await fs.readFile(file),description=await json(`${file}.sha256`).catch(()=>null);if(!description||digest(bytes)!==description.sha256||bytes.length!==description.bytes)throw fail(`备份校验失败：${relative}`);files.push({relative,sha256:description.sha256,bytes:bytes.length});}}}
  await walk(path.join(directory,'files'));
  const marker=files.find(file=>file.relative==='任务归属.json');if(!marker|| (await json(path.join(directory,'files','任务归属.json'))).task_id!==task.id)throw fail('备份缺少有效任务归属');
  return {task_id:task.id,directory,files};
}

export async function restoreTaskBackup(task,options={}){
  const report=await inspectTaskBackup(task,options),plan=[];
  // Validate every destination before writing anything. Never overwrite a newer
  // checkpoint, and never recursively remove or replace a task directory.
  for(const entry of report.files){const target=path.join(task.outputDir,entry.relative);await noLinks(task.outputDir,target);const existing=await fs.readFile(target).catch(error=>{if(error.code==='ENOENT')return null;throw error;});if(existing&&digest(existing)!==entry.sha256)throw fail(`原文件与备份不同，拒绝覆盖：${entry.relative}`);if(!existing){if(entry.relative==='统一采集数据.sqlite'){for(const suffix of ['-wal','-shm','-journal'])if(await fs.lstat(target+suffix).catch(()=>null))throw fail('存在残留 SQLite 日志，拒绝直接恢复数据库');}plan.push(entry);}}
  plan.sort((a,b)=>Number(a.relative==='任务归属.json')-Number(b.relative==='任务归属.json'));
  for(const entry of plan){const target=path.join(task.outputDir,entry.relative),bytes=await fs.readFile(path.join(report.directory,'files',entry.relative));if(digest(bytes)!==entry.sha256)throw fail('恢复期间备份发生变化');await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes,{flag:'wx'});}
  return {task_id:task.id,restored:plan.length,directory:task.outputDir};
}
