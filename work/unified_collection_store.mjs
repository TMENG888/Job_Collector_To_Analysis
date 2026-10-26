import fs from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {parseChannelCsv} from './public_channel_csv.mjs';
import {writeAtomic,writeJsonAtomic} from './collector_storage.mjs';
import {publishLatestCsv} from './latest_dataset.mjs';
import {ensureChannelHeartbeatSchema,recordChannelIngestion,meaningfulIngestionChange} from './collector_channel_heartbeat.mjs';

const channels=['shixiseng','iguopin','mohrss','jobonline','job51','zhaopin','liepin','yupao','boss'];
const text=value=>String(value||'').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').trim();
const join=value=>Array.isArray(value)?value.join(' | '):String(value||'');
export function checkpointRows(data,name) {
  if(name.startsWith('jobonline_')||name.startsWith('liepin_'))return data.records||[];
  if(!name.startsWith('shixiseng_'))return [];
  return (data.list||[]).flatMap(row=>{
    const saved=data.details?.[row.uuid];
    if(!saved?.ok)return []; // discovered lists are not completed records
    const detail=saved.data||{};
    return [{platform:'实习僧',job_id:String(row.uuid),query_keyword:data.keyword,query_city:data.city?.name||'',
      job_name:detail.iname||row.name,company_id:detail.cuuid||row.c_uuid,company_name:detail.cname||row.cname,
      salary:detail.salary_desc||`${row.minsalary||row.minsal||''}-${row.maxsalary||row.maxsal||''}`,
      city:detail.city||row.city,education:detail.degree||row.degree,employment_type:detail.ftype||row.ftype,
      company_size:detail.scale||row.scale,industry:detail.industry||row.industry,
      tags:join([...(detail.attraction||[]),...(row.c_tags||[]),...(row.i_tags||[])]),skills:join(detail.skills||row.skill),
      job_description:text(detail.info||detail.job||row.hope_you),address:detail.address||'',
      refresh_time:detail.refresh||row.refresh,deadline:detail.endtime||'',
      job_url:detail.url||`https://www.shixiseng.com/intern/${row.uuid}`,
      company_url:row.c_uuid?`https://www.shixiseng.com/com/${row.c_uuid}`:'',detail_status:'成功',access_level:'公开完整详情'}];
  });
}

export async function updateUnifiedDataset(task,{publishCsv=false}={}) {
  const owner=JSON.parse(await fs.readFile(path.join(task.outputDir,'任务归属.json'),'utf8'));
  if(owner.task_id!==task.id)throw new Error('统一数据集任务归属不符');
  const database=path.join(task.outputDir,'统一采集数据.sqlite');
  const db=new DatabaseSync(database);
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS jobs(platform TEXT, job_id TEXT, data TEXT NOT NULL, PRIMARY KEY(platform,job_id)); CREATE TABLE IF NOT EXISTS sources(file TEXT PRIMARY KEY, signature TEXT); CREATE TABLE IF NOT EXISTS metadata(task_id TEXT PRIMARY KEY);');
    const existing=db.prepare('SELECT task_id FROM metadata').get();
    if(existing && existing.task_id!==task.id)throw new Error('数据库属于其他任务');
    db.prepare('INSERT OR IGNORE INTO metadata VALUES (?)').run(task.id);
    ensureChannelHeartbeatSchema(db);
    const sources=channels.map(channel=>path.join(task.outputDir,`${channel}_标准化数据.csv`));
    const checkpointDir=path.join(task.outputDir,'断点数据');
    const names=await fs.readdir(checkpointDir).catch(()=>[]);
    sources.push(...names.filter(name=>/^(shixiseng|jobonline|liepin)_.*\.json$/.test(name)&&!name.endsWith('.diagnostic.json')).map(name=>path.join(checkpointDir,name)));
    let changed=false;
    for(const file of sources) {
      const stat=await fs.stat(file).catch(()=>null);if(!stat)continue;
      const signature=`${stat.size}:${stat.mtimeMs}`;
      if(db.prepare('SELECT signature FROM sources WHERE file=?').get(file)?.signature===signature)continue;
      const content=await fs.readFile(file,'utf8');
      let rows;
      if(file.endsWith('.json')) {
        const data=JSON.parse(content);if(data.task_id!==task.id)continue;
        rows=checkpointRows(data,path.basename(file));
      }else rows=parseChannelCsv(content);
      db.exec('BEGIN IMMEDIATE');
      try {
        const changes=new Map();
        for(const raw of rows) {
          if(raw.task_id && raw.task_id!==task.id)throw new Error('记录混入其他任务');
          if(!raw.platform||!raw.job_id)continue;
          const old=db.prepare('SELECT data FROM jobs WHERE platform=? AND job_id=?').get(String(raw.platform),String(raw.job_id));
          const previous=old?JSON.parse(old.data):{};
          const merged={...previous};
          // Missing fields never erase previously captured information.
          for(const [key,value] of Object.entries(raw))if(value!==null&&value!==undefined&&String(value).trim())merged[key]=value;
          if(String(previous.job_description||'').length>String(raw.job_description||'').length)merged.job_description=previous.job_description;
          merged.task_id=task.id;
          merged.query_keywords=[...new Set([...(previous.query_keywords||[]),previous.query_keyword,raw.query_keyword].filter(Boolean))];
          const encoded=JSON.stringify(merged);if(old?.data===encoded)continue;
          db.prepare('INSERT INTO jobs VALUES (?,?,?) ON CONFLICT(platform,job_id) DO UPDATE SET data=excluded.data').run(String(raw.platform),String(raw.job_id),encoded);
          if(old&&!meaningfulIngestionChange(previous,merged))continue;
          const change=changes.get(String(raw.platform))||{inserted:0,updated:0};change[old?'updated':'inserted']++;changes.set(String(raw.platform),change);
        }
        recordChannelIngestion(db,changes,new Date(stat.mtimeMs).toISOString());
        db.prepare('INSERT INTO sources VALUES (?,?) ON CONFLICT(file) DO UPDATE SET signature=excluded.signature').run(file,signature);
        db.exec('COMMIT');changed=true;
      }catch(error){db.exec('ROLLBACK');throw error;}
    }
    const count=Number(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n);
    const csvPath=path.join(task.outputDir,'统一采集数据.csv');
    if(publishCsv) {
      const rows=db.prepare('SELECT data FROM jobs ORDER BY platform,job_id').all().map(row=>JSON.parse(row.data));
      const columns=[...new Set(['task_id','platform','job_id','job_name','company_name','city','salary','job_description',...rows.flatMap(row=>Object.keys(row))])];
      const escape=value=>`"${String(Array.isArray(value)?value.join(' | '):value??'').replaceAll('"','""')}"`;
      await writeAtomic(csvPath,'\uFEFF'+[columns.map(escape).join(','),...rows.map(row=>columns.map(key=>escape(row[key])).join(','))].join('\r\n'));
    }
    const report={task_id:task.id,rows:count,updatedAt:new Date().toISOString(),csvPath:publishCsv?csvPath:null,database,storage:'sqlite',scope:'采集中统一候选；按平台岗位ID去重，模块直接读数据库'};
    // Snapshot export failures must not stop collection or its final delivery.
    if(publishCsv&&count>0){try{await publishLatestCsv(task,report);}catch(error){report.latestSnapshotError=error.message;}}
    await writeJsonAtomic(path.join(task.outputDir,'统一采集数据状态.json'),report);
    return report;
  } finally {db.close();}
}
