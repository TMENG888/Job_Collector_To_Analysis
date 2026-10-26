// Freeze a source-versioned pilot before reading candidate model predictions.
import fs from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {dutiesOf} from './keyword-role-matcher.mjs';
import {matchUniversalRoleKeywords} from './universal-role-keywords.mjs';
const root=path.resolve(import.meta.dirname,'..');
const out=path.join(root,'ui_data/insights/comparisons/role-screening-20261016');
try{await fs.access(path.join(out,'corpus.json'));console.log('Frozen corpus exists; not resampling');process.exit(0);}catch(e){if(e.code!=='ENOENT')throw e;}
const hash=x=>createHash('sha256').update(x).digest('hex');
const norm=x=>String(x||'').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}\d]/gu,'');
const reportFile=path.join(root,'ui_data/insights/岗位市场洞察.json');const reportText=await fs.readFile(reportFile,'utf8'),report=JSON.parse(reportText);
if(report.role!=='数据分析'||report.selection_contract!=='universal-keywords-v1')throw new Error('Expected frozen data-analysis baseline');
const db=new DatabaseSync(path.join(root,'ui_data/knowledge/岗位知识库.sqlite'),{readOnly:true});let source;
try{db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000');const snapshot=db.prepare('SELECT rows_json FROM snapshots WHERE snapshot_id=?').get(new URL(report.knowledge_snapshot).pathname.slice(1));if(!snapshot)throw new Error('Snapshot missing');source=JSON.parse(snapshot.rows_json);}finally{db.close();}
const baseModel={keywords:report.keyword_selection.keywords,minimum_hits:report.keyword_selection.minimum_hits,display_name:'生产冻结关键词版',version:report.keyword_selection.version};
const pool=source.map(raw=>{const row={'岗位名称':raw.job_name,'岗位描述':raw.job_description};const text=String(raw.job_description||'');return {key:raw.knowledge_key,content_hash:raw.knowledge_hash,title:raw.job_name,platform:raw.platform,company_group:hash(norm(raw.company_name||raw.company_id)||raw.knowledge_key),body:text,body_normalized:norm(text),duties:dutiesOf(row),baseline:matchUniversalRoleKeywords(row,baseModel)};});
const eligible=pool.filter(d=>d.body.length>=80&&d.body.length<=9000);
const grams=text=>new Set(Array.from({length:Math.max(0,text.length-4)},(_,i)=>text.slice(i,i+5)));
function near(a,b){if(Math.min(a.body_normalized.length,b.body_normalized.length)/Math.max(a.body_normalized.length,b.body_normalized.length)<.75)return false;let intersection=0;const small=a.grams.size<b.grams.size?a.grams:b.grams,big=small===a.grams?b.grams:a.grams;for(const x of small)if(big.has(x))intersection++;return intersection/(a.grams.size+b.grams.size-intersection)>=.8;}
const selected=[],counts={};let rejectedCompany=0,rejectedNear=0;
function take(split,filter,n,salt){
  let count=0;
  for(const d of eligible.filter(filter).sort((a,b)=>hash(salt+a.key).localeCompare(hash(salt+b.key)))){
    if(selected.some(s=>s.company_group===d.company_group)){rejectedCompany++;continue;}
    const candidate={...d,grams:grams(d.body_normalized)};
    if(selected.some(s=>near(s,candidate))){rejectedNear++;continue;}
    selected.push({...candidate,split,selection_group:salt});if(++count>=n)break;
  }
  if(count!==n)throw new Error(`Insufficient ${salt}: ${count}/${n}`);counts[salt]=count;
}
const targetTitle=d=>/数据分析|商业分析|经营分析|业务分析/.test(d.title);
take('test_random',()=>true,100,'random-20261016');
take('train',targetTitle,20,'train-title-positive');take('train',d=>!targetTitle(d),20,'train-title-negative');
take('validation',targetTitle,10,'val-title-positive');take('validation',d=>!targetTitle(d),10,'val-title-negative');
take('test_challenge',d=>d.baseline.matched&&!targetTitle(d),20,'challenge-included-adjacent');
take('test_challenge',d=>!d.baseline.matched&&targetTitle(d),10,'challenge-excluded-title');
take('test_challenge',d=>/数据开发|运营|爬虫|测试|分析员|实验|会计|财务|审计|算法/.test(d.title)&&!targetTitle(d),10,'challenge-neighbours');
const docs=selected.map(({grams,body_normalized,...d},i)=>({id:`R${String(i+1).padStart(3,'0')}`,...d}));
const protectedPaths=['work/analyze_job_market_sample.mjs','work/universal-role-keywords.mjs','work/job_knowledge_store.mjs','ui_data/insights/岗位市场洞察.json'];
const manifest={created_at:new Date().toISOString(),target:'数据分析：以分析为核心主职责，非仅使用SQL/Python或分析辅助自身运营执行',source_snapshot:report.knowledge_snapshot,source_revision:report.knowledge_revision,source_rows:source.length,eligible_rows:eligible.length,excluded_quality_rows:source.length-eligible.length,counts,rejectedCompany,rejectedNear,selection:'stable SHA256 order; random test selected first; unique normalized company across all splits; reject normalized 5-gram Jaccard>=0.8 near-JDs across all splits; title/baseline stratification only selects development/challenge, never reference labels',random_scope:'random source ordering followed by company/near-JD uniqueness; not an unbiased job-weighted estimate for the full database',annotation:'pending independent-of-prediction Codex source-evidence review; NOT human gold',protected_hashes:Object.fromEntries(await Promise.all(protectedPaths.map(async p=>[p,hash(await fs.readFile(path.join(root,p)))]))),baseline_keywords:baseModel};
await fs.mkdir(out,{recursive:true});await fs.writeFile(path.join(out,'corpus.json'),JSON.stringify({manifest,docs},null,2));
await fs.writeFile(path.join(out,'review-blind.json'),JSON.stringify(docs.map(d=>({id:d.id,title:d.title,body:d.body})),null,2));
console.log(JSON.stringify({out,manifest},null,2));
