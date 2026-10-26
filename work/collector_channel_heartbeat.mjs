import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {taskWriteContext} from './task_output_backup.mjs';
import {channelErrorDiagnostic} from './channel_collection_diagnostics.mjs';

export const nativeChannelNames={shixiseng:['实习僧'],iguopin:['国聘'],mohrss:['公共招聘网','中国公共招聘网'],jobonline:['就业在线'],job51:['前程无忧','51job'],zhaopin:['智联招聘','智联'],liepin:['猎聘'],nowcoder:['牛客','牛客网','nowcoder'],yupao:['鱼泡直聘','鱼泡'],boss:['BOSS直聘']};
export const channelKey=value=>Object.hasOwn(nativeChannelNames,value)?value:Object.keys(nativeChannelNames).find(key=>nativeChannelNames[key].includes(value));
export function meaningfulIngestionChange(previous,next){
  const metadata=new Set(['task_id','collected_at','collectedAt','updated_at','updatedAt','scraped_at','scrapedAt','source_total','acquisition_mode']);
  const content=row=>Object.fromEntries(Object.keys(row).filter(key=>!metadata.has(key)&&!key.startsWith('query_')).sort().map(key=>[key,row[key]]));
  return JSON.stringify(content(previous))!==JSON.stringify(content(next));
}
export function ensureChannelHeartbeatSchema(db){
  db.exec('CREATE TABLE IF NOT EXISTS channel_ingestion(platform TEXT PRIMARY KEY,last_ingested_at TEXT NOT NULL,inserted_rows INTEGER NOT NULL,updated_rows INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS channel_activity(platform TEXT PRIMARY KEY,run_id TEXT NOT NULL,state TEXT NOT NULL,started_at TEXT NOT NULL,updated_at TEXT NOT NULL,error_code TEXT);');
}
export function recordChannelIngestion(db,changes,at=new Date().toISOString()){
  const stamp=new Date(at).toISOString();
  const put=db.prepare('INSERT INTO channel_ingestion VALUES(?,?,?,?) ON CONFLICT(platform) DO UPDATE SET last_ingested_at=MAX(channel_ingestion.last_ingested_at,excluded.last_ingested_at),inserted_rows=channel_ingestion.inserted_rows+excluded.inserted_rows,updated_rows=channel_ingestion.updated_rows+excluded.updated_rows');
  for(const [name,value]of changes){const platform=channelKey(name);if(platform&&value.inserted+value.updated>0)put.run(platform,stamp,value.inserted,value.updated);}
}
export function readChannelHeartbeatRecords(db){
  const has=name=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  const ingestion=has('channel_ingestion')?db.prepare('SELECT * FROM channel_ingestion').all():[];
  const activity=has('channel_activity')?db.prepare('SELECT * FROM channel_activity').all():[];
  return Object.fromEntries(Object.keys(nativeChannelNames).map(platform=>[platform,{
    ingestion:ingestion.find(row=>row.platform===platform)||null,activity:activity.find(row=>row.platform===platform)||null,
  }]));
}
async function recordActivity({outputDir,taskId,platform,runId,state,errorCode=null,at=new Date().toISOString()}){
  if(!Object.hasOwn(nativeChannelNames,platform))throw Error('渠道心跳平台无效');
  const file=path.join(outputDir,'统一采集数据.sqlite');await taskWriteContext(file);
  const owner=JSON.parse(await fs.readFile(path.join(outputDir,'任务归属.json'),'utf8'));
  if(!taskId||owner.task_id!==taskId)throw Error('渠道心跳任务归属不一致');
  const db=new DatabaseSync(file);
  try{
    db.exec('PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS metadata(task_id TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS jobs(platform TEXT,job_id TEXT,data TEXT NOT NULL,PRIMARY KEY(platform,job_id));');
    const existing=db.prepare('SELECT task_id FROM metadata').get();if(existing&&existing.task_id!==taskId)throw Error('渠道心跳数据库归属不一致');
    db.prepare('INSERT OR IGNORE INTO metadata VALUES(?)').run(taskId);ensureChannelHeartbeatSchema(db);
    if(state==='running')db.prepare('INSERT INTO channel_activity VALUES(?,?,?,?,?,?) ON CONFLICT(platform) DO UPDATE SET run_id=excluded.run_id,state=excluded.state,started_at=excluded.started_at,updated_at=excluded.updated_at,error_code=NULL').run(platform,runId,state,at,at,null);
    else db.prepare('UPDATE channel_activity SET state=?,updated_at=?,error_code=? WHERE platform=? AND run_id=?').run(state,at,errorCode,platform,runId);
  }finally{db.close();}
}
export async function withChannelHeartbeat(options,action){
  const runId=randomUUID(),context={...options,runId};await recordActivity({...context,state:'running'});
  try{
    const result=await action(),summary=options.summary?.()||result||{};
    const diagnostic=channelErrorDiagnostic(Array.isArray(summary.errors)?summary.errors:[]);
    const deferred=summary.transport_paused||summary.scheduling?.remaining?.length||summary.paused;
    await recordActivity({...context,state:diagnostic?'error':deferred?'paused':summary.rows===0?'empty':'completed',errorCode:diagnostic?.code||null});
    return result;
  }catch(error){
    const diagnostic=channelErrorDiagnostic([error]);
    try{await recordActivity({...context,state:'error',errorCode:diagnostic.code});}catch{}
    throw error;
  }
}

