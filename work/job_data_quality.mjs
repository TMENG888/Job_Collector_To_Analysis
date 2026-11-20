import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {isMainThread,parentPort,workerData} from 'node:worker_threads';
import {normalizeSalary} from './job_knowledge_schema.mjs';
import {parseOriginalSalary} from './job_salary_parser.mjs';
import {provinceName,experienceGroup} from '../job_collector_ui/public/insight-groups.js';

export const QUALITY_VERSION='job-quality-v1-20261119';
const blank=value=>!String(value??'').trim()||/^(?:未明确|未提供|未知|暂无|无|null|undefined|none|n\/a|[-—–]+)$/i.test(String(value).trim());
const plain=value=>String(value??'').replace(/<[^>]*>/g,' ').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();
const sha=value=>createHash('sha256').update(value).digest('hex');
const safeUrl=value=>{try{const u=new URL(value);return ['https:','http:'].includes(u.protocol)?u.href:'';}catch{return '';}};
const sumEmpty=()=>({input:0,invalid:0,duplicates:0,unique:0,inserted:0,updated:0,unchanged:0});
const platformName=value=>({zhaopin:'智联招聘',shixiseng:'实习僧',iguopin:'国聘',jobonline:'就业在线',mohrss:'公共招聘网',job51:'前程无忧'}[value]||value||'未明确');
export const qualityIssueNames={body_missing:'岗位正文缺失',body_short:'岗位正文过短',body_error:'正文疑似登录或错误提示',title_missing:'岗位名称缺失',company_missing:'公司名称缺失',region_unmapped:'地区无法映射',salary_unparsed:'薪资文本无法解析',salary_outlier:'薪资超出图表统计范围',education_unparsed:'学历表达未识别',experience_unparsed:'经验表达未识别',date_unparsed:'发布时间无法解析',date_future:'发布时间晚于入库时间',same_content:'疑似内容重复',invalid_json:'原始记录格式异常'};

