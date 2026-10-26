import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {readJobDataset} from './job_dataset.mjs';
import {roleSections,matchRoleEvidence} from './role-evidence-v2.mjs';
import {learnUniversalRoleKeywords,matchUniversalRoleKeywords} from './universal-role-keywords.mjs';
const out=path.resolve('ui_data/insights/comparisons/weighted-role-threshold-20261010');
const prior=path.resolve('ui_data/insights/comparisons/wordcloud-demand-crossrole-20261010');
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const norm=x=>String(x||'').normalize('NFKC').toLowerCase().replace(/\s+/g,'');
await fs.mkdir(out,{recursive:true});
const frozen=JSON.parse(await fs.readFile('ui_data/insights/comparisons/evidence-v2/production-test.report.json','utf8'));
const am={...frozen.keyword_selection,profile:frozen.selection_review.profile,threshold:frozen.selection_review.threshold};
const previous=JSON.parse(await fs.readFile(path.join(prior,'original-review-sample.json'),'utf8'));
const sample=[],manifest=[];
for(const [id,name,title,near] of [
 ['agent','智能体/大模型应用',/智能体|AI.?Agent|Agent开发|大模型应用|AI应用/i,/大模型|智能体|agent|rag|llm|langchain/i],
 ['crawler','爬虫/数据采集',/爬虫|数据采集|数据抓取|采集工程师/i,/爬虫|抓取|scrapy|selenium|playwright|逆向|网页|数据采集/i],
 ['bigdata','大数据开发',/大数据.*(开发|工程)|数据开发工程师|Hadoop.*工程师|Spark.*工程师/i,/数仓|数据仓库|etl|hadoop|spark|flink|hive|数据开发/i]
]){
 const priorCorpus=JSON.parse(await fs.readFile(path.join(prior,id,'corpus.json'),'utf8'));
 const input=priorCorpus.manifest.input_file,{rows}=await readJobDataset(input);
 const model=id==='agent'?am:learnUniversalRoleKeywords(rows,{name,title});
 const docs=[],seen=new Set();
 for(const r of rows){const sections=roleSections(r),text=sections.map(s=>s.quote).join('\n'),key=norm(text);if(!key||seen.has(key))continue;seen.add(key);
  const body_sha256=hash(key),group=norm(r['公司名称'])||body_sha256,part=parseInt(hash(group).slice(0,8),16)%5;
  const old=(id==='agent'?matchRoleEvidence:matchUniversalRoleKeywords)(r,model);
  docs.push({role:id,row_no:r.row_no,title:r['岗位名称'],company:r['公司名称'],platform:r['平台'],sections,text,original_description:r['岗位描述'],body_sha256,split:part===0?'test':part===1?'calibration':'train',title_seed:title.test(r['岗位名称']),near:near.test(text),old_matched:old.matched});
 }
 for(const split of ['calibration','test']){
  const eligible=docs.filter(d=>d.split===split&&!previous.some(p=>p.role===id&&p.row_no===d.row_no));
  const groups=[['title',8,d=>d.title_seed],['old_accept_other',6,d=>!d.title_seed&&d.old_matched],['near_reject',4,d=>!d.title_seed&&!d.old_matched&&d.near],['far_reject',2,d=>!d.title_seed&&!d.old_matched&&!d.near]];
  const companies=new Set();
  for(const [stratum,n,predicate] of groups){let taken=0;const pool=eligible.filter(predicate).sort((a,b)=>hash('weighted-review'+a.body_sha256).localeCompare(hash('weighted-review'+b.body_sha256)));
   for(const d of pool){if(companies.has(norm(d.company)))continue;companies.add(norm(d.company));sample.push({...d,stratum});if(++taken===n)break;}
   console.log(JSON.stringify({role:id,split,stratum,selected:taken,available:pool.length}));
  }
 }
 const meta={role:id,input_file:input,source_sha256:hash(await fs.readFile(input)),raw_rows:rows.length,independent_docs:docs.length,train:docs.filter(d=>d.split==='train').length,calibration:docs.filter(d=>d.split==='calibration').length,test:docs.filter(d=>d.split==='test').length};
 manifest.push(meta);await fs.writeFile(path.join(out,id+'-raw.json'),JSON.stringify({manifest:meta,docs},null,2));
}
await fs.writeFile(path.join(out,'blind-review.json'),JSON.stringify(sample.map(({old_matched,title_seed,near,...d})=>d),null,2));
await fs.writeFile(path.join(out,'sample-design.json'),JSON.stringify(sample.map(d=>({role:d.role,row_no:d.row_no,stratum:d.stratum,split:d.split,old_matched:d.old_matched})),null,2));
await fs.writeFile(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2));
const protectedFiles=['work/role-evidence-v2.mjs','work/universal-role-keywords.mjs','work/keyword-role-matcher.mjs','work/analyze_job_market_sample.mjs','ui_data/insights/岗位市场洞察.json'];
await fs.writeFile(path.join(out,'protected-hashes.json'),JSON.stringify(Object.fromEntries(await Promise.all(protectedFiles.map(async f=>[f,hash(await fs.readFile(f))]))),null,2));
console.log(JSON.stringify({manifest,samples:sample.length}));