export const heartbeatThresholds={staleAfterMs:120000,lostAfterMs:600000};
const duration=ms=>ms<60000?`${Math.floor(ms/1000)}秒`:ms<3600000?`${Math.floor(ms/60000)}分钟`:`${Math.floor(ms/3600000)}小时`;
export function deriveChannelHeartbeats(task,{records={},diagnostics={},verification={},now=Date.now(),runStartedAt=null,...thresholds}={}){
  const {staleAfterMs,lostAfterMs}={...heartbeatThresholds,...thresholds};
  if(!(staleAfterMs>0&&lostAfterMs>staleAfterMs))throw Error('渠道心跳阈值无效');
  const clock=Number(now),stamp=value=>{if(value==null)return null;const n=typeof value==='number'?value:Date.parse(value);return Number.isFinite(n)&&n<=clock+30000?n:null;};
  const runStart=stamp(runStartedAt),taskRunning=['running','stopping'].includes(task.status)&&['collection','public','zhaopin','yupao','boss'].includes(task.currentStage);
  return Object.fromEntries((task.platforms||[]).map(platform=>{
    const record=records[platform]||{},last=stamp(record.ingestion?.last_ingested_at);
    const previous=record.activity,activity=previous&&(!runStart||stamp(previous.updated_at)>=runStart)?previous:null;
    const currentData=last!==null&&(!runStart||last>=runStart),recent=currentData&&clock-last<staleAfterMs;
    const resolution=verification[platform];
    // The caller supplies only records anchored to the current error snapshot
    // and activity run. A later collection run invalidates them automatically.
    const hasResolution=resolution&&['manual_checked','checking','recheck_failed','verified'].includes(resolution.state);
    const diagnostic=hasResolution?diagnostics[platform]:activity?.state==='error'?channelErrorDiagnostic([{code:activity.error_code}]):['running','completed','empty'].includes(activity?.state)?null:diagnostics[platform];
    const base={lastIngestedAt:last===null?null:new Date(last).toISOString(),insertedRows:Number(record.ingestion?.inserted_rows||0),updatedRows:Number(record.ingestion?.updated_rows||0),staleAfterMs,lostAfterMs};
    const age=last===null?'':`${duration(Math.max(0,clock-last))}前入库`;
    const result=(state,label,detail='',reason='',code=null)=>[platform,{...base,state,label,detail,reason,code,requiresManual:diagnostic?.status==='manual'}];
    if(diagnostic&&['manual','failed','paused'].includes(diagnostic.status))return result(diagnostic.status==='paused'?'paused':'blocked',diagnostic.label,age,diagnostic.reason,diagnostic.code);
    if(task.status==='ready')return result('pending','待执行',age);
    if(activity?.state==='empty'||diagnostic?.status==='empty')return result('completed','本轮无结果',age,'本轮已核验的查询条件没有返回岗位，不代表平台没有相关岗位');
    if(activity?.state==='completed'||diagnostic?.status==='completed')return result('completed','本轮结束',age,'本轮渠道执行已结束，不等于平台岗位已采集完毕');
    if(task.status==='paused'||task.status==='stopping')return result('paused',task.status==='stopping'?'正在停止':'已暂停',age);
    if(!taskRunning)return result('unknown',task.status==='failed'?'任务异常停止':['completed','partial'].includes(task.status)?'本轮已停止':'当前未运行',age,'没有该渠道完成的可靠记录，不据此认定采集完成');
    if(activity?.state==='paused')return result('paused','本轮暂缓',age,'保留断点，等待后续调度');
    const running=activity?.state==='running'||diagnostic?.status==='running';
    if(!running&&!recent)return result('waiting',activity?'等待调度':'待监测',age,'尚无该渠道本轮开始执行的记录，不根据整个任务运行状态误报失联');
    const started=stamp(activity?.started_at)??runStart;
    const reference=currentData?Math.max(last,started??last):started;
    if(reference===null)return result('waiting','等待入库',age,'尚无可核验的本轮入库或渠道开始时间');
    const elapsed=Math.max(0,clock-reference);
    if(elapsed>=lostAfterMs)return result('lost','长时无入库',`${duration(elapsed)}无入库`,'请检查执行日志或官网状态；无入库不等于进程退出，也不能据此判断 Cookie 失效');
    if(elapsed>=staleAfterMs)return result('delayed','暂未入库',`${duration(elapsed)}无入库`,'可能仍在请求、去重或等待；尚无明确错误，不自动重试');
    return currentData?result('healthy','入库活跃',age,'来自成功提交的新增或内容更新；相同数据重复保存不刷新心跳'):result('waiting','等待首批入库',`${duration(elapsed)}已等待`);
  }));
}
