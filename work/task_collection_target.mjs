import fs from 'node:fs/promises';
import path from 'node:path';
import {parseChannelCsv} from './public_channel_csv.mjs';
import {readNativeTaskRows,nativeChannelNames} from './collector_native_sink.mjs';
export const channelKeys=['shixiseng','iguopin','mohrss','job51','jobonline','zhaopin','liepin','yupao','boss'];
export function validJobRecord(row) {
  if(!['platform','job_id','job_name','company_name','city','job_url','job_description'].every(key=>String(row[key]||'').trim()))return false;
  const description=String(row.job_description).trim();
  if(description.length<20||/^\s*(?:<!doctype|<html|<textarea)/i.test(description)||/aliyun_waf|请按住滑块|拖动到最右边|Protected by Tencent Cloud EdgeOne/i.test(description))return false;
  if(/\s/.test(row.job_url))return false;
  try{const url=new URL(row.job_url);return ['http:','https:'].includes(url.protocol)&&Boolean(url.hostname)&&!url.username&&!url.password;}catch{return false;}
}
export async function otherChannelValidCount(outputDir,excludedKey,taskId) {
  const owner=JSON.parse(await fs.readFile(path.join(outputDir,'任务归属.json'),'utf8'));
  if(owner.task_id!==taskId)throw Error('任务输出目录归属不符，拒绝累计历史数据');
  const known=new Set();
  for(const row of await readNativeTaskRows(outputDir,taskId))if(!(nativeChannelNames[excludedKey]||[]).includes(row.platform)&&validJobRecord(row))known.add(`${row.platform}:${row.job_id}`);
  for(const key of channelKeys.filter(key=>key!==excludedKey)) {
    let rows;
    try{rows=parseChannelCsv(await fs.readFile(path.join(outputDir,`${key}_标准化数据.csv`),'utf8'));}catch(error){if(error.code==='ENOENT')continue;throw error;}
    for(const row of rows) {
      if(row.task_id&&row.task_id!==taskId)throw Error('渠道记录 task_id 不一致，拒绝累计');
      if(validJobRecord(row))known.add(`${row.platform}:${row.job_id}`);
    }
  }
  if(!excludedKey) {
    const state=await fs.readFile(path.join(outputDir,'统一采集数据状态.json'),'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    if(state) {
      if(state.task_id!==taskId)throw Error('统一数据集 task_id 不一致');
      const rows=await readNativeTaskRows(outputDir,taskId);
      for(const row of rows) {
        if(row.task_id!==taskId)throw Error('统一记录 task_id 不一致');
        if(validJobRecord(row))known.add(`${row.platform}:${row.job_id}`);
      }
    }
  }
  return known.size;
}
