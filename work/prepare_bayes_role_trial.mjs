// Offline prospective NB evaluation. New test is isolated from ALL prior480 records.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {dutiesOf} from './keyword-role-matcher.mjs';
import {matchUniversalRoleKeywords} from './universal-role-keywords.mjs';
const root=path.resolve(import.meta.dirname,'..'),oldDir=path.join(root,'ui_data/insights/comparisons/codex-classifier-20261016');
const out=path.join(root,'ui_data/insights/comparisons/bayes-classifier-20261016');
const hash=x=>createHash('sha256').update(x).digest('hex');
try{await fs.access(path.join(out,'fresh-corpus.json'));throw Error('Already frozen');}catch(e){if(e.code!=='ENOENT')throw e;}
const oldBytes=await fs.readFile(path.join(oldDir,'corpus.json')),old=JSON.parse(oldBytes);
for(const [p,h]of Object.entries(old.manifest.protected_hashes))assert.equal(hash(await fs.readFile(path.join(root,p))),h,p);
const norm=x=>String(x||'').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}\d]/gu,'');
const grams=s=>new Set(Array.from({length:Math.max(0,s.length-4)},(_,i)=>s.slice(i,i+5)));
const aug=d=>({...d,normalized:norm(d.body),grams:grams(norm(d.body))});
const blocked=old.docs.map(aug),companies=new Set(old.docs.map(d=>d.company_group)),selected=[];
let source;const db=new DatabaseSync(path.join(root,'ui_data/knowledge/岗位知识库.sqlite'),{readOnly:true});
try{db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000');source=JSON.parse(db.prepare('SELECT rows_json FROM snapshots WHERE snapshot_id=?').get(new URL(old.manifest.source_snapshot).pathname.slice(1)).rows_json);}finally{db.close();}
const pool=source.filter(r=>String(r.job_description||'').length>=80&&String(r.job_description||'').length<=9000).map(r=>{
 const row={'岗位名称':r.job_name,'岗位描述':r.job_description};return {key:r.knowledge_key,content_hash:r.knowledge_hash,title:r.job_name,platform:r.platform,
 company_group:hash(norm(r.company_name||r.company_id)||r.knowledge_key),body:r.job_description,duties:dutiesOf(row),baseline:matchUniversalRoleKeywords(row,old.manifest.baseline_keywords)};
});
function near(a,b){if(Math.min(a.normalized.length,b.normalized.length)/Math.max(a.normalized.length,b.normalized.length)<.75)return false;let n=0;for(const g of a.grams)if(b.grams.has(g))n++;return n/(a.grams.size+b.grams.size-n)>=.8;}
function take(split,filter,n,salt){let count=0;for(const d of pool.filter(filter).sort((a,b)=>hash(salt+a.key).localeCompare(hash(salt+b.key)))){
 if(companies.has(d.company_group))continue;const candidate=aug(d);if(blocked.some(b=>near(candidate,b)))continue;
 selected.push({...d,split,selection_group:salt});blocked.push(candidate);companies.add(d.company_group);if(++count===n)break;
}assert.equal(count,n,salt);}
take('fresh_random',()=>true,80,'bayes-fresh-random-v1');
take('fresh_challenge',d=>/数据分析|商业分析|经营分析|统计分析|BI分析/.test(d.title),16,'bayes-fresh-analysis-v1');
take('fresh_challenge',d=>/电商|店铺|天猫|京东|亚马逊|淘宝/.test(d.title)&&/运营/.test(d.title),12,'bayes-fresh-ops-v1');
take('fresh_challenge',d=>/数据开发|数据工程|数仓|数据仓库|ETL|大数据开发/i.test(d.title),12,'bayes-fresh-engineering-v1');
const docs=selected.map((d,i)=>({id:'B'+String(i+1).padStart(3,'0'),...d}));
const manifest={created_at:new Date().toISOString(),target:'数据分析',source_snapshot:old.manifest.source_snapshot,source_revision:old.manifest.source_revision,
 source_rows:source.length,eligible_rows:pool.length,prior480_corpus_sha256:hash(oldBytes),protected_hashes:old.manifest.protected_hashes,
 sampling:'New company-capped stable-hash random80 followed by title-directed16analysis/12ops/12engineering challenge. All120 isolated from prior480 companies and near-JDs. Random is not unbiased job-frequency estimate; directed results separate.',
 annotation:'Pending Codex duty-evidence review, not independent human gold. Seal labels before NB training/inference. No new labels enter training/validation.'};
await fs.mkdir(out,{recursive:true});await fs.writeFile(path.join(out,'fresh-corpus.json'),JSON.stringify({manifest,docs},null,2));
await fs.writeFile(path.join(out,'review-blind.json'),JSON.stringify(docs.map(d=>({id:d.id,title:d.title,body:d.body})),null,2));
console.log(JSON.stringify(manifest,null,2));
