import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {snapshotGrowth} from './assistant_snapshot_policy.mjs';

export const insightSnapshotContract='insight-report-snapshot-v1';
const hash=value=>createHash('sha256').update(value).digest('hex');
export function insightSnapshotContext({inputFile='kb://all',role,classifier,semanticCloud,analysisMode='full',sampleSize=300,sheetName='岗位数据'}){
  if(!role||!classifier?.version||!classifier?.artifact_sha256)throw Error('报告快照缺少岗位或分类器版本');
  return {contract:insightSnapshotContract,inputFile,role,analysisMode,sampleSize:analysisMode==='full'?null:sampleSize,sheetName,
    classifier:{version:classifier.version,sha256:classifier.artifact_sha256,threshold:classifier.threshold,runId:classifier.id||'',experimental:classifier.experimental===true},
    semantics:{id:semanticCloud?.id||'',sha256:semanticCloud?.sha256||''}};
}
export const insightSnapshotContextKey=context=>hash(JSON.stringify(context));
export function reportMatchesContext(report,context,{legacy=false}={}){
  return report?.version==='job-market-insight-v13'&&report.input_file===context.inputFile&&report.role===context.role&&
    report.analysis_mode===context.analysisMode&&(context.analysisMode==='full'||report.requested_sample_rows===context.sampleSize)&&
    report.role_classifier?.artifact_sha256===context.classifier.sha256&&report.role_classifier?.version===context.classifier.version&&
    report.role_classifier?.threshold===context.classifier.threshold&&(report.qwen_classification?.run_id||'')===context.classifier.runId&&
    !!report.experimental===context.classifier.experimental&&(report.semantic_cloud?.run_id||'')===context.semantics.id&&
    (!legacy||context.analysisMode==='full'&&context.inputFile==='kb://all'&&report.salary?.daily_conversion_days===21.75)&&
    (!report.analysis_snapshot||report.analysis_snapshot.contextKey===insightSnapshotContextKey(context));
}
export function createInsightReportSnapshots(filename,{legacyFile}={}){
  let initialized=false;const misses=new Map();
  function open(){
    fs.mkdirSync(path.dirname(filename),{recursive:true});const db=new DatabaseSync(filename);db.exec('PRAGMA busy_timeout=10000');
    if(!initialized){db.exec(`CREATE TABLE IF NOT EXISTS insight_report_snapshots(
      snapshot_key TEXT PRIMARY KEY,context_key TEXT NOT NULL,role TEXT NOT NULL,baseline_rows INTEGER NOT NULL,
      generated_at TEXT NOT NULL,report_hash TEXT NOT NULL,metadata TEXT NOT NULL,report TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS insight_report_snapshot_context ON insight_report_snapshots(context_key,generated_at DESC);`);initialized=true;}
    return db;
  }
  function save(context,report,baselineRows){
    if(!reportMatchesContext(report,context)||!Number.isSafeInteger(baselineRows)||baselineRows<0||typeof report.generated_at!=='string'||!Number.isFinite(Date.parse(report.generated_at)))throw Error('报告与当前岗位、分类器或数据范围不一致，未发布快照');
    const raw=JSON.stringify(report),contextKey=insightSnapshotContextKey(context),reportHash=hash(raw),snapshotKey=hash(contextKey+'\n'+reportHash+'\n'+baselineRows);
    const metadata={snapshotKey,contextKey,context,baselineRows,generatedAt:report.generated_at,matchedRows:report.sample_rows,sourceRows:report.total_rows,reportHash};
    const db=open();try{db.prepare('INSERT OR IGNORE INTO insight_report_snapshots VALUES(?,?,?,?,?,?,?,?)').run(snapshotKey,contextKey,context.role,baselineRows,report.generated_at,reportHash,JSON.stringify(metadata),raw);}finally{db.close();}
    return metadata;
  }
  function history(context,legacySemanticModifiedAt){
    const db=open();try{
      if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='analyses'").get())return null;
      const rows=db.prepare(`SELECT data FROM analyses WHERE role=? AND json_extract(data,'$.input_file')=?
        AND json_extract(data,'$.role_classifier.artifact_sha256')=? AND json_extract(data,'$.role_classifier.version')=?
        AND coalesce(json_extract(data,'$.qwen_classification.run_id'),'')=?
        AND coalesce(json_extract(data,'$.semantic_cloud.run_id'),'')=? ORDER BY created_at DESC LIMIT 3`)
        .all(context.role,context.inputFile,context.classifier.sha256,context.classifier.version,context.classifier.runId,context.semantics.id);
      for(const row of rows){const report=JSON.parse(row.data);if(reportMatchesContext(report,context,{legacy:true})&&!(legacySemanticModifiedAt>Date.parse(report.generated_at)))return report;}
    }finally{db.close();}return null;
  }
  function find(context,currentRows,{adoptHistory=true,legacySemanticModifiedAt=0}={}){
    const contextKey=insightSnapshotContextKey(context),db=open();let metadata,historyVersion='';
    try{const row=db.prepare('SELECT metadata FROM insight_report_snapshots WHERE context_key=? ORDER BY generated_at DESC LIMIT 1').get(contextKey);metadata=row?JSON.parse(row.metadata):null;
      if(!metadata&&adoptHistory&&db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='analyses'").get())historyVersion=JSON.stringify(db.prepare('SELECT max(created_at) AS latest,count(*) AS n FROM analyses WHERE role=?').get(context.role));
    }finally{db.close();}
    if(!metadata&&adoptHistory){
      let legacyVersion='';if(legacyFile){try{const stat=fs.statSync(legacyFile);legacyVersion=stat.size+':'+stat.mtimeMs;}catch(error){if(error.code!=='ENOENT')throw error;}}
      const missVersion=historyVersion+'|'+legacyVersion+'|'+legacySemanticModifiedAt;
      if(misses.get(contextKey)===missVersion)return null;
      let report=history(context,legacySemanticModifiedAt);
      if(!report&&legacyFile){try{const legacy=JSON.parse(fs.readFileSync(legacyFile,'utf8'));if(reportMatchesContext(legacy,context,{legacy:true})&&!(legacySemanticModifiedAt>Date.parse(legacy.generated_at)))report=legacy;}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}}
      if(report)metadata=save(context,report,report.total_rows);
      else {misses.set(contextKey,missVersion);while(misses.size>100)misses.delete(misses.keys().next().value);}
    }
    if(!metadata)return null;
    const growth=snapshotGrowth(metadata.baselineRows,currentRows),decreased=currentRows<metadata.baselineRows;
    return {...metadata,growth,reusable:!growth.reached&&!decreased,reason:decreased?'data_decreased':growth.reached?'growth_threshold':'unchanged_or_below_threshold'};
  }
  function read(snapshotKey){
    if(!/^[a-f0-9]{64}$/.test(snapshotKey))throw Error('报告快照标识无效');
    const db=open();try{const row=db.prepare('SELECT report,report_hash FROM insight_report_snapshots WHERE snapshot_key=?').get(snapshotKey);if(!row)return null;if(hash(row.report)!==row.report_hash)throw Error('报告快照校验失败');return JSON.parse(row.report);}finally{db.close();}
  }
  return {save,find,read};
}
