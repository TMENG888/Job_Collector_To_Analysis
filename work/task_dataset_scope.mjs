import fs from 'node:fs/promises';
import path from 'node:path';
import {writeJsonAtomic} from './collector_storage.mjs';
export const ownedReport=(report,task)=>Boolean(report && report.task_id===task.id);
export function isolatedDirectory(base,id) {
  if(!id || /[\\/]|^\.{1,2}$/.test(id))throw new Error('无效任务 ID');
  return path.join(path.resolve(base),'任务数据',id);
}
export async function isolateLegacyTask(task) {
  if(task.datasetScopeVersion===2)return false;
  const previous=task.outputDir,directory=isolatedDirectory(previous,task.id);
  await fs.mkdir(directory,{recursive:true});
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
  await writeJsonAtomic(path.join(directory,'任务归属.json'),{task_id:task.id,label:task.label,legacy_output_dir:previous});
  Object.assign(task,{legacyOutputDir:previous,legacyMessage:task.message,outputBaseDir:previous,outputDir:directory,datasetScopeVersion:2,message:'已启用独立任务目录；历史文件保留在原目录，尚未导入'});
  return true;
}
