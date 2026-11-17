import {parentPort,workerData} from 'node:worker_threads';
import fs from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {companyRecruitingRanking,provinceName} from '../job_collector_ui/public/insight-groups.js';
try{
  let source;
  if(workerData.snapshotKey){
    if(!/^[a-f0-9]{64}$/.test(workerData.snapshotKey))throw Error('报告快照标识无效');
    const db=new DatabaseSync(workerData.knowledgeFilename,{readOnly:true});
    try{const exists=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='insight_report_snapshots'").get();
      const row=exists?db.prepare('SELECT report,report_hash FROM insight_report_snapshots WHERE snapshot_key=?').get(workerData.snapshotKey):null;
      if(!row)throw Object.assign(Error('报告快照不存在'),{code:'SNAPSHOT_MISSING'});
      if(createHash('sha256').update(row.report).digest('hex')!==row.report_hash)throw Error('报告快照校验失败');source=row.report;
    }finally{db.close();}
  }else source=await fs.readFile(workerData.filename,'utf8');
  const report=JSON.parse(source);
  if(workerData.knowledgeFilename&&report.cohort_observations?.some(row=>!row.company_name)){
    let db;
    try{
      db=new DatabaseSync(workerData.knowledgeFilename,{readOnly:true});db.exec('PRAGMA busy_timeout=1000');
      const version=db.prepare('SELECT raw FROM job_versions WHERE job_key=? AND content_hash=?');
      const current=db.prepare('SELECT raw FROM jobs WHERE job_key=? AND content_hash=?');
      for(const row of report.cohort_observations){
        if(row.company_name||!row.knowledge_key||!row.knowledge_hash)continue;
        const source=version.get(row.knowledge_key,row.knowledge_hash)||current.get(row.knowledge_key,row.knowledge_hash);
        if(!source)continue;
        const raw=JSON.parse(source.raw);row.company_name=raw.company_name||'';row.company_id=raw.company_id||'';
        row.province=provinceName({...row,province:raw.province||raw['省份']||''});
      }
    }catch(error){report.company_ranking_warning='历史报告公司名称补齐暂不可用：'+error.message;}
    finally{db?.close();}
  }
  report.company_ranking=companyRecruitingRanking(report.cohort_observations||[]);
  const raw=new TextEncoder().encode(JSON.stringify(report));
  const gzip=Uint8Array.from(gzipSync(raw));
  parentPort.postMessage({raw,gzip},[raw.buffer,gzip.buffer]);
}catch(error){parentPort.postMessage(error.code==='SNAPSHOT_MISSING'?{missing:true}:{error:error.message});}
