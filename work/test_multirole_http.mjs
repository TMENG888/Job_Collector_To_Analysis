// New server in an isolated temp data directory. Never restarts live8788.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createKnowledgeStore} from './job_knowledge_store.mjs';
import {writeNativeChannelRows} from './collector_native_sink.mjs';
import {roleClassifier} from './role-classifier-registry.mjs';
const root=path.resolve(import.meta.dirname,'..'),dir=await fs.mkdtemp(path.join(os.tmpdir(),'multirole-http-')),taskDir=path.join(dir,'task');await fs.mkdir(taskDir);
const corpus=JSON.parse(await fs.readFile(path.join(root,'ui_data/insights/comparisons/multirole-lr-20261016/extended-corpus.json'),'utf8')).docs;
const task={id:'source-task-test',label:'嵌入式软件开发-验收',primaryKeyword:'嵌入式软件开发',outputDir:taskDir,status:'paused',stage:'collection',targetRows:100,platforms:['iguopin'],cities:['北京'],keywords:['嵌入式软件开发']};
await fs.writeFile(path.join(taskDir,'任务归属.json'),JSON.stringify({task_id:task.id}));await fs.writeFile(path.join(dir,'tasks.json'),JSON.stringify([task]));
const source=corpus.filter(d=>d.id.startsWith('embedded')).slice(0,12).concat(corpus.filter(d=>d.id.startsWith('software')).slice(0,4));
await writeNativeChannelRows(taskDir,task.id,source.map(d=>({platform:'国聘',job_id:d.id,job_name:d.title,job_description:d.body,company_name:d.company_group,salary:'15-25K',city:'北京',education:'本科',experience:'1-3年'})));
const store=createKnowledgeStore(dir);await store.sync({refresh:false});
const jobs=(await store.read('kb://task/'+task.id)).rows;
// An obsolete report claims ALL rows belong to embedded. Current classifier wins.
await store.publishAnalysis({role:'嵌入式开发',generated_at:new Date().toISOString(),cohort_observations:jobs.map(j=>({knowledge_key:j.knowledge_key,knowledge_hash:j.knowledge_hash,skills:['Python']}))});
const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
const base='http://127.0.0.1:'+port,child=spawn(process.execPath,['job_collector_ui/server.mjs',String(port)],{cwd:root,env:{...process.env,JOB_UI_DATA_DIR:dir,JOB_UI_PORT:String(port),JOB_UI_OPEN_BROWSER:'0',JOB_UI_START_WORKER:'0'},windowsHide:true,stdio:['ignore','pipe','pipe']});
let logs='';child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
async function api(route,body){const res=await fetch(base+route,{...(body?{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify(body)}:{})});return {status:res.status,data:await res.json()};}
try{
 let ready=false;for(let n=0;n<80;n++){try{if((await api('/api/state')).status===200){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready,logs);
 const state=await api('/api/state');assert.equal(state.data.capabilities.insightSourceRole,true);
 const html=await(await fetch(base+'/insights')).text();assert.ok(html.includes('insightRoleSource'));assert.ok(!html.includes('name="role"'));
 const status=await api('/api/knowledge/status');assert.equal(status.status,200);assert.ok(status.data.role_screening.active.some(m=>m.family==='测试工程'));
 const bad=await api('/api/insights/run',{inputFile:'kb://task/'+task.id,sourceTaskId:'mismatch',analysisMode:'full'});assert.equal(bad.status,400);
 const run=await api('/api/insights/run',{inputFile:'kb://task/'+task.id,analysisMode:'full',labelJobId:'auto'});assert.equal(run.status,202,JSON.stringify(run));
 let result;for(let n=0;n<150;n++){result=(await api('/api/insights')).data;if(['completed','failed'].includes(result.status))break;await new Promise(r=>setTimeout(r,100));}
 assert.equal(result.status,'completed',JSON.stringify(result));const report=result.report;
 assert.equal(report.role,'嵌入式开发');assert.equal(report.detected_role.mode,'source_task');assert.equal(report.selection_contract,'embedded-tfidf-lr-v1');assert.equal(report.total_rows,16);
 const expected=jobs.filter(j=>roleClassifier('嵌入式开发').match(j).matched).map(j=>j.job_id).sort();
 assert.deepEqual(report.cohort_observations.map(j=>j.job_id).sort(),expected);
 const current=await store.assistantData();assert.deepEqual(current.jobs.filter(j=>j.role_families.includes('嵌入式开发')).map(j=>j.job_id).sort(),expected);
 assert.equal((await fs.readdir(taskDir)).some(n=>n.endsWith('.csv')),false);
 console.log(JSON.stringify({passed:true,temporary:dir,port,source_rows:16,admitted:expected.length,model:report.selection_contract,manual_role_input:false,historical_report_cannot_revive:true,live8788_untouched:true}));
}finally{const exited=once(child,'exit');child.kill('SIGTERM');await exited;}
