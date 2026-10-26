// One-shot display migration, preserves every non-cloud report field.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {parseChannelCsv} from './public_channel_csv.mjs';
import {buildKeywordCloudDisplay} from './keyword-cloud-display.mjs';
const reportPath=path.resolve('ui_data/insights/岗位市场洞察.json');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const oldBytes=await fs.readFile(reportPath),old=JSON.parse(oldBytes);
if(old.role!=='数据分析')throw Error('Current report is not the evaluated data-analysis profile');
const source=await fs.readFile(old.input_file);
const rows=parseChannelCsv(source.toString('utf8')).map((r,i)=>({...r,row_no:i+2,'岗位名称':r.job_name,'岗位描述':r.job_description}));
const cloud=buildKeywordCloudDisplay(rows,{name:'数据分析',title:/数据\s*分析/i});
if(!cloud?.terms.length)throw Error('No display terms');
const report=structuredClone(old);
report.topic_model.discovered_terms=cloud.terms;
report.topic_model.display_limit=100;
report.topic_model.display_model={...cloud,terms:undefined,updated_at:new Date().toISOString(),source_sha256:hash(source)};
const comparable=r=>{const copy=structuredClone(r);delete copy.topic_model.discovered_terms;delete copy.topic_model.display_limit;delete copy.topic_model.display_model;return copy;};
assert.deepEqual(comparable(old),comparable(report));
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
const out=path.resolve('ui_data/insights/comparisons',`wordcloud-deploy-${stamp}`);
await fs.mkdir(out,{recursive:true});
await fs.writeFile(path.join(out,'before.json'),oldBytes);
await fs.writeFile(path.join(out,'candidate.json'),JSON.stringify(report,null,2));
const verification={before_sha256:hash(oldBytes),source_sha256:hash(source),display_words:cloud.terms.length,seed_rows:cloud.seed_rows,original_keywords:old.keyword_selection.keywords.length,selected_rows:old.relevant_sample_rows,only_cloud_changed:true,out};
if(process.argv.includes('--publish')){
 const state=JSON.parse(await fs.readFile('ui_data/insights/state.json','utf8'));
 const live=await (await fetch('http://127.0.0.1:8788/api/insights')).json();
 if(['running','queued','starting'].includes(state.status)||['running','queued','starting'].includes(live.status))throw Error('Insight analysis active; publish postponed');
 if(hash(await fs.readFile(reportPath))!==hash(oldBytes)||hash(await fs.readFile(old.input_file))!==hash(source))throw Error('Concurrent source/report change; publish refused');
 const temp=reportPath+`.display-${stamp}.tmp`;
 await fs.writeFile(temp,JSON.stringify(report,null,2));await fs.rename(temp,reportPath);
 verification.published=true;
 const saved=JSON.parse(await fs.readFile(reportPath,'utf8'));assert.deepEqual(comparable(saved),comparable(old));
}
await fs.writeFile(path.join(out,'verification.json'),JSON.stringify(verification,null,2));
console.log(JSON.stringify(verification,null,2));
