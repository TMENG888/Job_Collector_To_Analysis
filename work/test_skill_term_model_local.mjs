// Explicit offline smoke evaluation on copied real JDs. Never approves production labels.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createKnowledgeStore} from './job_knowledge_store.mjs';
import {createTermDiscovery} from './skill_term_discovery.mjs';
import {writeNativeChannelRows} from './collector_native_sink.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'skill-term-real-model-')),out=path.join(dir,'task');await fs.mkdir(out);
const task={id:'real-model-test',label:'新词模型隔离实测',outputDir:out};
await fs.writeFile(path.join(out,'任务归属.json'),JSON.stringify({task_id:task.id}));await fs.writeFile(path.join(dir,'tasks.json'),JSON.stringify([task]));
const corpus=JSON.parse(await fs.readFile(path.join(root,'ui_data/insights/comparisons/uie-wordcloud-20261016/corpus.json'),'utf8'));
const docs=corpus.docs.filter(d=>['real-02','real-03','real-04','real-06','real-08','real-11'].includes(d.id));
const rows=docs.map(d=>({platform:d.platform,job_id:d.id,job_name:d.title,job_description:d.text,industry:d.industry}));
rows.push({platform:'fixture',job_id:'edge',job_name:'模型边界测试',job_description:'公司介绍：我们采用Neo4j和Milvus。任职要求：无需掌握AutoGen，不要求LangGraph开发经验。福利待遇：提供LoadRunner培训。'});
await writeNativeChannelRows(out,task.id,rows);const store=createKnowledgeStore(dir);await store.sync({refresh:false});
const discovery=createTermDiscovery(store);const started=Date.now();const launch=await discovery.start({limit:10});console.log(JSON.stringify({started:launch,fixture:dir}));
let run;for(let n=0;n<180;n++){
  await new Promise(resolve=>setTimeout(resolve,1000));run=(await discovery.status()).run;
  if(run.status!=='running')break;
}
assert.equal(run.status,'completed',JSON.stringify(run));
const candidates=await store.termReview.list({limit:100});
assert.ok(candidates.items.length>0);assert.ok(candidates.items.every(c=>c.state==='pending'));
assert.ok(!candidates.items.some(c=>c.platform==='fixture'),'excluded/negative sentences not scanned');
assert.ok(!(await store.read()).rows.some(j=>j.knowledge_approved_skills.length),'no automatic publication');
assert.ok(candidates.items.some(c=>/Neo4j|Milvus|AutoGen|UART|LoadRunner/i.test(c.term)),'useful unseen term found');
const noWork=await discovery.start({limit:10});assert.equal(noWork.total,0,'completed batch cached');
const report={generated_at:new Date().toISOString(),test:'local supplementary GLiNER skill-only pipeline, isolated copied JDs, not precision/recall evaluation',elapsed_seconds:(Date.now()-started)/1000,fixture:dir,run,counts:candidates.counts,candidates:candidates.items};
const reportFile=path.join(root,'ui_data/insights/comparisons/uie-wordcloud-20261016/skill-term-supplement-smoke.json');
await fs.writeFile(reportFile,JSON.stringify(report,null,2));
console.log(JSON.stringify({PASS:true,rows:rows.length,elapsed_seconds:report.elapsed_seconds,candidates:candidates.items.map(c=>({job:c.job_name,term:c.term})),report:reportFile}));
