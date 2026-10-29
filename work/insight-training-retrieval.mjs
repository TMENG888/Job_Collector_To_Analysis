import {DatabaseSync} from 'node:sqlite';
import {setImmediate as yieldToLoop} from 'node:timers/promises';
import {knowledgeDatabasePath} from './knowledge_storage.mjs';
import {samplingRetrieval,retrievalMatch} from './insight-sampling.mjs';

function reservoir(capacity,seed){
  let count=0,state=seed;const rows=[];
  return {rows,add(row){count++;if(rows.length<capacity){rows.push(row);return;}state=(Math.imul(state,1664525)+1013904223)>>>0;const at=Math.floor(state/4294967296*count);if(at<capacity)rows[at]=row;}};
}

export async function readLibraryTrainingPool(dataDir,{schema,role,keywords='',sampleCount=400,signal,onProgress,database}={}){
  if(!Number.isInteger(sampleCount)||sampleCount<120||sampleCount>2000)throw Error('全库训练抽样须为120–2000条');
  const db=new DatabaseSync(database||knowledgeDatabasePath(dataDir),{readOnly:true});
  const retrieval=samplingRetrieval(schema,role,keywords),capacity=sampleCount*4;
  const pools={target:reservoir(capacity,173),related:reservoir(capacity,379),random:reservoir(capacity,547)};
  let scanned=0,targetHits=0,relatedHits=0;
  try{
    db.exec('PRAGMA busy_timeout=2000; BEGIN');
    const from='jobs j WHERE EXISTS (SELECT 1 FROM memberships m JOIN tasks t ON t.task_id=m.task_id WHERE m.job_key=j.job_key AND t.archived=0)';
    const total=Number(db.prepare('SELECT COUNT(*) n FROM '+from).get().n);
    for(const saved of db.prepare('SELECT j.raw,j.job_key,j.content_hash FROM '+from+' ORDER BY j.job_key').iterate()){
      signal?.throwIfAborted();scanned++;
      const raw=JSON.parse(saved.raw),row={...raw,knowledge_key:saved.job_key,knowledge_hash:saved.content_hash};
      const title=String(raw.job_name||raw['岗位名称']||''),body=String(raw.job_description||raw['岗位描述']||'');
      if(title&&body.length>=80){
        const match=retrievalMatch(title,body,retrieval);
        if(match.target){targetHits++;pools.target.add(row);}
        else if(match.related){relatedHits++;pools.related.add(row);}
        pools.random.add(row);
      }
      if(scanned%512===0){onProgress?.({scanned,total});await yieldToLoop();}
    }
    const unique=new Map();for(const pool of Object.values(pools))for(const row of pool.rows)unique.set(row.knowledge_key,row);
    return {rows:[...unique.values()],randomSourceKeys:pools.random.rows.map(row=>row.knowledge_key),total,scannedRows:scanned,scope:'all',targetHits,relatedHits,poolLimit:capacity*3,selection:'全库扫描后有界分层候选池；随机层独立来自全库蓄水池；关键词命中不是标签，最终由Qwen核对职责'};
  }finally{db.close();}
}
