import fs from 'node:fs/promises';
import path from 'node:path';
import {writeJsonAtomic} from './collector_storage.mjs';
export const ownedReport=(report,task)=>Boolean(report && report.task_id===task.id);
export function isolatedDirectory(base,id) {
  if(!id || /[\\/]|^\.{1,2}$/.test(id))throw new Error('无效任务 ID');
  return path.join(path.resolve(base),'任务数据',id);
}
export async function assertTaskOutputOwnership(task){
  const marker=path.join(task.outputDir,'任务归属.json');
  let owner;
  try{owner=JSON.parse(await fs.readFile(marker,'utf8'));}
  catch(error){
    if(error.code==='ENOENT')throw new Error(`任务输出目录或归属标记缺失，已阻止启动以避免断点丢失或写入错误目录：${task.outputDir}。请先恢复原任务目录/备份。`);
    throw new Error(`无法读取任务归属标记 ${marker}：${error.message}`);
  }
  if(owner.task_id!==task.id)throw new Error(`任务输出目录归属不匹配（预期 ${task.id}，实际 ${owner.task_id||'未知'}），已阻止启动`);
}
export async function isolateLegacyTask(task) {
  if(task.datasetScopeVersion===2)return false;
  const previous=task.outputDir,directory=isolatedDirectory(previous,task.id);
  await fs.mkdir(directory,{recursive:true});
  // This is explicit legacy-task initialization, not missing-marker recovery.
  // Establish ownership before any guarded profile write into the new root.
  const existing=await fs.readFile(path.join(directory,'任务归属.json'),'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(existing&&existing.task_id!==task.id)throw new Error('迁移目标目录归属不匹配');
  if(!existing)await writeJsonAtomic(path.join(directory,'任务归属.json'),{task_id:task.id,label:task.label,legacy_output_dir:previous});
  for(const key of ['publicConfigPath','zhaopinConfigPath','yupaoConfigPath','bossConfigPath','profilePath']){
    if(!task[key])continue;
    const config=JSON.parse(await fs.readFile(task[key],'utf8'));
    config.task_id=task.id;
    if(key==='profilePath'){
      config.collection_relevance_filter=false;
      config.legacy_source_directories=config.source_directories||[];
      config.source_directories=[];
    }
    await writeJsonAtomic(task[key],config);
    if(key==='profilePath')await writeJsonAtomic(path.join(directory,'岗位配置.json'),config);
  }
  Object.assign(task,{legacyOutputDir:previous,legacyMessage:task.message,outputBaseDir:previous,outputDir:directory,datasetScopeVersion:2,message:'已启用独立任务目录；历史文件保留在原目录，尚未导入'});
  return true;
}
