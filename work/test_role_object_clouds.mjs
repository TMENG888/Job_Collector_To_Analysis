import fs from 'node:fs/promises';
import path from 'node:path';
import {buildKeywordCloudDisplay} from './keyword-cloud-display.mjs';
import {layoutWordCloud} from '../job_collector_ui/public/insight-wordcloud.js';
import assert from 'node:assert/strict';
const base=path.resolve('ui_data/insights/comparisons/weighted-role-threshold-20261010'),out=path.resolve('ui_data/insights/comparisons/object-aware-screening-20261010');
const summaries=[];
for(const [role,name] of [['agent','智能体/大模型应用'],['crawler','爬虫/数据采集'],['bigdata','大数据开发']]){
 const raw=JSON.parse(await fs.readFile(path.join(base,role+'-raw.json'),'utf8'));
 const scores=JSON.parse(await fs.readFile(path.join(out,role+'-scores.json'),'utf8'));
 // Compare display using identical frozen screening policies, not claim that
 // this offline gate is the live production policy.
 for(const [variant,threshold] of [['baseline',4],['gate',2.5]]){
  const ids=scores.predictions[variant].filter(p=>p.score>=threshold).map(p=>p.row_no);
  const rows=raw.docs.map(d=>({row_no:d.row_no,'岗位名称':d.title,'岗位描述':d.original_description}));
  const cloud=buildKeywordCloudDisplay(rows,{name,title:/.*/},{seedRows:ids});
  assert.ok(cloud?.terms.length>=10);assert.equal(cloud.source_scope,'主报告纳入记录');
  const selected=new Set(ids);assert.ok(cloud.terms.every(t=>selected.has(t.evidence.row_no)&&t.used_for_filter===false));
  const layout=layoutWordCloud(cloud.terms);let collisions=0;
  for(let i=0;i<layout.words.length;i++)for(let j=i+1;j<layout.words.length;j++){const a=layout.words[i],b=layout.words[j];if(a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y)collisions++;}
  assert.equal(collisions,0);
  await fs.writeFile(path.join(out,`${role}-${variant}-cloud.json`),JSON.stringify(cloud,null,2));
  const summary={role,variant,selected_bodies:ids.length,cloud_words:cloud.terms.length,quoted_evidence_rate:cloud.terms.filter(t=>t.evidence.quote).length/cloud.terms.length,minimum_df:cloud.minimum_seed_df,collisions,top20:cloud.terms.slice(0,20).map(t=>t.name)};
  summaries.push(summary);console.log(JSON.stringify(summary));
 }
}
await fs.writeFile(path.join(out,'cloud-verification.json'),JSON.stringify(summaries,null,2));
