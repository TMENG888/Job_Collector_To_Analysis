import {randomUUID} from 'node:crypto';

export function initializeIngestionAudit(db){
  db.exec(`CREATE TABLE IF NOT EXISTS ingestion_batches(batch_id TEXT PRIMARY KEY,task_id TEXT NOT NULL,created_at TEXT NOT NULL,stats TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS ingestion_batches_task ON ingestion_batches(task_id,created_at);
    CREATE TABLE IF NOT EXISTS ingestion_rejections(rejection_id TEXT PRIMARY KEY,batch_id TEXT NOT NULL,reason TEXT NOT NULL,raw TEXT NOT NULL);`);
}

export function beginIngestionAudit(db,task,inputRows){
  const id=randomUUID(),started=new Date().toISOString(),seen=new Map(),rejections=[];
  return {
    reject(input,platform){rejections.push({reason:'平台、岗位ID或岗位名称缺失，未进入知识库',raw:input,platform});},
    observe(key,platform,previousHash,nextHash){
      const item=seen.get(key);
      if(item){item.occurrences++;item.nextHash=nextHash;}
      else seen.set(key,{platform,previousHash:previousHash||null,nextHash,occurrences:1});
    },
    finish(){
      const empty=()=>({input:0,invalid:0,duplicates:0,unique:0,inserted:0,updated:0,unchanged:0});
      const platforms={};
      for(const item of seen.values()){
        const p=platforms[item.platform]??=empty();p.input+=item.occurrences;p.duplicates+=item.occurrences-1;p.unique++;
        p[!item.previousHash?'inserted':item.previousHash!==item.nextHash?'updated':'unchanged']++;
      }
      for(const item of rejections){const platform=String(item.platform||item.raw?.platform||item.raw?.['平台']||'未明确');const p=platforms[platform]??=empty();p.input++;p.invalid++;}
      const summary=empty();for(const p of Object.values(platforms))for(const key of Object.keys(summary))summary[key]+=p[key];
      if(summary.input!==inputRows)throw Error('入库审计数量不守恒，停止本批入库');
      db.prepare('INSERT INTO ingestion_batches VALUES(?,?,?,?)').run(id,task.id,started,JSON.stringify({...summary,platforms}));
      const insert=db.prepare('INSERT INTO ingestion_rejections VALUES(?,?,?,?)');
      for(const item of rejections)insert.run(randomUUID(),id,item.reason,JSON.stringify(item.raw));
      return summary;
    }
  };
}
