// Offline experiment only. Reuse reviewed pilots as development data, never as new test.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
import {dutiesOf} from './keyword-role-matcher.mjs';
import {matchUniversalRoleKeywords} from './universal-role-keywords.mjs';
const root=path.resolve(import.meta.dirname,'..');
const out=path.join(root,'ui_data/insights/comparisons/codex-classifier-20261016');
const oldDir=path.join(root,'ui_data/insights/comparisons/role-screening-20261016');
const crossDir=path.join(root,'ui_data/insights/comparisons/role-crossencoder-20261016');
const hash=x=>createHash('sha256').update(x).digest('hex');
const norm=x=>String(x||'').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}\d]/gu,'');
const grams=s=>new Set(Array.from({length:Math.max(0,s.length-4)},(_,i)=>s.slice(i,i+5)));
const aug=d=>({...d,normalized:norm(d.body),grams:grams(norm(d.body))});
try{await fs.access(path.join(out,'corpus.json'));throw Error('Corpus sealed, refuse overwrite');}catch(e){if(e.code!=='ENOENT')throw e;}
const oldBytes=await fs.readFile(path.join(oldDir,'corpus.json')),old=JSON.parse(oldBytes);
const crossBytes=await fs.readFile(path.join(crossDir,'fresh-corpus.json')),cross=JSON.parse(crossBytes);
const oldRef=JSON.parse(await fs.readFile(path.join(oldDir,'reference-labels.json')));
const crossRef=JSON.parse(await fs.readFile(path.join(crossDir,'fresh-reference-labels.json')));
assert.equal(oldRef.corpus_sha256,hash(oldBytes));assert.equal(crossRef.corpus_sha256,hash(crossBytes));
const labels=new Map([...oldRef.records,...crossRef.records].map(r=>[r.id,r]));
const previous=[...old.docs,...cross.docs];
const validation=new Set();
for(const label of ['core','negative']){
 const candidates=previous.filter(d=>labels.get(d.id).label!=='uncertain'&&(labels.get(d.id).label==='core'?'core':'negative')===label)
  .sort((a,b)=>hash('codex-dev-split-v1'+a.key).localeCompare(hash('codex-dev-split-v1'+b.key)));
 for(const d of candidates.slice(0,Math.round(candidates.length*.2)))validation.add(d.id);
}
const development=previous.map(d=>({...d,original_split:d.split,split:labels.get(d.id).label==='uncertain'?'review_only':validation.has(d.id)?'validation':'train',origin:'previous_reviewed_pilots'}));
let source;const db=new DatabaseSync(path.join(root,'ui_data/knowledge/岗位知识库.sqlite'),{readOnly:true});
try{db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000');source=JSON.parse(db.prepare('SELECT rows_json FROM snapshots WHERE snapshot_id=?').get(new URL(old.manifest.source_snapshot).pathname.slice(1)).rows_json);}finally{db.close();}
const pool=source.filter(r=>String(r.job_description||'').length>=80&&String(r.job_description||'').length<=9000).map(r=>{
 const row={'岗位名称':r.job_name,'岗位描述':r.job_description};return {key:r.knowledge_key,content_hash:r.knowledge_hash,title:r.job_name,platform:r.platform,
 company_group:hash(norm(r.company_name||r.company_id)||r.knowledge_key),body:r.job_description,duties:dutiesOf(row),baseline:matchUniversalRoleKeywords(row,old.manifest.baseline_keywords)};
});
const blocked=previous.map(aug),companies=new Set(previous.map(d=>d.company_group)),selected=[];
function near(a,b){if(Math.min(a.normalized.length,b.normalized.length)/Math.max(a.normalized.length,b.normalized.length)<.75)return false;let n=0;for(const g of a.grams)if(b.grams.has(g))n++;return n/(a.grams.size+b.grams.size-n)>=.8;}
function take(split,filter,n,salt){let count=0;for(const d of pool.filter(filter).sort((a,b)=>hash(salt+a.key).localeCompare(hash(salt+b.key)))){
 if(companies.has(d.company_group))continue;const candidate=aug(d);if(blocked.some(b=>near(candidate,b)))continue;
 selected.push({...d,split,selection_group:salt,origin:'new_blind_review'});blocked.push(candidate);companies.add(d.company_group);if(++count===n)break;
}assert.equal(count,n,salt);}
// Random test first. Enrichment is explicitly separate and cannot represent prevalence.
take('test_random',()=>true,80,'codex-v2-test-random');
const analysis=d=>/数据分析|商业分析|经营分析|统计分析|BI分析/.test(d.title);
const ops=d=>/电商|店铺|天猫|京东|亚马逊|淘宝/.test(d.title)&&/运营/.test(d.title);
const engineering=d=>/数据开发|数据工程|数仓|数据仓库|ETL|大数据开发/i.test(d.title);
take('test_challenge',analysis,16,'codex-v2-test-analysis');
take('test_challenge',ops,12,'codex-v2-test-ops');
take('test_challenge',engineering,12,'codex-v2-test-engineering');
take('train',analysis,40,'codex-v2-train-analysis');
take('train',ops,10,'codex-v2-train-ops');
take('train',engineering,10,'codex-v2-train-engineering');
const fresh=selected.map((d,i)=>({id:'N'+String(i+1).padStart(3,'0'),...d}));
const manifest={created_at:new Date().toISOString(),target:'数据分析',source_snapshot:old.manifest.source_snapshot,source_revision:old.manifest.source_revision,
 source_rows:source.length,eligible_rows:pool.length,baseline_keywords:old.manifest.baseline_keywords,protected_hashes:old.manifest.protected_hashes,
 old_corpus_sha256:hash(oldBytes),cross_corpus_sha256:hash(crossBytes),
 sampling:'Previously seen 300 are development only (80/20 known-label stratified split); new120 test = company-unique stable-hash random80 plus title-targeted40; new60 training enrichment. All480 companies unique and near-JD Jaccard5gram<.8. Random is company-capped, not unbiased job-frequency sample.',
 annotation:'Codex evidence labels, pending independent human review. Not human gold. New labels fixed before candidate inference. Scope: primary statistical/business analysis/BI/forecasting, not incidental analytics, engineering pipelines or qualitative research.'};
await fs.mkdir(out,{recursive:true});
await fs.writeFile(path.join(out,'corpus.json'),JSON.stringify({manifest,docs:[...development,...fresh]},null,2));
await fs.writeFile(path.join(out,'inherited-labels.json'),JSON.stringify({annotation:'Prior Codex review; reused as development only',records:[...labels.values()]},null,2));
await fs.writeFile(path.join(out,'review-blind.json'),JSON.stringify(fresh.map(d=>({id:d.id,title:d.title,body:d.body})),null,2));
console.log(JSON.stringify({manifest,splits:[...development,...fresh].reduce((a,d)=>(a[d.split]=(a[d.split]||0)+1,a),{})},null,2));
