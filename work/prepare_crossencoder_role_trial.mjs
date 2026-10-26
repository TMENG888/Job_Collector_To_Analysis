// Freeze fresh evaluation records, company- and near-JD-disjoint from the first pilot.
import fs from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {dutiesOf} from './keyword-role-matcher.mjs';
import {matchUniversalRoleKeywords} from './universal-role-keywords.mjs';
const root=path.resolve(import.meta.dirname,'..');
const oldDir=path.join(root,'ui_data/insights/comparisons/role-screening-20261016');
const out=path.join(root,'ui_data/insights/comparisons/role-crossencoder-20261016');
try{await fs.access(path.join(out,'fresh-corpus.json'));console.log('Fresh corpus already frozen');process.exit(0);}catch(e){if(e.code!=='ENOENT')throw e;}
const oldBytes=await fs.readFile(path.join(oldDir,'corpus.json')),old=JSON.parse(oldBytes);
const hash=x=>createHash('sha256').update(x).digest('hex');
const norm=x=>String(x||'').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}\d]/gu,'');
const grams=s=>new Set(Array.from({length:Math.max(0,s.length-4)},(_,i)=>s.slice(i,i+5)));
const augmented=d=>({...d,normalized:norm(d.body),grams:grams(norm(d.body))});
const selected=[],blocked=old.docs.map(augmented),companies=new Set(old.docs.map(d=>d.company_group));
const db=new DatabaseSync(path.join(root,'ui_data/knowledge/岗位知识库.sqlite'),{readOnly:true});let source;
try{db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000');const snapshot=db.prepare('SELECT rows_json FROM snapshots WHERE snapshot_id=?').get(new URL(old.manifest.source_snapshot).pathname.slice(1));assert.ok(snapshot);source=JSON.parse(snapshot.rows_json);}finally{db.close();}
function near(a,b){if(Math.min(a.normalized.length,b.normalized.length)/Math.max(a.normalized.length,b.normalized.length)<.75)return false;let n=0;for(const g of a.grams)if(b.grams.has(g))n++;return n/(a.grams.size+b.grams.size-n)>=.8;}
const base=old.manifest.baseline_keywords;
const pool=source.filter(r=>String(r.job_description||'').length>=80&&String(r.job_description||'').length<=9000).map(r=>{
 const row={'岗位名称':r.job_name,'岗位描述':r.job_description};return {key:r.knowledge_key,content_hash:r.knowledge_hash,title:r.job_name,platform:r.platform,company_group:hash(norm(r.company_name||r.company_id)||r.knowledge_key),body:r.job_description,duties:dutiesOf(row),baseline:matchUniversalRoleKeywords(row,base)};
});
const rejected={company:0,near:0};
function take(split,filter,n,salt){let count=0;for(const d of pool.filter(filter).sort((a,b)=>hash(salt+a.key).localeCompare(hash(salt+b.key)))){
 if(companies.has(d.company_group)){rejected.company++;continue;}
 const candidate=augmented(d);if(blocked.some(s=>near(s,candidate))){rejected.near++;continue;}
 selected.push({...candidate,split,selection_group:salt});blocked.push(candidate);companies.add(d.company_group);if(++count===n)break;
}assert.equal(count,n,salt);}
take('fresh_random',()=>true,60,'crossencoder-fresh-random-v1');
take('fresh_targeted',d=>/数据分析|商业分析|经营分析|统计分析|BI分析/.test(d.title),14,'crossencoder-fresh-analysis-v1');
take('fresh_targeted',d=>/电商|店铺|天猫|京东|亚马逊|淘宝/.test(d.title)&&/运营/.test(d.title),13,'crossencoder-fresh-ops-v1');
take('fresh_targeted',d=>/数据开发|数据工程|数仓|数据仓库|ETL|大数据开发/i.test(d.title),13,'crossencoder-fresh-engineer-v1');
const docs=selected.map(({normalized,grams,...d},i)=>({id:'X'+String(i+1).padStart(3,'0'),...d}));
const manifest={created_at:new Date().toISOString(),source_snapshot:old.manifest.source_snapshot,old_corpus_sha256:hash(oldBytes),source_revision:old.manifest.source_revision,source_rows:source.length,eligible_rows:pool.length,rejected,
 sampling:'60 stable-hash-order random records first, then 14 target-title /13 ecommerce-title /13 engineering-title diagnostic records. Unique normalized companies and reject normalized5gram Jaccard>=0.8 versus all old200 and fresh100. Titles select only, not truth. Random not unbiased job-frequency population estimate.',
 protected_hashes:old.manifest.protected_hashes,annotation:'pending Codex source-evidence review, not independent human gold; fresh records not in previous pilot'};
await fs.mkdir(out,{recursive:true});await fs.writeFile(path.join(out,'fresh-corpus.json'),JSON.stringify({manifest,docs},null,2));
await fs.writeFile(path.join(out,'review-blind.json'),JSON.stringify(docs.map(d=>({id:d.id,title:d.title,body:d.body})),null,2));
console.log(JSON.stringify(manifest,null,2));
