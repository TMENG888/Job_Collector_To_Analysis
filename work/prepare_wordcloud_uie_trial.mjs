// Offline, read-only experiment. Never imports analysis entry points or syncs the KB.
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {skillRules} from './job_knowledge_schema.mjs';
import {businessRules} from '../job_collector_ui/public/business-rules.js';

const root=path.resolve(import.meta.dirname,'..');
const out=path.join(root,'ui_data/insights/comparisons/uie-wordcloud-20261016');
try{
 await fs.access(path.join(out,'corpus.json'));
 console.log('Frozen corpus already exists; not resampling or overwriting. Use a new experiment directory for a new sample.');
 process.exit(0);
}catch(e){if(e.code!=='ENOENT')throw e;}
const hash=s=>createHash('sha256').update(s).digest('hex');
const source=await fs.readFile(path.join(root,'work/analyze_job_market_sample.mjs'),'utf8');
// Evaluate the exact production function without executing the report generator.
const rules=source.slice(source.indexOf('const generalTaskRules ='),source.indexOf('const cityCoordinates ='));
const extract=source.slice(source.indexOf('function extractLabels('),source.indexOf('function salaryBenchmark('));
if(!rules||!extract||!extract.includes('return { fullText'))throw new Error('Production extractor layout changed');
const baseline=vm.runInNewContext(`function text(v){return v==null?'':String(v).trim();}
function pattern(parts){return new RegExp(parts.join('|'),'i');}
${rules}\n${extract}\nextractLabels`,{skillRules,businessRules});
const protectedPaths=['work/analyze_job_market_sample.mjs','work/job_knowledge_schema.mjs','job_collector_ui/public/business-rules.js','job_collector_ui/public/insight-cohorts.js','job_collector_ui/public/insight-profile-charts.js'];
const protectedHashes=Object.fromEntries(await Promise.all(protectedPaths.map(async p=>[p,hash(await fs.readFile(path.join(root,p)))])));
const db=new DatabaseSync(path.join(root,'ui_data/knowledge/岗位知识库.sqlite'),{readOnly:true});
let candidates;
try{
 db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000');
 candidates=db.prepare(`SELECT j.job_key,j.content_hash,j.raw FROM jobs j WHERE EXISTS
 (SELECT 1 FROM memberships m JOIN tasks t ON m.task_id=t.task_id WHERE m.job_key=j.job_key AND t.archived=0)`)
 .all().map(j=>({...j,raw:JSON.parse(j.raw)}));
}finally{db.close();}
const families=[
 ['智能体/大模型应用',/智能体|大模型|LLM|Agent/i],
 ['嵌入式开发',/嵌入式|单片机|固件/],
 ['测试工程',/软件测试|测试工程师|测试开发/],
 ['数据分析',/数据分析|数据挖掘/],
 ['销售工程',/销售工程师|技术销售/],
];
const docs=[],seenBody=new Set(),seenCompany=new Set(),counts={};
for(const [family,re]of families){
 const pool=candidates.filter(j=>re.test(j.raw.job_name)&&String(j.raw.job_description||'').length>=150&&String(j.raw.job_description||'').length<=1800)
 .sort((a,b)=>hash(a.job_key).localeCompare(hash(b.job_key)));
 counts[family]={eligible:pool.length,selected:0};
 for(const j of pool){
  const body=String(j.raw.job_description),bodyKey=hash(body.normalize('NFKC').replace(/\s/g,''));
  const company=String(j.raw.company_name||j.raw.company_id||j.job_key).normalize('NFKC');
  if(seenBody.has(bodyKey)||seenCompany.has(company))continue;
  seenBody.add(bodyKey);seenCompany.add(company);
  const raw={'岗位名称':j.raw.job_name,'技能':j.raw.skills||'','岗位描述':body,'行业':j.raw.industry||''};
  const labels=baseline(raw,family);
  docs.push({id:`real-${String(docs.length+1).padStart(2,'0')}`,kind:'real',split:counts[family].selected===0?'development':'holdout',family,
    job_key:j.job_key,content_hash:j.content_hash,platform:j.raw.platform,title:j.raw.job_name,
    industry:j.raw.industry||'',text:labels.fullText,baseline:{skills:labels.skills,tasks:labels.tasks,domains:labels.domains}});
  if(++counts[family].selected===4)break;
 }
}
await fs.mkdir(out,{recursive:true});
const manifest={created_at:new Date().toISOString(),source:'read-only native SQLite, active task memberships',source_jobs:candidates.length,
 selection:'stable SHA256(job_key) order; title-stratified; full JD 150–1800 chars; unique company and exact normalized JD; 1 development + 3 holdout/family',
 family_counts:counts,protected_hashes:protectedHashes,privacy:'No resume, credentials or raw company/account identifiers exported. JDs remain local; only public model files downloaded.',
 limitations:['Small pilot, not a population accuracy estimate','Labels require reviewer judgement; no independent double annotation','Company industry field may contain occupation taxonomy; preserve provenance, do not assume ground truth']};
await fs.writeFile(path.join(out,'corpus.json'),JSON.stringify({manifest,docs},null,2));
console.log(JSON.stringify({out,manifest,docs:docs.map(d=>({id:d.id,family:d.family,split:d.split,title:d.title,text:d.text,industry:d.industry,baseline:d.baseline}))},null,2));
