import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {writeAtomic,writeJsonAtomic} from './collector_storage.mjs';

export const latestManifestName='最新数据清单.json';
export const latestCsvName='最新数据.csv';
export const latestWorkbookName='最新数据.xlsx';
export async function publishLatestCsv(task,report){
  if(report.task_id!==task.id)throw new Error('最新数据任务归属不一致');
  const owner=JSON.parse(await fs.readFile(path.join(task.outputDir,'任务归属.json'),'utf8'));
  if(owner.task_id!==task.id)throw new Error('最新数据目录任务归属不一致');
  const content=await fs.readFile(path.join(task.outputDir,'统一采集数据.csv'),'utf8');
  const hash=createHash('sha256').update(content).digest('hex');
  const manifestPath=path.join(task.outputDir,latestManifestName);
  let old;
  try{old=JSON.parse(await fs.readFile(manifestPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(old&&old.task_id!==task.id)throw new Error('最新数据清单属于其他任务');
  if(old?.hash===hash){
    const saved=await fs.readFile(path.join(task.outputDir,latestCsvName)).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    if(saved&&createHash('sha256').update(saved).digest('hex')===hash)return old;
  }
  await writeAtomic(path.join(task.outputDir,latestCsvName),content);
  const manifest={...old,task_id:task.id,label:task.label,csv:latestCsvName,rows:report.rows,hash,updatedAt:new Date().toISOString(),scope:'候选快照：按平台岗位ID去重，岗位相关性由洞察再次筛选',complete:false};
  await writeJsonAtomic(manifestPath,manifest);
  return manifest;
}
export async function latestDatasetSource(task){
  const directory=path.resolve(task.outputDir);
  let manifest;
  try{manifest=JSON.parse(await fs.readFile(path.join(directory,latestManifestName),'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}
  const owner=JSON.parse(await fs.readFile(path.join(directory,'任务归属.json'),'utf8'));
  if(owner.task_id!==task.id||manifest.task_id!==task.id||manifest.label!==task.label)throw new Error('最新数据任务归属不一致');
  if(manifest.csv!==latestCsvName)throw new Error('最新数据文件路径无效');
  const file=path.join(directory,latestCsvName),content=await fs.readFile(file);
  if(createHash('sha256').update(content).digest('hex')!==manifest.hash)throw new Error('最新数据正在更新，请稍后重试');
  if(!Number.isInteger(manifest.rows)||manifest.rows<1)return null;
  return {taskId:task.id,role:task.label,dataset:{path:file,taskId:task.id,name:`${task.label} · 最新候选数据`,size:content.length,format:'csv',expectedRows:manifest.rows,resolution:'latest_snapshot',updatedAt:manifest.updatedAt,collecting:task.status==='running',complete:false,scope:manifest.scope}};
}
