import fs from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {validJobRecord} from './task_collection_target.mjs';
import {channelKey} from './collector_channel_heartbeat.mjs';

// Jobs only. Interview articles live in a separate store and never enter here.
// Cache by database + WAL revisions, never by the historical task status/count.
const cache=new Map();
async function revision(file){
  const stat=await fs.stat(file).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(!stat)return null;
  const wal=await fs.stat(file+'-wal').catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  return `${stat.size}:${stat.mtimeMs}:${wal?.size||0}:${wal?.mtimeMs||0}`;
}
export async function taskJobStatistics(outputDir,taskId){
  const file=path.join(outputDir,'统一采集数据.sqlite'),stamp=await revision(file);
  if(stamp===null)return null;
  const key=file+'\0'+taskId,previous=cache.get(key);
  if(previous?.revision===stamp)return previous.value;
  const db=new DatabaseSync(file,{readOnly:true});
  let value;
  try{
    db.exec('PRAGMA busy_timeout=5000');
    if(db.prepare('SELECT task_id FROM metadata').get()?.task_id!==taskId)throw Error('岗位统计数据库归属不一致');
    // One read statement gives all totals and channel buckets the same snapshot.
    const rows=db.prepare(`SELECT platform,job_id,
      json_extract(data,'$.job_name') AS job_name,json_extract(data,'$.company_name') AS company_name,
      json_extract(data,'$.city') AS city,json_extract(data,'$.job_url') AS job_url,
      json_extract(data,'$.job_description') AS job_description FROM jobs`).all();
    const buckets=new Map();let complete=0;
    for(const row of rows){
      const channel=channelKey(row.platform)||row.platform||'unknown';
      const bucket=buckets.get(channel)||{key:channel,rows:0,completeRows:0,incompleteRows:0};
      bucket.rows++;
      if(validJobRecord(row)){complete++;bucket.completeRows++;}else bucket.incompleteRows++;
      buckets.set(channel,bucket);
    }
    value={scope:'jobs',source:'sqlite',rows:rows.length,completeRows:complete,incompleteRows:rows.length-complete,
      channels:[...buckets.values()],updatedAt:new Date().toISOString(),definition:'按平台岗位ID去重；资料完整仅表示字段达标，不代表岗位相关或匹配'};
  }finally{db.close();}
  if(await revision(file)===stamp){
    cache.set(key,{revision:stamp,value});
    if(cache.size>64)cache.delete(cache.keys().next().value);
  }
  return value;
}
