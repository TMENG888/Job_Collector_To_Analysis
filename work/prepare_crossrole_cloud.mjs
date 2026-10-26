import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {readJobDataset} from './job_dataset.mjs';
import {roleSections} from './role-evidence-v2.mjs';
import {learnUniversalRoleKeywords,matchUniversalRoleKeywords} from './universal-role-keywords.mjs';
const out=path.resolve('ui_data/insights/comparisons/wordcloud-demand-crossrole-20261010');
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const norm=x=>String(x||'').normalize('NFKC').toLowerCase().replace(/\s+/g,'');
await fs.mkdir(out,{recursive:true});
const agent=JSON.parse(await fs.readFile('ui_data/insights/comparisons/agent-unsupervised-20261010/corpus.json','utf8'));
await fs.mkdir(path.join(out,'agent'),{recursive:true});
await fs.writeFile(path.join(out,'agent/corpus.json'),JSON.stringify(agent,null,2));
const corpora={agent};
for(const [id,name,title,file] of [
 ['crawler','爬虫/数据采集',/爬虫|数据采集|数据抓取|采集工程师/i,'爬虫工程师岗位_5000条.xlsx'],
 ['bigdata','大数据开发',/大数据.*(开发|工程)|数据开发工程师|Hadoop.*工程师|Spark.*工程师/i,'大数据开发工程师岗位_5000条.xlsx']
]){
 const input=path.resolve('../测试采集数据集/岗位分析数据集/历史数据集',file);
 const {rows}=await readJobDataset(input),model=learnUniversalRoleKeywords(rows,{name,title});
 const included=rows.filter(r=>matchUniversalRoleKeywords(r,model).matched),seen=new Set(),docs=[];
 for(const r of included){const sections=roleSections(r),text=sections.map(s=>s.quote).join('\n'),key=norm(text);if(!key||seen.has(key))continue;seen.add(key);const body_sha256=hash(key);docs.push({row_no:r.row_no,title:r['岗位名称'],company:r['公司名称'],platform:r['平台'],sections,text,body_sha256,split:parseInt(hash(norm(r['公司名称'])||body_sha256).slice(0,8),16)%5===0?'holdout':'train'});}
 const manifest={input_file:input,input_rows:rows.length,included_rows:included.length,independent_docs:docs.length,train_docs:docs.filter(d=>d.split==='train').length,holdout_docs:docs.filter(d=>d.split==='holdout').length,source_kind:'historical, not newly collected',selection:model,baseline:[],source_sha256:hash(await fs.readFile(input))};
 corpora[id]={manifest,docs};await fs.mkdir(path.join(out,id),{recursive:true});await fs.writeFile(path.join(out,id,'corpus.json'),JSON.stringify(corpora[id],null,2));
 const titleDocs=docs.filter(d=>title.test(d.title));
 const sensitivity={manifest:{...manifest,selection:'Sensitivity only: production-included AND explicit target title. Not a recall gold standard.',independent_docs:titleDocs.length,train_docs:titleDocs.filter(d=>d.split==='train').length,holdout_docs:titleDocs.filter(d=>d.split==='holdout').length},docs:titleDocs};
 await fs.mkdir(path.join(out,id+'-title'),{recursive:true});await fs.writeFile(path.join(out,id+'-title/corpus.json'),JSON.stringify(sensitivity,null,2));
}
const sample=[];
for(const [id,c] of Object.entries(corpora))for(const split of ['train','holdout']){
 const ds=c.docs.filter(d=>d.split===split).sort((a,b)=>hash('review20261010'+a.body_sha256).localeCompare(hash('review20261010'+b.body_sha256))),companies=new Set();let n=0;
 for(const d of ds){if(companies.has(norm(d.company)))continue;companies.add(norm(d.company));sample.push({role:id,...d});if(++n===8)break;}
}
await fs.writeFile(path.join(out,'original-review-sample.json'),JSON.stringify(sample,null,2));
await fs.writeFile(path.join(out,'原文抽查.md'),sample.map(d=>`## ${d.role} / ${d.split} / 源行 ${d.row_no} / ${d.title}\n${d.sections.map(s=>`${s.location}: ${s.quote}`).join('\n')}`).join('\n\n'));
const files=['work/role-evidence-v2.mjs','work/universal-role-keywords.mjs','work/keyword-cloud-display.mjs','job_collector_ui/public/insight-wordcloud.js','work/analyze_job_market_sample.mjs','ui_data/insights/岗位市场洞察.json'];
const protectedHashes=Object.fromEntries(await Promise.all(files.map(async f=>[f,hash(await fs.readFile(f))])));
await fs.writeFile(path.join(out,'protected-hashes.json'),JSON.stringify(protectedHashes,null,2));
console.log(JSON.stringify(Object.fromEntries(Object.entries(corpora).map(([k,v])=>[k,{...v.manifest,selection:undefined,protected_hashes:undefined,baseline:undefined}]))));
