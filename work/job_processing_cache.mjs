import path from 'node:path';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {PROCESSING_HASH} from './job_processing_rules.mjs';
import {knowledgeDatabasePath} from './knowledge_storage.mjs';
export const processingDirectory=dataDir=>path.join('E:/Codex/work/job-data-processing',createHash('sha256').update(path.resolve(dataDir)).digest('hex').slice(0,16));
export function openProcessedCache(dataDir){
  const file=path.join(processingDirectory(dataDir),'processing.sqlite');
  if(!fs.existsSync(file))return {get:()=>null,close:()=>{}};
  const db=new DatabaseSync(file,{readOnly:true});db.exec('PRAGMA busy_timeout=1000');
  try{const statement=db.prepare('SELECT data FROM processed WHERE job_key=? AND content_hash=? AND rules_hash=?');
    return {get:(key,hash)=>{const row=statement.get(key,hash,PROCESSING_HASH);return row?JSON.parse(row.data):null;},close:()=>db.close()};
  }catch(error){db.close();throw error;}
}
export function readProcessingBatch(dataDir,id,{metadataOnly=false}={}){
  if(!/^[a-f0-9-]{36}$/.test(String(id)))throw Error('清洗批次标识无效');
  const cache=new DatabaseSync(path.join(processingDirectory(dataDir),'processing.sqlite'),{readOnly:true});
  try{
    const run=JSON.parse(cache.prepare('SELECT data FROM runs WHERE id=?').get(id)?.data||'null');
    if(run?.status!=='completed')throw Error('清洗批次尚未完成，请先执行清洗');
    if(run.rulesHash!==PROCESSING_HASH)throw Error('清洗规则已更新，请重新执行清洗后接入洞察');
    if(metadataOnly)return run;
    const db=new DatabaseSync(knowledgeDatabasePath(dataDir),{readOnly:true});
    try{db.exec('PRAGMA busy_timeout=3000; BEGIN');
      const version=db.prepare('SELECT raw FROM job_versions WHERE job_key=? AND content_hash=?');
      const rows=[];
      for(const item of cache.prepare('SELECT * FROM run_items WHERE run_id=? AND input_usable=1 ORDER BY job_key').iterate(id)){
        const original=version.get(item.job_key,item.content_hash);if(!original)throw Error('清洗批次对应的岗位原文版本缺失，请重新清洗');
        rows.push({...JSON.parse(original.raw),knowledge_key:item.job_key,knowledge_hash:item.content_hash,knowledge_processing:JSON.parse(item.data)});
      }
      if(rows.length!==run.ready)throw Error('清洗批次记录不完整，请重新执行清洗');
      return {rows,revision:run.revision,processing_batch:run};
    }finally{db.close();}
  }finally{cache.close();}
}
