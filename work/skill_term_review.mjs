// Supplementary, per-job technical terms. Never admits jobs or edits the rule dictionary.
import {createHash,randomUUID} from 'node:crypto';
import {skillRules} from './job_knowledge_schema.mjs';

export const TERM_PIPELINE='gliner-skills-review-v1';
export const TERM_MODEL='urchade/gliner_multi-v2.1@443d26d654e0324125a96bebd8e796c14ff2efe6';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const alive=pid=>{if(!Number.isInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}};
const normalized=value=>value.normalize('NFKC').toLowerCase().replace(/\s+/g,'');
const generic=/^(?:技能|技术|工具|平台|框架|数据库|语言|编程|开发|软件|硬件|协议|接口|项目|系统|工作流|应用|自动化|测试|模型|知识库|人工智能|沟通|团队合作|学习能力|计算机|相关专业|本科|硕士|博士|skill|tool|framework|database|platform|software|hardware|object object)$/i;
const negative=/无需|无须|不要求|不需要|不涉及|不必|无需掌握|不作为要求|not\s+required|no\s+need|without\s+(?:using|requiring)/i;
const boilerplateTerm=/^(?:新工具|新框架|AI工具(?:库)?|平台框架|编程语言|智能知识库|行业知识库|图数据库|风险预测Agent|agents?|通信|上位机|云台|HT)$/i;
const heading=/(岗位职责|工作职责|主要职责|工作内容|岗位定位|职位描述|任职要求|职位要求|岗位要求|任职资格|招聘要求|加分项|优先条件|公司介绍|公司简介|关于我们|企业介绍|福利待遇|岗位福利|薪酬福利|Responsibilities|Requirements|Qualifications|About us|Benefits)/gi;

export function skillEvidenceSections(text){
  text=String(text||'');const parts=[];let cursor=0,location='unsectioned';
  for(const m of text.matchAll(heading)){parts.push({start:cursor,end:m.index,location});location=/公司|企业|关于我们|福利|about us|benefits/i.test(m[0])?'excluded':/要求|资格|加分|优先|requirements|qualifications/i.test(m[0])?'requirements':'duties';cursor=m.index+m[0].length;}
  parts.push({start:cursor,end:text.length,location});const sections=[];
  for(const p of parts){if(p.location==='excluded')continue;
    for(const m of text.slice(p.start,p.end).matchAll(/[^。；;\n]+/g)){
      const quote=m[0].trim();const start=p.start+m.index+m[0].indexOf(quote);
      if(quote.length<4||quote.length>1200||negative.test(quote)||/^(?:公司|我们)(?:是|成立|致力于)|^(?:薪资|待遇|福利|五险|招聘人数)/.test(quote))continue;
      if(p.location==='unsectioned'&&!/熟悉|掌握|精通|开发|负责|使用|具备|经验|proficien|experience|develop|familiar/i.test(quote))continue;
      sections.push({start,end:start+quote.length,quote,location:p.location,preferred:/优先|加分|preferred/i.test(quote)});
    }
  }return sections;
}

