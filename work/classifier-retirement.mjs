import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {writeJsonAtomic} from './collector_storage.mjs';

const cache=new Map(),root=path.resolve(import.meta.dirname,'..');
export function classifierStorageDirectory(dataDir=process.env.JOB_UI_DATA_DIR||path.join(root,'ui_data')){
  if(process.env.JOB_INSIGHT_CLASSIFIER_DIR)return process.env.JOB_INSIGHT_CLASSIFIER_DIR;
  const canonical=value=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value);
  return canonical(dataDir)===canonical(path.join(root,'ui_data'))?'E:/Codex/work/20261018-insight-qwen-classifier/runtime':path.join(dataDir,'insight_classification');
}
export function classifierRetirements(directory=classifierStorageDirectory()){
  const filename=path.join(directory,'retired.json'),saved=cache.get(filename);
  if(saved&&Date.now()-saved.at<1000)return saved.value;
  let value;
  try{value=JSON.parse(fs.readFileSync(filename,'utf8'));}catch(error){if(error.code!=='ENOENT')throw Error('分类器删除记录无法读取，已停止加载模型');value={version:1,roles:{}};}
  if(value.version!==1||!value.roles||typeof value.roles!=='object'||Array.isArray(value.roles))throw Error('分类器删除记录格式错误');
  if(Object.values(value.roles).some(record=>!record||!Number.isFinite(Date.parse(record.deletedAt))))throw Error('分类器删除时间无效，已停止加载模型');
  cache.set(filename,{at:Date.now(),value});return value;
}
export function isClassifierRetired(role,createdAt=null,directory){
  const roles=classifierRetirements(directory).roles,retired=Object.hasOwn(roles,role)?roles[role]:null;
  return !!retired&&(!createdAt||(Date.parse(createdAt)||0)<=Date.parse(retired.deletedAt));
}
export async function retireClassifier(role,directory,now=new Date().toISOString()){
  if(typeof role!=='string'||role.trim()!==role||role.length<2||role.length>80||/[\r\n<>]/.test(role))throw Error('无效岗位名称');
  const value=structuredClone(classifierRetirements(directory));
  value.roles={...value.roles,[role]:{deletedAt:now}};
  await fs.promises.mkdir(directory,{recursive:true});
  await writeJsonAtomic(path.join(directory,'retired.json'),value);
  cache.delete(path.join(directory,'retired.json'));return value.roles[role];
}
export const classifierRetirementKey=()=>createHash('sha256').update(JSON.stringify(classifierRetirements())).digest('hex').slice(0,20);
