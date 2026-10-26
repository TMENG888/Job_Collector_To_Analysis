import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {roleScreeningCacheKey} from './role-classifier-registry.mjs';

// Include implementation and model contracts: a code/model upgrade must not
// silently resurrect a classification computed with a different pipeline.
export function assistantClassificationVersion(){
  const digest=createHash('sha256');
  for(const file of ['job_knowledge_store.mjs','job_knowledge_schema.mjs','role-evidence-v2.mjs','data-analysis-classifier.mjs','insight-classifier-input.mjs','role-classifier-registry.mjs'])digest.update(fs.readFileSync(new URL(file,import.meta.url)));
  return digest.update(roleScreeningCacheKey()).digest('hex');
}
export function createClassificationCache(directory){
  fs.mkdirSync(directory,{recursive:true});
  const db=new DatabaseSync(path.join(directory,'classifications.sqlite'));
  db.exec('PRAGMA busy_timeout=2000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS observations(job_key TEXT PRIMARY KEY, content_hash TEXT NOT NULL, pipeline TEXT NOT NULL, observation TEXT NOT NULL, digest TEXT NOT NULL)');
  const pipeline=assistantClassificationVersion(),get=db.prepare('SELECT observation,digest FROM observations WHERE job_key=? AND content_hash=? AND pipeline=?');
  const put=db.prepare('INSERT OR REPLACE INTO observations VALUES(?,?,?,?,?)');
  const hash=text=>createHash('sha256').update(text).digest('hex');
  let transaction=false;
  return {pipeline,
    begin(){db.exec('BEGIN');transaction=true;},
    get(key,contentHash){const row=get.get(key,contentHash,pipeline);if(!row||row.digest!==hash(row.observation))return null;try{return JSON.parse(row.observation);}catch{return null;}},
    put(key,contentHash,observation){const text=JSON.stringify(observation);put.run(key,contentHash,pipeline,text,hash(text));},
    // Partial classifications are safe reusable facts, not a published index.
    // Commit in small batches so cancelling a cold build does not discard work.
    checkpoint(){if(transaction){db.exec('COMMIT; BEGIN');}},
    close(){if(transaction)db.exec('COMMIT');db.close();},
  };
}
