import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {setImmediate as yieldToLoop} from 'node:timers/promises';
import {roleFamilies,skillRules,normalizeSalary,normalizeEmploymentType} from './job_knowledge_schema.mjs';
import {roleSections} from './role-evidence-v2.mjs';
import {cityName} from '../job_collector_ui/public/insight-cohorts.js';
import {parseChannelCsv} from './public_channel_csv.mjs';
import {updateUnifiedDataset} from './unified_collection_store.mjs';
import {reviewState,labelKey,labelDigest} from './reviewed_job_labels.mjs';
import {admitKnowledgeJobs,admissionSummary,ADMISSION_VERSION} from './job_data_admission.mjs';
import {createTermReviewMethods} from './skill_term_review.mjs';
import {roleClassifier,supervisedRoleFamilies,roleScreeningStatus,roleScreeningCacheKey} from './role-classifier-registry.mjs';
import {knowledgeDatabasePath,storageError} from './knowledge_storage.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const defaultKnowledgeDir=()=>process.env.JOB_UI_DATA_DIR?path.resolve(process.env.JOB_UI_DATA_DIR):path.join(root,'ui_data');
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const platformAliases={智联:'智联招聘',zhaopin:'智联招聘',shixiseng:'实习僧',iguopin:'国聘',jobonline:'就业在线',mohrss:'公共招聘网',中国公共招聘网:'公共招聘网',job51:'前程无忧',liepin:'猎聘',yupao:'鱼泡直聘',boss:'BOSS直聘'};
const fields={平台:'platform',岗位ID:'job_id',岗位名称:'job_name',公司名称:'company_name',公司ID:'company_id',薪资:'salary',工作城市:'city',经验要求:'experience',学历要求:'education',用工类型:'employment_type',公司规模:'company_size',行业:'industry',技能:'skills',岗位描述:'job_description',岗位链接:'job_url',查询关键词:'query_keyword'};
export function canonicalKnowledgeRow(input){
  const row={...input};for(const [cn,en]of Object.entries(fields))if(!row[en]&&row[cn])row[en]=row[cn];
  row.platform=platformAliases[row.platform]||String(row.platform||'').trim();row.job_id=String(row.job_id||'').trim();
  if(!row.platform||!row.job_id||!String(row.job_name||'').trim())return null;
  // Transport metadata is not part of the immutable job content version.
  for(const name of ['row_no','record_no','task_id','query_keywords','query_keyword','query_city','collected_at','knowledge_key','knowledge_hash'])delete row[name];
  for(const cn of Object.keys(fields))delete row[cn];
  return row;
}
export const knowledgeJobKey=row=>'K'+hash([row.platform,row.job_id]).slice(0,24);
export function classifyKnowledgeRow(row){
  const title=String(row.job_name||''),sections=roleSections({'岗位描述':row.job_description||''});
  const body=sections.map(s=>s.quote).join('\n');
  const full=[title,row.skills,body].join('\n');
  const skills=skillRules.filter(([,re])=>re.test(full)).map(([name])=>name);
  const technicalTitle=/工程师|开发|研发|架构|程序员|软件|算法|AI技术|技术专家|技术负责人/i.test(title);
  const titleFamilies=[];
  const families=[];
  // Generic backend titles may contain actual Agent engineering duties, not just AI tool use.
  const engineering=sections.filter(s=>s.location!=='requirements'&&/(?:智能体|\bagent\b|\brag\b|大模型应用)/i.test(s.quote)&&/开发|构建|搭建|编排|集成|接入|实现/.test(s.quote)&&!/探索|兴趣|了解|熟悉|优先|加分|辅助编程|代码助手/.test(s.quote));
  // Apply last: title rules or historical Agent engineering hints cannot revive
  // a rejected supervised family. Other family memberships remain independent.
  const supervised={};
  for(const family of supervisedRoleFamilies()){
    const result=roleClassifier(family).match(row);supervised[family]={decision:result.decision,...result.classifier_evidence};
    for(let i=families.length-1;i>=0;i--)if(families[i]===family)families.splice(i,1);
    if(result.matched)families.push(family);
  }
  const dataAnalysis=supervised['数据分析'];
  const salary=normalizeSalary(row.salary);
  return {role_families:[...new Set(families)],decision:body.length>=16&&families.length?'include':'review',
    skills,tasks:[],domains:[],salary_midpoint_k:salary?salary.midpoint/1000:null,
    salary_basis:/天|日|小时/.test(String(row.salary))?'日/时薪折算（比较默认排除）':'招聘月薪中点',
    city:cityName(row.city),experience:String(row.experience||'未明确'),education:String(row.education||'未明确'),
    company_size:row.company_size||'未明确',employment_type:normalizeEmploymentType(row.employment_type),
    industry:row.industry||'未明确',label_source:'岗位专用TF-IDF＋逻辑回归（非人工复核）',
    role_evidence:{primary:titleFamilies,secondary:engineering.length&&technicalTitle?['智能体/大模型应用']:[],
      engineering:engineering.slice(0,3),preferred:sections.filter(s=>/优先|加分|了解|熟悉/.test(s.quote)).slice(0,3),
      supervised,...(dataAnalysis?{data_analysis:dataAnalysis}:{})},
    evidence:sections.slice(0,3).map(s=>({quote:s.quote,location:s.location}))};
}
const readJson=async(file,fallback)=>{try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}};
export function createKnowledgeStore(dataDir=defaultKnowledgeDir()){
  const filename=knowledgeDatabasePath(dataDir);let pending=null,lastSync=0,assistantCache=null;
  async function open(){await fs.mkdir(path.dirname(filename),{recursive:true});const disk=await fs.statfs(path.dirname(filename));if(Number(disk.bavail)*Number(disk.bsize)<128*1024**2)throw storageError(new Error('SQLITE_FULL'));const db=new DatabaseSync(filename);db.exec(`PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT OR IGNORE INTO metadata VALUES('revision','0');
    CREATE TABLE IF NOT EXISTS jobs(job_key TEXT PRIMARY KEY,platform TEXT NOT NULL,job_id TEXT NOT NULL,content_hash TEXT NOT NULL,raw TEXT NOT NULL,observation TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(platform,job_id));
    CREATE INDEX IF NOT EXISTS jobs_id_lookup ON jobs(job_id);
    CREATE TABLE IF NOT EXISTS job_versions(job_key TEXT,content_hash TEXT,raw TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(job_key,content_hash));
    CREATE TABLE IF NOT EXISTS tasks(task_id TEXT PRIMARY KEY,label TEXT NOT NULL,archived INTEGER NOT NULL DEFAULT 0,output_dir TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS memberships(task_id TEXT,job_key TEXT,source TEXT NOT NULL,PRIMARY KEY(task_id,job_key));
    CREATE INDEX IF NOT EXISTS memberships_job ON memberships(job_key);
    CREATE TABLE IF NOT EXISTS sources(source TEXT PRIMARY KEY,signature TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS labels(label_id TEXT PRIMARY KEY,job_key TEXT NOT NULL,content_hash TEXT NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS labels_job_lookup ON labels(job_key,content_hash,state);
    CREATE TABLE IF NOT EXISTS analyses(analysis_id TEXT PRIMARY KEY,role TEXT,revision INTEGER,snapshot_uri TEXT,data TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS snapshots(snapshot_id TEXT PRIMARY KEY,revision INTEGER,task_id TEXT,rows_json TEXT NOT NULL,created_at TEXT NOT NULL);`);return db;}
  function bump(db){db.exec("UPDATE metadata SET value=CAST(value AS INTEGER)+1 WHERE key='revision'");}
  function ingest(db,task,rows,source){
    const upsert=db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?) ON CONFLICT(job_key) DO UPDATE SET content_hash=excluded.content_hash,raw=excluded.raw,observation=excluded.observation,updated_at=excluded.updated_at');
    const version=db.prepare('INSERT OR IGNORE INTO job_versions VALUES(?,?,?,?)');
    const membership=db.prepare('INSERT INTO memberships VALUES(?,?,?) ON CONFLICT(task_id,job_key) DO UPDATE SET source=excluded.source');
    let changed=0;
    for(const input of rows){
      if(input.task_id&&input.task_id!==task.id)throw new Error('知识库拒绝其他任务的记录');
      let row=canonicalKnowledgeRow(input);if(!row)continue;
      const key=knowledgeJobKey(row),old=db.prepare('SELECT * FROM jobs WHERE job_key=?').get(key);
      if(old){const before=JSON.parse(old.raw),merged={...before};for(const [f,v]of Object.entries(row))if(v!=null&&String(v).trim())merged[f]=v;if(String(before.job_description||'').length>String(row.job_description||'').length)merged.job_description=before.job_description;row=merged;}
      const digest=hash(row),stamp=new Date().toISOString();
      if(old?.content_hash!==digest){upsert.run(key,row.platform,row.job_id,digest,JSON.stringify(row),JSON.stringify(classifyKnowledgeRow(row)),stamp);version.run(key,digest,JSON.stringify(row),stamp);changed++;}
      if(!db.prepare('SELECT 1 FROM memberships WHERE task_id=? AND job_key=?').get(task.id,key))changed++;
      membership.run(task.id,key,source);
    }
    if(changed)bump(db);return changed;
  }
  async function syncInternal(options={}){
    const tasks=options.tasks||await readJson(path.join(dataDir,'tasks.json'),[]);const errors=[];const db=await open();
    try{
      for(const task of tasks){
        const old=db.prepare('SELECT * FROM tasks WHERE task_id=?').get(task.id);
        const saveTask=archived=>{if(old?.archived!==archived||old?.label!==task.label||old?.output_dir!==task.outputDir){db.prepare('INSERT INTO tasks VALUES(?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET label=excluded.label,archived=excluded.archived,output_dir=excluded.output_dir').run(task.id,task.label,archived,task.outputDir);bump(db);}};
        if(task.archived){saveTask(1);continue;}
        try{
          const owner=await readJson(path.join(task.outputDir,'任务归属.json'),null);
          if(!owner||owner.task_id!==task.id){saveTask(1);errors.push({task_id:task.id,error:'没有有效任务归属；历史共享目录未自动导入'});continue;}
          // Decide visibility once. Repeatedly unarchiving then rearchiving a
          // missing directory invalidates the assistant's whole index each poll.
          saveTask(0);
          // Existing platform adapters keep their checkpoints; the inter-module path is now SQLite.
          if(options.refresh!==false)await updateUnifiedDataset(task,{publishCsv:false});
          const native=path.join(task.outputDir,'统一采集数据.sqlite'),stat=await fs.stat(native).catch(()=>null);
          if(stat){
            // A live WAL writer need not change the main DB until checkpoint.
            // Include WAL metadata or intermediate committed rows can be missed.
            const wal=await fs.stat(native+'-wal').catch(error=>{if(error.code==='ENOENT')return null;throw error;});
            const signature=`${stat.size}:${stat.mtimeMs}:${wal?.size||0}:${wal?.mtimeMs||0}`;
            if(db.prepare('SELECT signature FROM sources WHERE source=?').get(native)?.signature!==signature){
              const source=new DatabaseSync(native,{readOnly:true});let rows;
              try{source.exec('PRAGMA busy_timeout=5000');if(source.prepare('SELECT task_id FROM metadata').get()?.task_id!==task.id)throw new Error('任务数据库归属不一致');rows=source.prepare('SELECT data FROM jobs ORDER BY platform,job_id').all().map(r=>JSON.parse(r.data));}finally{source.close();}
              db.exec('BEGIN IMMEDIATE');try{ingest(db,task,rows,native);db.prepare('INSERT OR REPLACE INTO sources VALUES(?,?)').run(native,signature);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
            }
          }
          // One-time import of owned historical delivery JSON/CSV. Never scan broad directories or XLSX guesses.
          const manifest=await readJson(path.join(task.outputDir,'最终交付清单.json'),null);
          if(manifest?.task_id===task.id){
            const jsonFile=path.join(task.outputDir,'最终合并数据.json');
            let file=jsonFile;if(!await fs.stat(file).catch(()=>null)){file=path.resolve(task.outputDir,manifest.dataset||'');if(path.dirname(file).toLowerCase()!==path.resolve(task.outputDir).toLowerCase()||!file.endsWith('.csv'))file='';}
            if(file){const stat=await fs.stat(file).catch(()=>null);if(stat){const signature=`${stat.size}:${stat.mtimeMs}`;if(db.prepare('SELECT signature FROM sources WHERE source=?').get(file)?.signature!==signature){const content=await fs.readFile(file,'utf8');const rows=file.endsWith('.json')?JSON.parse(content):parseChannelCsv(content);if(!Array.isArray(rows))throw new Error('历史交付记录不是数组');db.exec('BEGIN IMMEDIATE');try{ingest(db,task,rows,file);db.prepare('INSERT OR REPLACE INTO sources VALUES(?,?)').run(file,signature);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}}}
          }
        }catch(e){errors.push({task_id:task.id,error:e.message});}
      }
      // Review status is revalidated against label digests on every changed label file.
      for(const labelTask of await readJson(path.join(dataDir,'label_jobs.json'),[])){
        if(labelTask.archived)continue;
        try{
          const result=path.join(labelTask.outputDir,'标注结果.jsonl'),review=path.join(labelTask.outputDir,'人工复核.jsonl');
          const rs=await fs.stat(result).catch(()=>null);if(!rs)continue;const vs=await fs.stat(review).catch(()=>null);
          const signature=`${rs.size}:${rs.mtimeMs}:${vs?.size||0}:${vs?.mtimeMs||0}`;
          if(db.prepare('SELECT signature FROM sources WHERE source=?').get(result)?.signature===signature)continue;
          const reviewed=await reviewState(labelTask.outputDir);db.exec('BEGIN IMMEDIATE');
          try{
            for(const label of reviewed.records){
              const rows=label.knowledge_key?db.prepare('SELECT * FROM jobs WHERE job_key=? AND content_hash=?').all(label.knowledge_key,label.knowledge_hash):db.prepare('SELECT * FROM jobs WHERE job_id=?').all(String(label.job_id));
              const matching=rows.filter(j=>{const raw=JSON.parse(j.raw);return raw.job_name===label.job_name&&String(raw.job_description||'').slice(0,6000)===String(label.job_description||'');});
              if(matching.length!==1)continue;const job=matching[0];
              const state=reviewed.decisions.get(labelKey(label))||(labelTask.platform==='rules'?'rule':'pending');
              db.prepare('INSERT OR REPLACE INTO labels VALUES(?,?,?,?,?)').run(`${labelTask.id}:${labelKey(label)}`,job.job_key,job.content_hash,state,JSON.stringify({...label,label_digest:labelDigest(label)}));
            }
            db.prepare('INSERT OR REPLACE INTO sources VALUES(?,?)').run(result,signature);bump(db);db.exec('COMMIT');
          }catch(e){db.exec('ROLLBACK');throw e;}
        }catch(e){errors.push({label_task_id:labelTask.id,error:e.message});}
      }
      lastSync=Date.now();return {...status(db),sync_errors:errors};
    }finally{db.close();}
  }
  function status(db){return {revision:Number(db.prepare("SELECT value FROM metadata WHERE key='revision'").get().value),rows:Number(db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE job_key IN (SELECT m.job_key FROM memberships m JOIN tasks t ON t.task_id=m.task_id WHERE t.archived=0)').get().n),updated_at:new Date().toISOString(),storage:'sqlite',database:filename,
    role_screening:roleScreeningStatus()};}
  let lastSyncWarning='';
  async function ensure(){if(Date.now()-lastSync>15000){try{await sync({refresh:false});lastSyncWarning='';}catch(error){lastSyncWarning=storageError(error).message;
    // Queries can use already committed rows even if refreshing collectors fails.
    // Snapshot publication still propagates write errors; never claim freshness.
    const check=new DatabaseSync(filename,{readOnly:true});try{check.prepare('SELECT value FROM metadata LIMIT 1').get();}finally{check.close();}
  }}}
  function sync(options){return pending||(pending=syncInternal(options).finally(()=>{pending=null;}));}
  async function ensureMetadata({synchronize=true}={}){
    // UI metadata reads use the last committed knowledge base, not an ingestion
    // pass that can wait on source files or unrelated collector/write failures.
    // Initialize only a genuinely new store; configured missing disks still fail
    // in knowledgeDatabasePath rather than creating a replacement database.
    if(synchronize||!await fs.stat(filename).catch(error=>{if(error.code==='ENOENT')return null;throw error;}))await ensure();
  }
  function selected(db,taskId=''){
    // jobs already has a unique primary key. A semi-join avoids multiplying jobs
    // by task memberships and sorting entire JD blobs in a disk-backed DISTINCT.
    return db.prepare(`SELECT j.* FROM jobs j WHERE EXISTS (SELECT 1 FROM memberships m JOIN tasks t ON t.task_id=m.task_id WHERE m.job_key=j.job_key AND t.archived=0 ${taskId?'AND t.task_id=?':''}) ORDER BY j.job_key`).all(...(taskId?[taskId]:[]));
  }
  function approvedLabels(db,job){
    const raw=JSON.parse(job.raw),source=[raw.job_name,raw.skills,raw.job_description].join('\n');
    const labels=db.prepare("SELECT label_id,data FROM labels WHERE job_key=? AND content_hash=? AND state='approved'").all(job.job_key,job.content_hash).map(l=>({...JSON.parse(l.data),supplemental:l.label_id.startsWith('skill-term:')}));
    const result={skills:[],tasks:[],domains:[],reviewed_terms:[]};
    for(const label of labels)for(const [field,kinds]of [['skills',['skill','技能']],['tasks',['task','职责','任务']],['domains',['domain','业务方向']]]){
      const names=field==='domains'?label.business_domains:label[field];
      if(!Array.isArray(names))continue;
      const valid=names.filter(name=>(label.evidence_json||[]).some(e=>kinds.includes(e.label_type)&&e.label===name&&String(e.quote||'').length>=2&&source.includes(e.quote)));
      result[field].push(...valid);if(field==='skills'&&label.supplemental)result.reviewed_terms.push(...valid);
    }
    for(const f of Object.keys(result))result[f]=[...new Set(result[f])];return result;
  }
  const openReadOnly=async()=>{
    if(!await fs.stat(filename).catch(error=>{if(error.code==='ENOENT')return null;throw error;})){const db=await open();db.close();}
    const db=new DatabaseSync(filename,{readOnly:true});db.exec('PRAGMA busy_timeout=1000');return db;
  };
  return {filename,sync,termReview:createTermReviewMethods({open,openReadOnly,ensure,bump}),
    async status(options){await ensureMetadata(options);const db=new DatabaseSync(filename,{readOnly:true});try{return {...status(db),sync_warning:lastSyncWarning||null};}finally{db.close();}},
    async catalog(options){await ensureMetadata(options);const db=new DatabaseSync(filename,{readOnly:true});try{return db.prepare('SELECT t.task_id,t.label,COUNT(m.job_key) AS n FROM tasks t JOIN memberships m ON m.task_id=t.task_id WHERE t.archived=0 GROUP BY t.task_id ORDER BY t.label').all().map(t=>({path:`kb://task/${encodeURIComponent(t.task_id)}`,taskId:t.task_id,role:t.label,name:`${t.label} · 知识库 ${t.n} 条`,expectedRows:Number(t.n),size:0,format:'sqlite',resolution:'knowledge',canonical:true,syncWarning:lastSyncWarning||null}));}finally{db.close();}},
    async read(uri='kb://all'){await ensure();const db=new DatabaseSync(filename,{readOnly:true});try{
      db.exec('BEGIN');
      const url=new URL(uri);if(url.protocol!=='kb:')throw new Error('无效知识库数据源');
      if(url.hostname==='snapshot'){const saved=db.prepare('SELECT * FROM snapshots WHERE snapshot_id=?').get(decodeURIComponent(url.pathname.slice(1)));if(!saved)throw new Error('知识库分析快照不存在');return {rows:JSON.parse(saved.rows_json),revision:saved.revision,snapshot:uri};}
      if(!['task','all'].includes(url.hostname))throw new Error('不支持的知识库数据源');
      const taskId=url.hostname==='task'?decodeURIComponent(url.pathname.slice(1)):'';
      if(url.hostname==='task'&&!taskId)throw new Error('缺少知识库任务 ID');
      return {...status(db),rows:selected(db,taskId).map(j=>{const labels=approvedLabels(db,j);return {...JSON.parse(j.raw),knowledge_key:j.job_key,knowledge_hash:j.content_hash,knowledge_approved_skills:labels.skills,knowledge_approved_term_skills:labels.reviewed_terms,knowledge_approved_tasks:labels.tasks,knowledge_approved_domains:labels.domains};})};
    }finally{db.close();}},
    async snapshot(uri){const data=await this.read(uri);const db=await open();try{const id=randomUUID();db.prepare('INSERT INTO snapshots VALUES(?,?,?,?,?)').run(id,data.revision,uri,JSON.stringify(data.rows),new Date().toISOString());return {uri:`kb://snapshot/${id}`,revision:data.revision,rows:data.rows.length};}finally{db.close();}},
    async publishAnalysis(report){const db=await open();try{const id=hash([report.role,report.generated_at,report.input_file]);db.prepare('INSERT OR REPLACE INTO analyses VALUES(?,?,?,?,?,?)').run(id,report.role,report.knowledge_revision??null,report.knowledge_snapshot||'',JSON.stringify(report),report.generated_at||new Date().toISOString());bump(db);return id;}finally{db.close();}},
    async assistantData({readOnly=false,classificationCache,onProgress,signal}={}){if(!readOnly)await ensure();const db=readOnly?new DatabaseSync(filename,{readOnly:true}):await open();try{
      signal?.throwIfAborted();onProgress?.({phase:'index_reading',message:'正在读取岗位库快照'});
      if(readOnly)db.exec('PRAGMA busy_timeout=10000');
      db.exec('BEGIN');
      const state=status(db),cacheKey=`knowledge:${state.revision}:${ADMISSION_VERSION}:${roleScreeningCacheKey()}`;
      if(assistantCache?.cacheKey===cacheKey)return assistantCache;
      const analyses=db.prepare('SELECT role,data FROM analyses ORDER BY created_at DESC LIMIT 20').all();
      const accepted=new Map();for(const analysis of analyses)for(const observation of JSON.parse(analysis.data).cohort_observations||[]){const key=`${observation.knowledge_key}:${observation.knowledge_hash}`;if(!accepted.has(key))accepted.set(key,{...observation,role:analysis.role});}
      const selectedJobs=selected(db);
      const jobs=[];let reused=0,classified=0;
      for(let i=0;i<selectedJobs.length;i++){
        const j=selectedJobs[i];
        // Recompute derived facts for every content version, including unchanged
        // historical rows. Never mutate raw/jobs/job_versions for a rule upgrade.
        const raw=JSON.parse(j.raw),saved=classificationCache?.get(j.job_key,j.content_hash);
        let observation;
        if(saved){observation=saved;reused++;}
        else{observation=classifyKnowledgeRow(raw);classified++;classificationCache?.put(j.job_key,j.content_hash,observation);}
        const approved=approvedLabels(db,j);
        const analysis=accepted.get(`${j.job_key}:${j.content_hash}`);
        if(analysis){observation.skills=analysis.skills||observation.skills;observation.tasks=analysis.tasks||[];observation.domains=analysis.domains||[];observation.label_source='同内容版本属性标签＋当前岗位专用监督筛选';}
        // Old immutable reports retain their labels, but must not reintroduce a
        // supplemental term whose per-job approval has since been withdrawn.
        if(analysis?.reviewed_term_skills?.length)observation.skills=observation.skills.filter(name=>!analysis.reviewed_term_skills.includes(name)||approved.skills.includes(name)||skillRules.some(([rule])=>rule===name));
        if(approved.skills.length||approved.tasks.length||approved.domains.length){for(const f of ['skills','tasks','domains'])observation[f]=[...new Set([...(observation[f]||[]),...approved[f]])];observation.label_source='岗位规则＋原文验证的人工批准标签';}
        jobs.push({...observation,key:j.job_key,row_no:i+2,job_id:raw.job_id,platform:raw.platform,job_name:raw.job_name,company:raw.company_name||'',company_key:`${raw.platform}:${raw.company_id||raw.company_name||''}`,description:raw.job_description||'',salary_raw:String(raw.salary||''),education_raw:String(raw.education||''),explicitly_closed:raw.is_active===false||raw.status==='已关闭'||raw.status==='已下架',url:raw.job_url||'',source_verified:true,content_hash:j.content_hash});
        if((i+1)%256===0||i===selectedJobs.length-1){
          classificationCache?.checkpoint();signal?.throwIfAborted();
          onProgress?.({phase:'index_classifying',completed:i+1,total:selectedJobs.length,reused,classified,message:`岗位索引 ${Number(i+1).toLocaleString('zh-CN')}/${selectedJobs.length.toLocaleString('zh-CN')} · 复用 ${reused.toLocaleString('zh-CN')} · 新分类 ${classified.toLocaleString('zh-CN')}`});
          await yieldToLoop();
        }
      }
      const governed=admitKnowledgeJobs(jobs);
      assistantCache={jobs:governed,report:{role:'全岗位知识库',generated_at:state.updated_at,knowledge:true,revision:state.revision,roles:[...new Set(governed.filter(j=>j.admission.retrieval).flatMap(j=>j.role_families))].sort(),candidate_rows:jobs.length,data_quality:admissionSummary(governed)},cacheKey,indexBuild:{reused,classified,total:jobs.length}};return assistantCache;
    }finally{db.close();}},
  };
}
const stores=new Map();
export function knowledgeStore(dataDir=defaultKnowledgeDir()){const key=path.resolve(dataDir);if(!stores.has(key))stores.set(key,createKnowledgeStore(key));return stores.get(key);}