function publication(raw){
  const value=raw.publish_time??raw.published_at??raw.publish_date??raw.publication_date??raw['发布时间']??raw['发布日期'];
  if(blank(value))return {raw:'',timestamp:null};
  let timestamp=null;
  if(typeof value==='number'&&value>1e9)timestamp=value<1e12?value*1000:value;
  else if(/^\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}/.test(String(value))){const parsed=Date.parse(String(value).replace(/年|\//g,'-').replace(/月/g,'-').replace(/日/g,''));if(Number.isFinite(parsed))timestamp=parsed;}
  return {raw:String(value),timestamp};
}

export function buildJobQuality(database,{taskId='all',platform='all',reportId=randomUUID(),now=new Date().toISOString()}={}){
  const db=new DatabaseSync(database,{readOnly:true});db.exec('PRAGMA busy_timeout=5000; BEGIN');
  try{
    const exists=name=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    const revision=Number(db.prepare("SELECT value FROM metadata WHERE key='revision'").get()?.value||0);
    const tasks=db.prepare(`SELECT t.task_id AS id,t.label,COUNT(m.job_key) AS rows FROM tasks t LEFT JOIN memberships m ON m.task_id=t.task_id WHERE t.archived=0 GROUP BY t.task_id ORDER BY t.label`).all();
    if(taskId!=='all'&&!tasks.some(t=>t.id===taskId))throw Error('采集任务不存在或已归档');
    const membership=`EXISTS (SELECT 1 FROM memberships m JOIN tasks t ON t.task_id=m.task_id WHERE m.job_key=j.job_key AND t.archived=0${taskId==='all'?'':' AND m.task_id=?'})`;
    const taskArgs=taskId==='all'?[]:[taskId];
    const platforms=db.prepare(`SELECT j.platform,COUNT(*) AS rows FROM jobs j WHERE ${membership} GROUP BY j.platform ORDER BY rows DESC`).all(...taskArgs);
    if(platform!=='all'&&!platforms.some(p=>p.platform===platform))throw Error('所选范围没有此平台的数据');
    const filter=`${membership}${platform==='all'?'':' AND j.platform=?'}`,args=[...taskArgs,...(platform==='all'?[]:[platform])];
    const rows=db.prepare(`SELECT j.* FROM jobs j WHERE ${filter} ORDER BY j.job_key`).iterate(...args);
    const fieldNames={identity:'平台与岗位ID',title:'岗位名称',body:'可用正文',company:'公司名称',location:'工作地点',salary:'薪资文本',education:'学历要求',experience:'经验要求',published:'发布时间'};
    const fresh=()=>({rows:0,fields:Object.fromEntries(Object.keys(fieldNames).map(k=>[k,0])),salary:{provided:0,negotiable:0,numericProvided:0,parsed:0,failed:0,monthly:0,dailyConverted:0,inferredMonthly:0,usable:0},usable:{jobs:0,salary:0,province:0,body:0,ruleSkills:0,approvedSkills:0,publication:0,classifierIncluded:0,classifierReview:0},issues:{}});
    const all=fresh(),perPlatform=new Map(),samples=[],sampleCounts=new Map(),problemKeys=new Set(),content=new Map(),classifierVersions=new Set(),normalizations=[],exampleCounts=new Map();
    function example(record,kind,original,result,basis){const count=exampleCounts.get(kind)||0;if(count>=4)return;exampleCounts.set(kind,count+1);normalizations.push({key:record.job_key,jobId:record.job_id,title:record.title,platform:record.platform,kind,original:String(original),result,basis});}
    const labels=new Map();
    if(exists('labels'))for(const row of db.prepare(`SELECT l.job_key,l.data FROM labels l JOIN jobs j ON j.job_key=l.job_key AND j.content_hash=l.content_hash WHERE l.state='approved' AND ${filter}`).iterate(...args)){
      try{const label=JSON.parse(row.data);if(Array.isArray(label.skills)&&label.skills.length)labels.set(row.job_key,[...(labels.get(row.job_key)||[]),label]);}catch{}
    }
    function issue(record,type,field,original,normalized,handling){
      for(const group of [all,perPlatform.get(record.platform)])group.issues[type]=(group.issues[type]||0)+1;
      problemKeys.add(record.job_key);
      const bucket=record.platform+'|'+type,count=sampleCounts.get(bucket)||0;sampleCounts.set(bucket,count+1);
      if(count>=20)return;
      samples.push({id:sha([record.job_key,record.content_hash,type].join('|')),type,name:qualityIssueNames[type],key:record.job_key,contentHash:record.content_hash,platform:record.platform,jobId:record.job_id,title:record.title||'未提供名称',company:record.company||'未明确',field,original:String(original??'').slice(0,1600),normalized:String(normalized??''),handling,url:safeUrl(record.url),state:'pending'});
    }
    for(const row of rows){
      if(!perPlatform.has(row.platform))perPlatform.set(row.platform,fresh());
      const groups=[all,perPlatform.get(row.platform)];for(const group of groups)group.rows++;
      let raw,observation;
      try{raw=JSON.parse(row.raw);if(!raw||Array.isArray(raw)||typeof raw!=='object')throw Error();}catch{issue(row,'invalid_json','原始记录',row.raw,'无法解析','保留原记录，等待修复来源');continue;}
      try{observation=JSON.parse(row.observation)||{};}catch{observation={};}
      const body=plain(raw.job_description),title=String(raw.job_name||''),company=String(raw.company_name||''),salaryRaw=String(raw.salary||''),location=String(raw.city||'');
      const record={...row,title,company,url:raw.job_url};
      const errorBody=body.length<500&&/^(?:请先登录|登录后(?:查看|可见)|访问(?:失败|被拒绝)|请求失败|系统繁忙|验证码|安全验证|403\b|404\b|502\b)|^(?:error|access denied|forbidden)\b/i.test(body);
      const usableBody=body.length>=16&&!errorBody;
      const salaryProvided=!blank(salaryRaw),negotiable=salaryProvided&&/面议|保密|待定/.test(salaryRaw);
      const parsed=salaryProvided&&!negotiable?parseOriginalSalary(salaryRaw):null,monthly=parsed?normalizeSalary(salaryRaw):null;
      const salaryUsable=!!monthly&&monthly.midpoint/1000>=(monthly.converted?Number.MIN_VALUE:3)&&monthly.midpoint/1000<=200;
      const province=provinceName({province:raw.province,city:location}),degree=String(raw.education||''),experience=String(raw.experience||'');
      const degreeKnown=!blank(degree)&&/博士|硕士|研究生|本科|大专|专科|中专|中技|高中|初中|小学|不限|无学历要求/.test(degree);
      const exp=experienceGroup(experience),expKnown=!blank(experience)&&exp!=='未明确';
      const published=publication(raw),identity=!!row.platform&&!!row.job_id;
      const future=published.timestamp!=null&&published.timestamp>Date.parse(row.updated_at)+86400000;
      const approved=(labels.get(row.job_key)||[]).some(label=>label.skills.some(skill=>(label.evidence_json||[]).some(e=>['skill','技能'].includes(e.label_type)&&e.label===skill&&String(e.quote||'').length>=2&&[title,raw.skills,raw.job_description].join('\n').includes(e.quote))));
      const included=observation.decision==='include',review=observation.decision==='review';
      if(monthly)example(record,monthly.converted?'日薪折算':'月薪规范化',salaryRaw,`${monthly.min.toFixed(2)}—${monthly.max.toFixed(2)} 元/月；中点 ${monthly.midpoint.toFixed(2)} 元`,monthly.basis);
      if(negotiable)example(record,'面议保留',salaryRaw,'薪资数值为空','不填成0，不进入数值薪资统计');
      if(province!=='未明确')example(record,'地区规范化',location,province,'沿用岗位洞察的省份映射');
      if(degreeKnown)example(record,'学历识别',degree,degree.match(/不限|无学历要求/)?.[0]?'学历不限':degree.match(/博士|硕士|研究生|本科|大专|专科|中专|中技|高中|初中|小学/)?.[0],'保留原始要求；缺失不视为不限');
      if(expKnown)example(record,'经验分组',experience,exp,'沿用岗位洞察的经验区间');
      for(const [family,evidence]of Object.entries(observation.role_evidence?.supervised||{}))classifierVersions.add(family+':'+(evidence.artifact_sha256||evidence.model_version||evidence.version||'版本未留存'));
      const values={identity,title:!blank(title),body:usableBody,company:!blank(company),location:!blank(location),salary:salaryProvided,education:degreeKnown,experience:expKnown,published:published.timestamp!=null&&!future};
      for(const group of groups){
        for(const [key,valid]of Object.entries(values))if(valid)group.fields[key]++;
        const s=group.salary,u=group.usable;
        if(salaryProvided)s.provided++;if(negotiable)s.negotiable++;if(salaryProvided&&!negotiable)s.numericProvided++;if(parsed)s.parsed++;if(salaryProvided&&!negotiable&&!parsed)s.failed++;
        if(monthly)s.monthly++;if(monthly?.converted)s.dailyConverted++;if(parsed?.period_inferred)s.inferredMonthly++;if(salaryUsable)s.usable++;
        if(identity&&!blank(title))u.jobs++;if(salaryUsable)u.salary++;if(!['未明确','全国/地点不限','多省份','海外'].includes(province))u.province++;
        if(usableBody)u.body++;if(usableBody&&observation.skills?.length)u.ruleSkills++;if(usableBody&&approved)u.approvedSkills++;if(values.published)u.publication++;if(included)u.classifierIncluded++;if(review)u.classifierReview++;
      }
      if(blank(title))issue(record,'title_missing','岗位名称',title,'未提供','保留记录，暂不计入岗位数量可用样本');
      if(!body)issue(record,'body_missing','岗位正文','','正文缺失','保留列表记录，等待补采详情；不进入技能提取');
      else if(errorBody)issue(record,'body_error','岗位正文',body,'疑似访问提示','等待人工核查或补采；不进入技能提取');
      else if(!usableBody)issue(record,'body_short','岗位正文',body,'正文不足16字','保留记录，暂不进入技能提取');
      if(blank(company))issue(record,'company_missing','公司名称',company,'未明确','保留岗位，不计入可识别公司排行');
      if(!blank(location)&&province==='未明确')issue(record,'region_unmapped','工作地点',location,'未明确','保留原值，暂不进入省份对比');
      if(salaryProvided&&!negotiable&&!parsed)issue(record,'salary_unparsed','薪资',salaryRaw,'解析失败','保留原值，不进入数值薪资统计');
      if(monthly&&!salaryUsable)issue(record,'salary_outlier','薪资',salaryRaw,`月薪中点 ${monthly.midpoint.toFixed(2)} 元`,'仅标记待核；当前图表范围：月薪3K至200K，日薪折算允许低于3K');
      if(!blank(degree)&&!degreeKnown)issue(record,'education_unparsed','学历',degree,'未明确','保留原始表达，不当作学历不限');
      if(!blank(experience)&&!expKnown)issue(record,'experience_unparsed','经验',experience,'未明确','保留原始表达，不当作经验不限');
      if(published.raw&&published.timestamp==null)issue(record,'date_unparsed','发布时间',published.raw,'无法可靠解析','相对时间缺少原始采集锚点时，不推断发布日期');
      if(future)issue(record,'date_future','发布时间',published.raw,'晚于入库时间超过1天','保留原值，暂不进入发布时间分析');
      if(usableBody&&!blank(company)&&!blank(title)){
        const signature=sha([company,title,location,body.replace(/\s/g,'')].join('|'));
        const first=content.get(signature);
        if(first){if(!first.marked){issue(first.record,'same_content','岗位内容',first.record.title,'公司、标题、地点和正文相同','疑似重复，保留各平台岗位ID，不自动合并');first.marked=true;}issue(record,'same_content','岗位内容',title,'公司、标题、地点和正文相同','疑似重复，保留各平台岗位ID，不自动合并');}
        else content.set(signature,{record:{job_key:row.job_key,content_hash:row.content_hash,job_id:row.job_id,platform:row.platform,title,company,url:raw.job_url},marked:false});
      }
    }
    const ingestion={available:exists('ingestion_batches'),totals:sumEmpty(),batches:[],firstRecordedAt:null,quarantineSamples:[],note:'仅统计已留痕的入库处理条次；同一岗位可在多批重复处理，不能与当前去重岗位数直接相加。历史批次未留痕。'};
    if(ingestion.available){
      for(const batch of db.prepare(`SELECT b.*,t.label FROM ingestion_batches b JOIN tasks t ON t.task_id=b.task_id WHERE t.archived=0${taskId==='all'?'':' AND b.task_id=?'} ORDER BY b.created_at DESC,b.batch_id`).iterate(...taskArgs)){
        const rawStats=JSON.parse(batch.stats),stats=platform==='all'?rawStats:rawStats.platforms?.[platform];if(!stats)continue;
        for(const key of Object.keys(ingestion.totals))ingestion.totals[key]+=Number(stats[key]||0);
        ingestion.firstRecordedAt=batch.created_at;
        if(ingestion.batches.length<20)ingestion.batches.push({id:batch.batch_id,taskId:batch.task_id,label:batch.label,createdAt:batch.created_at,...Object.fromEntries(Object.keys(ingestion.totals).map(k=>[k,Number(stats[k]||0)]))});
      }
      if(exists('ingestion_rejections'))for(const row of db.prepare(`SELECT r.*,b.created_at,t.label FROM ingestion_rejections r JOIN ingestion_batches b ON b.batch_id=r.batch_id JOIN tasks t ON t.task_id=b.task_id WHERE t.archived=0${taskId==='all'?'':' AND b.task_id=?'} ORDER BY b.created_at DESC LIMIT 100`).all(...taskArgs)){
        const raw=JSON.parse(row.raw),sourcePlatform=platformName(raw.platform||raw['平台']);if(platform!=='all'&&sourcePlatform!==platform)continue;
        ingestion.quarantineSamples.push({id:row.rejection_id,batchId:row.batch_id,reason:row.reason,createdAt:row.created_at,label:row.label,platform:sourcePlatform,jobId:raw.job_id||raw['岗位ID']||'未提供',title:raw.job_name||raw['岗位名称']||'未提供'});
      }
    }
    const fields=Object.entries(fieldNames).map(([key,name])=>({key,name,valid:all.fields[key],missing:all.rows-all.fields[key],total:all.rows,rate:all.rows?all.fields[key]/all.rows:null}));
    return {id:reportId,version:QUALITY_VERSION,createdAt:now,revision,scope:{taskId,platform,label:taskId==='all'?'全岗位知识库':tasks.find(t=>t.id===taskId).label},tasks,platforms,total:all.rows,problemJobs:problemKeys.size,fields,salary:all.salary,usable:all.usable,platformQuality:[...perPlatform].map(([name,value])=>({name,...value})).sort((a,b)=>b.rows-a.rows),issues:Object.entries(all.issues).map(([type,count])=>({type,name:qualityIssueNames[type],count,sampled:samples.filter(s=>s.type===type).length})),samples,normalizations,ingestion,
      provenance:{rulesVersion:QUALITY_VERSION,salaryParserSha256:sha(readFileSync(new URL('./job_salary_parser.mjs',import.meta.url))),normalizationSha256:sha(readFileSync(new URL('../job_collector_ui/public/insight-groups.js',import.meta.url))),classifierVersions:[...classifierVersions].sort(),samplePolicy:'每个平台、每类问题最多保留20条样例；问题数量按全部岗位计算，同一岗位可有多项问题。',scopePolicy:'同平台＋岗位ID去重；只读取未归档任务关联的当前已提交版本；检查期间固定数据库读快照。',classificationPolicy:'分类纳入与待核取自入库时的分类观察，不表示当前模型评估结果；报告不启动分类器训练、重标或外部API。',salaryPolicy:'薪资解析率分母为提供非面议薪资文本的岗位；月薪取区间中点，日薪按21.75天折算。图表口径为月薪3K至200K，日薪折算允许低于3K。',publicationPolicy:'只使用明确的发布时间；入库更新时间不充当发布时间。此报告不证明平台数据已采集穷尽。'}};
  }finally{db.exec('ROLLBACK');db.close();}
}

if(!isMainThread&&workerData?.kind==='job-quality'){
  try{parentPort.postMessage({ok:true,report:buildJobQuality(workerData.database,workerData.options)});}
  catch(error){parentPort.postMessage({ok:false,error:String(error.message).slice(0,300)});}
}