export function validateSkillCandidate(raw,hit){
  const text=String(raw.job_description||'');const start=hit.start,end=hit.end;
  if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<=start||end>text.length)return null;
  const surface=text.slice(start,end),term=surface.normalize('NFKC').trim();
  if(hit.text!==surface||term!==surface||term.length<2||term.length>48||generic.test(term)||boilerplateTerm.test(term)||!Number.isFinite(hit.score)||hit.score<.5||hit.score>1)return null;
  if(!/^[\p{L}\p{N}][\p{L}\p{N} .+#/_-]*$/u.test(term)||/^\d/.test(term)&&!/[A-Za-z]/.test(term)||/\s{2}|^[\s.]|[\s.]$/.test(term))return null;
  if(/[A-Za-z0-9_]/.test(term[0])&&/[A-Za-z0-9_]/.test(text[start-1]||''))return null;
  if(/[A-Za-z0-9_]/.test(term.at(-1))&&/[A-Za-z0-9_]/.test(text[end]||''))return null;
  if(skillRules.some(([name,re])=>normalized(name)===normalized(term)||re.test(term)))return null;
  const section=skillEvidenceSections(text).find(s=>start>=s.start&&end<=s.end);
  if(!section)return null;
  return {term,term_key:normalized(term),surface,start,end,quote:section.quote,location:section.location,preferred:section.preferred,score:hit.score,entity_type:String(hit.entity_type||'').slice(0,60)};
}

export function createTermReviewMethods({open,openReadOnly,ensure,bump}){
  async function dbOpen(){const db=await open();db.exec(`
    CREATE TABLE IF NOT EXISTS skill_term_scans(job_key TEXT,content_hash TEXT,pipeline TEXT,PRIMARY KEY(job_key,content_hash,pipeline));
    CREATE TABLE IF NOT EXISTS skill_term_candidates(id TEXT PRIMARY KEY,job_key TEXT,content_hash TEXT,pipeline TEXT,state TEXT,data TEXT,created_at TEXT,reviewed_at TEXT);
    CREATE INDEX IF NOT EXISTS skill_terms_job ON skill_term_candidates(job_key,content_hash,state);
    CREATE TABLE IF NOT EXISTS skill_term_runs(id TEXT PRIMARY KEY,owner_pid INTEGER,status TEXT,data TEXT,updated_at TEXT);
  `);return db;}
  const active=`EXISTS(SELECT 1 FROM memberships m JOIN tasks t ON t.task_id=m.task_id WHERE m.job_key=j.job_key AND t.archived=0)`;
  async function access(fn,sync=true,readOnly=false){
    if(sync)await ensure();
    let db;
    if(readOnly&&openReadOnly){
      db=await openReadOnly();
      const ready=db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('skill_term_scans','skill_term_candidates','skill_term_runs')").get().n===3;
      if(!ready){db.close();db=null;}
    }
    db??=await dbOpen();
    try{return await fn(db);}finally{db.close();}
  }
  function currentJob(db,key,hash){return db.prepare(`SELECT j.* FROM jobs j WHERE j.job_key=? AND j.content_hash=? AND ${active}`).get(key,hash);}
  return {
    batch({limit=20,taskId=''}={}){if(!Number.isInteger(limit)||limit<1||limit>50)throw new Error('每批须为1–50条');return access(db=>db.prepare(`SELECT j.job_key,j.content_hash,j.raw FROM jobs j WHERE ${active} AND length(json_extract(j.raw,'$.job_description')) BETWEEN 16 AND 12000 AND NOT EXISTS(SELECT 1 FROM skill_term_scans s WHERE s.job_key=j.job_key AND s.content_hash=j.content_hash AND s.pipeline=?) ${taskId?'AND EXISTS(SELECT 1 FROM memberships m WHERE m.job_key=j.job_key AND m.task_id=?)':''} ORDER BY j.job_key LIMIT ?`).all(TERM_PIPELINE,...(taskId?[taskId]:[]),limit).map(j=>({...j,raw:JSON.parse(j.raw)})));},
    record(job,hits){if(!Array.isArray(hits)||hits.length>300)throw new Error('模型候选结果超限');return access(db=>{
      const current=currentJob(db,job.job_key,job.content_hash);if(!current)return {stale:true,added:0};const raw=JSON.parse(current.raw);let added=0;
      db.exec('BEGIN IMMEDIATE');try{
        for(const hit of hits){const data=validateSkillCandidate(raw,hit);if(!data)continue;
          const id=digest([job.job_key,job.content_hash,TERM_PIPELINE,data.term_key]);
          added+=Number(db.prepare('INSERT OR IGNORE INTO skill_term_candidates VALUES(?,?,?,?,?,?,?,?)').run(id,job.job_key,job.content_hash,TERM_PIPELINE,'pending',JSON.stringify({...data,model:TERM_MODEL}),new Date().toISOString(),null).changes);
        }
        db.prepare('INSERT OR IGNORE INTO skill_term_scans VALUES(?,?,?)').run(job.job_key,job.content_hash,TERM_PIPELINE);db.exec('COMMIT');return {added};
      }catch(e){db.exec('ROLLBACK');throw e;}
    });},
    list({state='pending',limit=50,offset=0,taskId='',synchronize=true}={}){if(!['pending','approved','rejected'].includes(state)||!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(offset)||offset<0)throw new Error('无效候选查询');return access(db=>{
      const from=`FROM skill_term_candidates c JOIN jobs j ON j.job_key=c.job_key AND j.content_hash=c.content_hash WHERE ${active} ${taskId?'AND EXISTS(SELECT 1 FROM memberships m WHERE m.job_key=j.job_key AND m.task_id=?)':''}`;
      const args=taskId?[taskId]:[];const counts=Object.fromEntries(db.prepare(`SELECT c.state,COUNT(*) AS n ${from} GROUP BY c.state`).all(...args).map(r=>[r.state,Number(r.n)]));
      const items=db.prepare(`SELECT c.*,j.raw ${from} AND c.state=? ORDER BY c.created_at,c.id LIMIT ? OFFSET ?`).all(...args,state,limit,offset).map(c=>{const raw=JSON.parse(c.raw);return {id:c.id,job_key:c.job_key,content_hash:c.content_hash,state:c.state,...JSON.parse(c.data),job_name:raw.job_name,company:raw.company_name||'',platform:raw.platform};});return {counts,items,pipeline:TERM_PIPELINE};
    },synchronize,true);},
    review(id,decision){if(!['approved','rejected','pending'].includes(decision))throw new Error('无效复核决定');return access(db=>{
      db.exec('BEGIN IMMEDIATE');try{
        const c=db.prepare('SELECT * FROM skill_term_candidates WHERE id=?').get(id);if(!c)throw new Error('候选不存在');
        const j=currentJob(db,c.job_key,c.content_hash);if(!j)throw new Error('岗位内容已更新或任务已归档，请重新扫描');
        const data=JSON.parse(c.data);if(!validateSkillCandidate(JSON.parse(j.raw),{...data,text:data.surface}))throw new Error('原文证据校验失败');
        const label={skills:[data.term],evidence_json:[{label_type:'skill',label:data.term,quote:data.quote}],source:'本机GLiNER新词＋人工逐条复核',model:TERM_MODEL};
        db.prepare('INSERT OR REPLACE INTO labels VALUES(?,?,?,?,?)').run(`skill-term:${id}`,c.job_key,c.content_hash,decision,JSON.stringify(label));
        db.prepare('UPDATE skill_term_candidates SET state=?,reviewed_at=? WHERE id=?').run(decision,new Date().toISOString(),id);bump(db);db.exec('COMMIT');return {id,state:decision,regenerate_analysis:true};
      }catch(e){db.exec('ROLLBACK');throw e;}
    });},
    beginRun(data){return access(db=>{
      db.exec('BEGIN IMMEDIATE');try{
        for(const run of db.prepare("SELECT * FROM skill_term_runs WHERE status='running'").all()){
          if(alive(Number(run.owner_pid))||alive(JSON.parse(run.data).worker_pid))throw new Error('已有新词扫描正在执行；若服务刚重启，请等待旧模型进程安全退出');
          db.prepare("UPDATE skill_term_runs SET status='interrupted' WHERE id=?").run(run.id);
        }
        const run={id:randomUUID(),status:'running',completed:0,added:0,...data};
        db.prepare('INSERT INTO skill_term_runs VALUES(?,?,?,?,?)').run(run.id,process.pid,run.status,JSON.stringify(run),new Date().toISOString());db.exec('COMMIT');return run;
      }catch(e){db.exec('ROLLBACK');throw e;}
    });},
    updateRun(run){return access(db=>{db.prepare('UPDATE skill_term_runs SET status=?,data=?,updated_at=? WHERE id=?').run(run.status,JSON.stringify(run),new Date().toISOString(),run.id);},false);},
    latestRun(){return access(db=>{const run=db.prepare('SELECT * FROM skill_term_runs ORDER BY updated_at DESC LIMIT 1').get();if(!run)return null;const data=JSON.parse(run.data);let status=run.status;if(status==='running'&&!alive(Number(run.owner_pid)))status=alive(data.worker_pid)?'stopping':'interrupted';return {...data,status};},false,true);},
  };
}
