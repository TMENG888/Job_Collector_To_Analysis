import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {writeNativeChannelRows} from './collector_native_sink.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'knowledge-console-test-'));
const task={id:'embedded-fixture',label:'嵌入式软件开发',outputDir:path.join(dir,'task'),status:'paused',datasetScopeVersion:2,platforms:['zhaopin'],cities:['北京'],keywords:['嵌入式软件开发'],targetRows:14};
await fs.mkdir(task.outputDir);
await fs.writeFile(path.join(task.outputDir,'任务归属.json'),JSON.stringify({task_id:task.id}));
await fs.writeFile(path.join(dir,'tasks.json'),JSON.stringify([task]));
await writeNativeChannelRows(task.outputDir,task.id,Array.from({length:14},(_,i)=>({platform:'智联招聘',job_id:String(i),job_name:'智能体开发工程师',company_name:`测试公司${i}`,city:'北京',salary:'15-25K',experience:'1-3年',education:'本科',employment_type:'全职',job_url:`https://example.com/${i}`,job_description:`岗位职责：负责大模型应用和智能体开发，构建RAG检索系统及LangChain多轮工具编排。任职要求：掌握Python、LLM与向量检索，完成系统集成开发。项目编号${i}。`})));
await writeNativeChannelRows(task.outputDir,task.id,Array.from({length:14},(_,i)=>({platform:'智联招聘',job_id:`embedded-${i}`,job_name:'嵌入式软件开发工程师',company_name:`测试公司${i}`,city:'北京',salary:'15-25K',experience:'1-3年',education:'本科',employment_type:'全职',job_url:`https://example.com/embedded-${i}`,job_description:`岗位职责：负责嵌入式软件研发和固件开发，基于STM32进行C++驱动开发，进行RTOS实时任务调试与板级联调。任职要求：熟悉Linux与ARM，掌握嵌入式系统的软件开发流程。项目编号${i}。`})));
const reservation=net.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
let output='';
const child=spawn(process.execPath,[path.join(root,'job_collector_ui/server.mjs'),String(port)],{cwd:root,env:{...process.env,JOB_UI_DATA_DIR:dir,JOB_UI_PORT:String(port),JOB_UI_OPEN_BROWSER:'0',JOB_UI_START_WORKER:'0'},windowsHide:true,stdio:['ignore','pipe','pipe']});
child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
const base=`http://127.0.0.1:${port}`;
async function api(route,body){const response=await fetch(base+route,{signal:AbortSignal.timeout(10000),...(body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})});const data=await response.json();assert.ok(response.ok,`${route}: ${JSON.stringify(data)}`);return data;}
async function until(check){for(let n=0;n<120;n++){if(child.exitCode!==null)throw new Error(output);try{const value=await check();if(value)return value;}catch(error){if(n===119)throw error;}await new Promise(resolve=>setTimeout(resolve,250));}throw new Error('Console timeout: '+output);}
try{
  await until(()=>api('/api/state'));
  assert.equal((await api('/api/state')).capabilities.unifiedKnowledge,true);
  assert.equal((await api('/api/knowledge/status')).rows,28);
  assert.equal((await api('/api/assistant/context')).knowledge,true);
  const source=await api(`/api/knowledge/tasks/${task.id}/source`);
  assert.equal(source.dataset.path,`kb://task/${task.id}`);
  assert.equal((await api('/api/insights/datasets')).catalog,'knowledge-v1');
  await api('/api/insights/run',{inputFile:source.dataset.path,sourceTaskId:task.id,role:task.label,labelJobId:'auto',analysisMode:'full'});
  const insight=await until(async()=>{const state=await api('/api/insights');if(state.status==='failed')throw new Error(state.message);return state.status==='completed'&&state.report?state:null;});
  assert.equal(insight.report.total_rows,28);
  assert.equal(insight.report.input_file,source.dataset.path);
  // Read newly committed task data without exporting or restarting collection.
  await writeNativeChannelRows(task.outputDir,task.id,[{platform:'智联招聘',job_id:'live-new',job_name:'嵌入式软件开发工程师',company_name:'中途新增测试公司',city:'北京',salary:'15-25K',job_url:'https://example.com/live-new',job_description:'岗位职责：负责嵌入式软件开发与STM32固件设计、RTOS实时任务调试及Linux驱动开发。任职要求：熟悉C++与ARM。'}]);
  const liveSource=await api(`/api/tasks/${task.id}/insight-source`);
  assert.equal(liveSource.dataset.expectedRows,29);
  assert.equal((await api('/api/insights')).report.total_rows,28,'existing report must not silently change');
  await api('/api/insights/run',{inputFile:liveSource.dataset.path,sourceTaskId:task.id,analysisMode:'full'});
  const newer=await until(async()=>{const state=await api('/api/insights');if(state.status==='failed')throw new Error(state.message);return state.status==='completed'&&state.report?.total_rows===29?state:null;});
  assert.notEqual(newer.report.knowledge_snapshot,insight.report.knowledge_snapshot);
  const unbounded=(await api('/api/tasks',{label:'无数量隔离测试',primaryKeyword:'嵌入式软件开发',platforms:['iguopin'],cities:['北京'],adaptiveSearch:false})).task;
  assert.equal(unbounded.targetRows,null);assert.equal(unbounded.collectUntilExhausted,true);
  assert.equal((await api(`/api/tasks/${unbounded.id}`)).task.metrics.targetReached,false);
  assert.equal(unbounded.status,'ready','creating without a count must not start real requests');
  const {job}=await api('/api/labels',{inputFile:source.dataset.path,jobFamily:'智能体/大模型应用',platform:'rules',sampleSize:5});
  assert.ok(job.inputFile.startsWith('kb://snapshot/'));
  await api(`/api/labels/${job.id}/run`,{});
  await until(async()=>{const state=(await api('/api/labels')).jobs.find(j=>j.id===job.id);if(state.status==='failed')throw new Error(state.message);return state.status==='completed';});
  assert.equal((await fs.readdir(task.outputDir)).some(file=>file.endsWith('.csv')),false);
  console.log('PASS: isolated console API, native task transfer → full insight → native rule-label launch, all-knowledge assistant and no CSV intermediary');
}finally{
  if(child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}
}
