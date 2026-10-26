import fs from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {backupTaskDatabase,taskWriteContext} from './task_output_backup.mjs';
import {nativeChannelNames,ensureChannelHeartbeatSchema,recordChannelIngestion,readChannelHeartbeatRecords,meaningfulIngestionChange} from './collector_channel_heartbeat.mjs';
export {nativeChannelNames};
export async function writeNativeChannelRows(outputDir,taskId,rows,{now=()=>new Date().toISOString()}={}){
  if(!taskId)throw new Error('原生采集入库缺少任务ID');
  await taskWriteContext(path.join(outputDir,'统一采集数据.sqlite'));
  const owner=JSON.parse(await fs.readFile(path.join(outputDir,'任务归属.json'),'utf8'));if(owner.task_id!==taskId)throw new Error('原生采集输出目录归属不一致');
  const db=new DatabaseSync(path.join(outputDir,'统一采集数据.sqlite'));
  try{
    db.exec('PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS jobs(platform TEXT,job_id TEXT,data TEXT NOT NULL,PRIMARY KEY(platform,job_id)); CREATE TABLE IF NOT EXISTS sources(file TEXT PRIMARY KEY,signature TEXT); CREATE TABLE IF NOT EXISTS metadata(task_id TEXT PRIMARY KEY);');
    const id=db.prepare('SELECT task_id FROM metadata').get();if(id&&id.task_id!==taskId)throw new Error('原生采集数据库归属不一致');
    db.prepare('INSERT OR IGNORE INTO metadata VALUES(?)').run(taskId);ensureChannelHeartbeatSchema(db);const changes=new Map(),get=db.prepare('SELECT data FROM jobs WHERE platform=? AND job_id=?'),put=db.prepare('INSERT INTO jobs VALUES(?,?,?) ON CONFLICT(platform,job_id) DO UPDATE SET data=excluded.data');
    db.exec('BEGIN IMMEDIATE');
    try{for(const raw of rows){if(raw.task_id&&raw.task_id!==taskId)throw new Error('原生采集记录task_id不一致');if(!raw.platform||!raw.job_id)continue;
      const old=get.get(String(raw.platform),String(raw.job_id)),previous=old?JSON.parse(old.data):{},merged={...previous};
      for(const [key,value]of Object.entries(raw))if(value!=null&&String(value).trim())merged[key]=value;
      if(String(previous.job_description||'').length>String(raw.job_description||'').length)merged.job_description=previous.job_description;
      merged.task_id=taskId;merged.query_keywords=[...new Set([...(previous.query_keywords||[]),previous.query_keyword,raw.query_keyword].filter(Boolean))];
      const encoded=JSON.stringify(merged);if(old?.data===encoded)continue;
      put.run(String(raw.platform),String(raw.job_id),encoded);
      if(old&&!meaningfulIngestionChange(previous,merged))continue;
      const change=changes.get(String(raw.platform))||{inserted:0,updated:0};change[old?'updated':'inserted']++;changes.set(String(raw.platform),change);
    }recordChannelIngestion(db,changes,now());db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
  }finally{db.close();}
  const backupRoot=process.env.JOB_TASK_BACKUP_ROOT||owner.backup_root;
  if(backupRoot){try{await backupTaskDatabase({id:taskId,outputDir},{root:backupRoot});}catch(cause){throw Object.assign(new Error(`数据库已提交，但独立备份失败，已停止采集以免无保护运行：${cause.message}`),{code:'OUTPUT_LOCKED',stopChannel:true,cause});}}
}
export async function readNativeTaskRows(outputDir,taskId,channel=''){
  const file=path.join(outputDir,'统一采集数据.sqlite');if(!await fs.stat(file).catch(()=>null))return [];
  const db=new DatabaseSync(file,{readOnly:true});try{db.exec('PRAGMA busy_timeout=5000');if(db.prepare('SELECT task_id FROM metadata').get()?.task_id!==taskId)throw new Error('任务数据库归属不一致');
    const names=nativeChannelNames[channel]||[];return db.prepare(`SELECT data FROM jobs${channel?` WHERE platform IN (${names.map(()=>'?').join(',')||"''"})`:''}`).all(...names).map(r=>JSON.parse(r.data));
  }finally{db.close();}
}
export async function nativeTaskCounts(outputDir,taskId){
  const file=path.join(outputDir,'统一采集数据.sqlite');if(!await fs.stat(file).catch(()=>null))return {rows:0,platformCounts:{},channelHeartbeats:{}};
  const db=new DatabaseSync(file,{readOnly:true});try{db.exec('PRAGMA busy_timeout=5000');if(db.prepare('SELECT task_id FROM metadata').get()?.task_id!==taskId)throw new Error('任务数据库归属不一致');
    const counts=db.prepare('SELECT platform,COUNT(*) AS n FROM jobs GROUP BY platform').all(),platformCounts={};for(const [key,names]of Object.entries(nativeChannelNames))platformCounts[key]=counts.filter(c=>names.includes(c.platform)).reduce((n,c)=>n+Number(c.n),0);
    return {rows:counts.reduce((n,c)=>n+Number(c.n),0),platformCounts,channelHeartbeats:readChannelHeartbeatRecords(db)};
  }finally{db.close();}
}
