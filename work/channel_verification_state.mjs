import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {writeJsonAtomic} from './collector_storage.mjs';
import {assertTaskOutputOwnership} from './task_dataset_scope.mjs';
import {nativeTaskCounts} from './collector_native_sink.mjs';
const queues=new Map();
const fileFor=task=>path.join(task.outputDir,'渠道核验状态.json');
const read=async file=>fs.readFile(file,'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
export async function ensureChannelManifest(task,platform){
  const file=path.join(task.outputDir,'采集清单.json'),previous=queues.get(file)||Promise.resolve();
  const operation=previous.catch(()=>{}).then(async()=>{
    const fail=message=>Object.assign(Error(message),{status:400});
    if(!['job51','liepin','zhaopin','jobonline'].includes(platform)||!task.platforms?.includes(platform))throw fail('该渠道未在当前任务中启用');
    await assertTaskOutputOwnership(task);
    const config=await read(task.publicConfigPath);
    if(config?.task_id!==task.id)throw fail('渠道配置归属不匹配');
    if(config.platforms?.[platform]?.enabled!==true)throw fail('该渠道未在当前任务中启用');
    let manifest=await fs.readFile(file,'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;}),changed=false;
    if(manifest===undefined){manifest={task_id:task.id,created_at:new Date().toISOString(),platforms:{}};changed=true;}
    if(!manifest||typeof manifest!=='object'||Array.isArray(manifest))throw fail('采集清单结构无效，请检查原文件');
    if(manifest.task_id!==task.id)throw fail('采集清单归属不匹配');
    if(manifest.platforms===undefined){manifest.platforms={};changed=true;}
    if(!manifest.platforms||typeof manifest.platforms!=='object'||Array.isArray(manifest.platforms))throw fail('渠道清单结构无效，请检查原文件');
    if(manifest.platforms[platform]===undefined){manifest.platforms[platform]={errors:[]};changed=true;}
    const channel=manifest.platforms[platform];
    if(!channel||typeof channel!=='object'||Array.isArray(channel)||channel.errors!==undefined&&!Array.isArray(channel.errors))throw fail('渠道清单结构无效，请检查原文件');
    if(changed)await writeJsonAtomic(file,manifest);
    return manifest;
  });
  queues.set(file,operation);const clear=()=>{if(queues.get(file)===operation)queues.delete(file);};operation.then(clear,clear);
  return operation;
}
const fingerprint=(manifest,platform)=>createHash('sha256').update(JSON.stringify((manifest.platforms?.[platform]?.errors||[]).filter(error=>!error.resolved_at))).digest('hex');
async function evidence(task){
  await assertTaskOutputOwnership(task);
  const manifest=await read(path.join(task.outputDir,'采集清单.json'));
  if(manifest?.task_id!==task.id)throw Error('渠道核验清单归属不一致');
  return {manifest,records:(await nativeTaskCounts(task.outputDir,task.id)).channelHeartbeats};
}
export async function saveChannelVerification(task,platform,patch){
  const file=fileFor(task),previous=queues.get(file)||Promise.resolve();
  const operation=previous.catch(()=>{}).then(async()=>{
    const {manifest,records}=await evidence(task),state=await read(file)||{version:1,task_id:task.id,channels:{}};
    if(state.task_id!==task.id)throw Error('渠道核验记录归属不一致');
    const updatedAt=new Date().toISOString();
    const lastCheckAt=patch.lastCheckAt||state.channels[platform]?.lastCheckAt;
    const entry={...patch,...(lastCheckAt?{lastCheckAt}:{}),platform,updatedAt,errorFingerprint:fingerprint(manifest,platform),activityRunId:records?.[platform]?.activity?.run_id||null};
    state.channels[platform]=entry;await writeJsonAtomic(file,state);return entry;
  });
  queues.set(file,operation);const clear=()=>{if(queues.get(file)===operation)queues.delete(file);};operation.then(clear,clear);
  return operation;
}
export async function readChannelVerification(task){
  const state=await read(fileFor(task));if(!state)return {};
  if(state.task_id!==task.id)throw Error('渠道核验记录归属不一致');
  const {manifest,records}=await evidence(task),result={};
  for(const [platform,entry]of Object.entries(state.channels||{})){
    if(entry.errorFingerprint!==fingerprint(manifest,platform)||entry.activityRunId!==(records?.[platform]?.activity?.run_id||null))continue;
    // A terminated service cannot still be carrying out an in-memory check.
    result[platform]=entry.state==='checking'?{...entry,state:'manual_checked',reason:'上次检查已中断，请打开处理窗口核对后点击“已处理”'}:entry;
  }
  return result;
}
export function verificationDiagnostic(diagnostic,entry){
  if(!entry)return diagnostic;
  if(entry.state==='manual_checked')return {status:'paused',label:'已处理，待采集验证',reason:entry.reason||'已记录人工处理；继续采集时检查会话，遇到登录或验证要求仍会暂停',code:'manual_checked'};
  if(entry.state==='checking')return {status:'paused',label:'正在复检',reason:'仅检查当前渠道，不启动采集；遇到验证即停',code:'verification_checking'};
  if(entry.state==='recheck_failed')return {status:entry.failureStatus||'manual',label:'复检未通过',reason:entry.reason,code:entry.failureCode||'verification_required'};
  if(entry.state==='verified'&&!['manual','failed'].includes(diagnostic?.status))return {status:'paused',label:'复检通过，待续采',reason:'已观察到采集会话的有效搜索响应；未自动启动采集，冷却期保持不变',code:'verification_verified'};
  return diagnostic;
}
