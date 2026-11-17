import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createInsightSupervised} from './insight-supervised.mjs';
import {schemaHash,validateAnnotationSchema} from './insight-annotation-schema.mjs';
import {createInsightTrainingQueue} from './insight-training-queue.mjs';
import {renderTrainingJobs,renderTrainingProgress} from '../job_collector_ui/public/insight-training-queue.js';
import {jointSemanticStatus} from '../job_collector_ui/public/insight-semantic.js';

const role='应用开发',inputFile='kb://task/recovery-test';
const example={title:role,duties:'负责应用开发和维护',reason:'交付应用'};
const schema=validateAnnotationSchema({schema_version:'job-annotation-schema-v2',role,definition:'应用开发与维护',classification:{include:['应用开发'],exclude:['销售'],review:['信息不足'],positive_examples:[example,example],negative_examples:[example,example]},semantics:Object.fromEntries(['skills','tasks'].map(k=>[k,{definition:k,include:['原文'],exclude:['推测'],normalization:[]}])),retrieval:{title_keywords:['应用开发','软件开发'],duty_keywords:['应用开发','软件开发'],adjacent_keywords:[]}},role);
const document={id:'original-schema',schema,sha256:schemaHash(schema)};
const rows=Array.from({length:120},(_,i)=>({job_name:`应用开发${i}`,company_name:'公司'+i,job_description:`岗位职责：负责应用开发、接口研发和质量保障，完成编号${i}项目的上线交付与维护，建立开发规范和日志排查流程。任职要求：熟悉Python，理解数据库技术与接口设计，具备独立解决复杂问题的能力。`,knowledge_key:'K'+i}));
const credentials={status:async()=>({configured:true}),load:async()=>'fake-local-key'};
const schemas={resolve:async()=>document,status:async()=>({approved:document})};
const usage={prompt_tokens:100,completion_tokens:30,total_tokens:130};
const cost=(100*.8+30*2.7)/1e6;
function output(options,{invalid=false,malformed=false}={}){
  const request=JSON.parse(options.body),jobs=JSON.parse(request.messages[1].content).jobs;
  const labels=jobs.map(job=>({id:job.id,label:Number(job.title.match(/\d+$/)[0])%2?'include':'exclude',evidence_id:job.classification_evidence_options[0].id,skills:[],tasks:[]}));
  if(invalid){labels[0]['include|exclude|review']=labels[0].label;delete labels[0].label;}
  return {ok:true,json:async()=>({usage,choices:[{finish_reason:'stop',message:{content:malformed?'broken JSON':JSON.stringify({labels})}}]})};
}
async function fixture(fetcher,overrides={}){
  const dir=await fs.mkdtemp('E:/Codex/temp/20261111-label-resume/test-'),directory=path.join(dir,'classifier');
  const options={directory,requestConcurrency:1,experiment:true,credentials,schemas,publishJoint:async()=>{},readRows:async()=>({rows,total:rows.length}),requestDelayMs:0,trainRunner:async out=>fs.writeFile(path.join(out,'evaluation.json'),JSON.stringify({eligible:false,predictions:[]})),...overrides};
  const service=createInsightSupervised(dir,{...options,fetcher});
  return {dir,directory,options,service,start:()=>service.start({inputFile,role,sampleCount:120,budget:1,jointAnnotations:true})};
}
async function settled(service,id){
  for(let i=0;i<2000;i++){const state=await service.run(id);if(!state.settling)return state;await new Promise(r=>setTimeout(r,5));}
  throw Error('mock did not finish');
}

test('new queue jobs use 500 samples and reject changes before starting model work',async()=>{
  const dir=await fs.mkdtemp('E:/Codex/temp/20261111-label-resume/policy-');let previews=0;
  const queue=createInsightTrainingQueue({directory:dir,pollMs:1,service:{credentials,schemas:{status:async()=>({approved:{...document,notes:'用户输入的岗位检索关键词：'+role}})},status:async()=>({busy:false,credentials:{configured:true}}),previewSampling:async(_input,_role,count)=>{assert.equal(count,500);previews++;return {canStart:false};},start:async()=>{throw Error('insufficient samples must not call Qwen');}}});
  const job=await queue.enqueue({taskId:'all',inputFile:'kb://all',role,keywords:role,rows:1000});
  assert.equal(job.sampleCount,500);assert.equal((await queue.list()).defaults.sampleCount,500);
  for(const sampleCount of [400,600,'500'])await assert.rejects(queue.start(job.id,{confirmed:true,sampleCount}),/固定为500/);
  await queue.start(job.id,{confirmed:true});
  let list;for(let i=0;i<100;i++){list=await queue.list();if(!list.busy)break;await new Promise(r=>setTimeout(r,5));}
  assert.equal(previews,1);assert.equal(list.jobs[0].status,'needs_samples');assert.match(list.jobs[0].message,/不足500条/);
});

test('completed saved semantics never claim to be still synchronizing',()=>{
  assert.equal(jointSemanticStatus({status:'completed',semanticStatus:'completed'}),'技术与职责标签已保存');
  assert.equal(jointSemanticStatus({status:'completed',semanticStatus:'completed'},{classifierBusy:true}),'技术与职责标签已保存');
  assert.equal(jointSemanticStatus({status:'labeling',semanticStatus:'pending'},{classifierBusy:true}),'语义同步标注中');
  assert.equal(jointSemanticStatus({status:'failed',semanticStatus:'pending'}),'已保留完成的语义标签');
});
test('malformed label gets one bounded retry then succeeds without duplicate samples',async()=>{
  let calls=0;const fixtureState=await fixture(async(_url,options)=>output(options,{invalid:++calls===1}));
  const run=await fixtureState.start(),result=await settled(fixtureState.service,run.id);
  assert.equal(result.status,'completed');assert.equal(calls,121);assert.equal(result.labeled,120);assert.equal(result.retryRequests,1);assert.equal(result.skipped,0);
  assert.ok(Math.abs(result.costEstimate-121*cost)<1e-10);
  const saved=JSON.parse(await fs.readFile(path.join(fixtureState.directory,run.id,'checkpoint.json'),'utf8'));
  assert.equal(new Set(saved.labeled.map(s=>s.id)).size,120);assert.equal(saved.errors.length,1);
});
test('two bad responses skip only that record and remaining records continue to training',async()=>{
  let calls=0;const f=await fixture(async(_url,options)=>output(options,{malformed:++calls<=2}));
  const run=await f.start(),result=await settled(f.service,run.id);
  assert.equal(result.status,'completed');assert.equal(result.labeled,119);assert.equal(result.skipped,1);assert.equal(result.processed,120);assert.equal(calls,121);
  const saved=JSON.parse(await fs.readFile(path.join(f.directory,run.id,'samples.json'),'utf8'));assert.equal(saved.samples.length,119);
  const errors=JSON.parse(await fs.readFile(path.join(f.directory,run.id,'validation-errors.json'),'utf8'));assert.equal(errors.errors.length,2);assert.equal(errors.skipped.length,1);
});
test('restart resumes fixed samples and budget without resampling or repaying successful records',async()=>{
  let first=0;const f=await fixture(async(_url,options)=>++first===3?{ok:false,status:401}:output(options));
  const run=await f.start(),initial=await settled(f.service,run.id);assert.equal(initial.labeled,2);assert.equal(first,3);
  let remaining=0;
  const restored=createInsightSupervised(f.dir,{...f.options,readRows:async()=>{throw Error('must not read/resample');},schemas:{...schemas,resolve:async()=>{throw Error('must use frozen schema');}},fetcher:async(_url,options)=>{remaining++;return output(options);}});
  await assert.rejects(()=>restored.resume(run.id,{}),/确认/);assert.equal(remaining,0);
  await restored.resume(run.id,{confirmed:true});const result=await settled(restored,run.id);
  assert.equal(result.status,'completed');assert.equal(remaining,118);assert.equal(result.labeled,120);assert.equal(result.requestsCompleted,120);assert.equal(result.requestsStarted,121);assert.equal(result.budget,1);
  assert.ok(Math.abs(result.costEstimate-120*cost)<1e-10);assert.equal(result.annotationSchema.sha256,document.sha256);
});
test('saved response after process crash replays locally and reconciles usage once',async()=>{
  let first=0;const f=await fixture(async(_url,options)=>++first===2?{ok:false,status:401}:output(options));
  const run=await f.start();await settled(f.service,run.id);const runDir=path.join(f.directory,run.id);
  const checkpoint=JSON.parse(await fs.readFile(path.join(runDir,'checkpoint.json'),'utf8'));checkpoint.labeled=[];checkpoint.semanticRows=[];checkpoint.handledRequests=0;await fs.writeFile(path.join(runDir,'checkpoint.json'),JSON.stringify(checkpoint));
  const state=JSON.parse(await fs.readFile(path.join(runDir,'state.json'),'utf8'));Object.assign(state,{promptTokens:0,completionTokens:0,totalTokens:0,costEstimate:0,requestsCompleted:0,usageRecordedThrough:0});await fs.writeFile(path.join(runDir,'state.json'),JSON.stringify(state));
  let remaining=0;const restored=createInsightSupervised(f.dir,{...f.options,fetcher:async(_url,options)=>{remaining++;return output(options);}});
  await restored.resume(run.id,{confirmed:true});const result=await settled(restored,run.id);
  assert.equal(result.status,'completed');assert.equal(remaining,119);assert.equal(result.labeled,120);assert.equal(result.requestsCompleted,120);assert.ok(Math.abs(result.costEstimate-120*cost)<1e-10);
});
test('retry obeys original remaining budget and does not issue an extra request',async()=>{
  let calls=0;const f=await fixture(async(_url,options)=>{calls++;const response=output(options,{invalid:true}),data=await response.json();data.usage={prompt_tokens:100,completion_tokens:5500,total_tokens:5600};return {ok:true,json:async()=>data};});
  const started=await f.service.start({inputFile,role,sampleCount:120,budget:.025,jointAnnotations:true});
  const result=await settled(f.service,started.id);assert.equal(result.status,'failed');assert.match(result.message,/预算/);assert.ok(calls<=1);assert.ok(result.costEstimate<=result.budget);
});
test('unknown network usage is reserved, not auto-retried, and does not reset on resume',async()=>{
  let calls=0;const f=await fixture(async()=>{calls++;throw Error('network disconnected');});
  const run=await f.start(),initial=await settled(f.service,run.id);assert.equal(calls,1);assert.equal(initial.unknownUsageRequests,1);assert.ok(initial.unknownUsageCost>0);assert.equal(initial.costEstimate,initial.unknownUsageCost);
  await f.service.resume(run.id,{confirmed:true});const result=await settled(f.service,run.id);assert.equal(calls,2);assert.equal(result.unknownUsageRequests,2);assert.ok(result.costEstimate>initial.costEstimate);
});
test('persistent bad output pauses after five skipped records instead of spending entire budget',async()=>{
  let calls=0;const f=await fixture(async(_url,options)=>{calls++;return output(options,{invalid:true});});
  const run=await f.start(),result=await settled(f.service,run.id);assert.equal(result.status,'failed');assert.equal(calls,10);assert.equal(result.skipped,5);assert.match(result.message,/连续5条/);
});
test('queue resumes same run with no DeepSeek request; UI exposes recovery and skipped progress',async()=>{
  const dir=await fs.mkdtemp('E:/Codex/temp/20261111-label-resume/queue-');let resumed=0;
  const id='queue-test',runId='previous-run';await fs.writeFile(path.join(dir,'state.json'),JSON.stringify({version:1,jobs:[{id,runId,inputFile,role,status:'failed',labelBudget:1,sampleCount:120,createdAt:new Date().toISOString()}]}));
  const queue=createInsightTrainingQueue({directory:dir,pollMs:1,service:{credentials,schemas:{status:async()=>{throw Error('no schema step allowed');}},status:async()=>({busy:false}),resume:async(value,options)=>{assert.equal(value,runId);assert.equal(options.confirmed,true);resumed++;return {id:runId};},run:async()=>({status:'completed',eligible:false,costEstimate:.5})}});
  await queue.resume(id,{confirmed:true});let list;for(let i=0;i<100;i++){list=await queue.list();if(!list.busy)break;await new Promise(r=>setTimeout(r,5));}
  assert.equal(resumed,1);assert.equal(list.jobs[0].status,'rejected');assert.equal(list.jobs[0].runId,runId);
  const html=renderTrainingJobs([{id,runId,role,status:'failed'}]);assert.match(html,/data-training-resume/);assert.match(html,/继续本轮/);
  const progress=renderTrainingProgress({id,runId,role,status:'labeling'}, {run:{id:runId,sampled:120,labeled:119,skipped:1,retryRequests:1}});assert.match(progress,/value="120"/);assert.match(progress,/跳过/);
});
test('legacy run migrates saved labels and last invalid response without paying for earlier rows',async()=>{
  let calls=0;const f=await fixture(async(_url,options)=>++calls===3?{ok:false,status:401}:output(options));
  const run=await f.start();await settled(f.service,run.id);const runDir=path.join(f.directory,run.id);
  await fs.unlink(path.join(runDir,'checkpoint.json'));
  const selection=JSON.parse(await fs.readFile(path.join(runDir,'sampling.json'),'utf8'));delete selection.semanticSourceKeys;await fs.writeFile(path.join(runDir,'sampling.json'),JSON.stringify(selection));
  await fs.writeFile(path.join(runDir,'responses','3.json'),JSON.stringify({usage,finishReason:'stop',content:JSON.stringify({labels:[{id:'1','include|exclude|review':'include',evidence_id:'D1',skills:[],tasks:[]}]})}));
  const state=JSON.parse(await fs.readFile(path.join(runDir,'state.json'),'utf8'));Object.assign(state,{requestsStarted:3,requestsCompleted:3,promptTokens:300,completionTokens:90,totalTokens:390,costEstimate:3*cost});delete state.usageRecordedThrough;await fs.writeFile(path.join(runDir,'state.json'),JSON.stringify(state));
  let resumedCalls=0;const restored=createInsightSupervised(f.dir,{...f.options,readRows:async()=>{throw Error('cannot reselect legacy run');},fetcher:async(_url,options)=>{resumedCalls++;assert.match(JSON.parse(options.body).messages.at(-1).content,/上次响应/);return {ok:false,status:401};}});
  await restored.resume(run.id,{confirmed:true});const result=await settled(restored,run.id);
  assert.equal(result.labeled,2);assert.equal(resumedCalls,1);assert.equal(result.retryRequests,1);assert.ok(Math.abs(result.costEstimate-3*cost)<1e-10);
  const checkpoint=JSON.parse(await fs.readFile(path.join(runDir,'checkpoint.json'),'utf8'));assert.equal(checkpoint.errors.length,1);assert.equal(checkpoint.attempts[selection.samples[2].id],1);
});
test('HTTP 500 retries the same sample and reserves unknown usage inside original budget',async()=>{
  let calls=0;const f=await fixture(async(_url,options)=>++calls===1?{ok:false,status:500}:output(options));
  const run=await f.start(),result=await settled(f.service,run.id);
  assert.equal(result.status,'completed');assert.equal(result.labeled,120);assert.equal(calls,121);assert.equal(result.retryRequests,1);assert.equal(result.transientFailures,1);assert.equal(result.unknownUsageRequests,1);assert.ok(result.unknownUsageCost>0);
  assert.ok(Math.abs(result.costEstimate-(120*cost+result.unknownUsageCost))<1e-10);
});
test('persistent HTTP 429 skips individual rows then pauses after five, without assuming token fees',async()=>{
  let calls=0;const f=await fixture(async()=>{calls++;return {ok:false,status:429};});
  const run=await f.start(),result=await settled(f.service,run.id);assert.equal(calls,10);assert.equal(result.skipped,5);assert.equal(result.transientFailures,10);assert.equal(result.costEstimate,0);assert.equal(result.status,'failed');
});


test('default four lanes handle out-of-order responses without duplicate labels',async()=>{
  let active=0,peak=0,calls=0;const seen=new Set();
  const f=await fixture(async(_url,options)=>{
    const job=JSON.parse(JSON.parse(options.body).messages[1].content).jobs[0];
    assert.ok(!seen.has(job.title));seen.add(job.title);calls++;active++;peak=Math.max(peak,active);
    await new Promise(resolve=>setTimeout(resolve,calls%4===1?30:5));active--;
    return output(options);
  },{requestConcurrency:undefined});
  const run=await f.start(),result=await settled(f.service,run.id);
  assert.equal(result.status,'completed');assert.equal(peak,4);assert.equal(calls,120);assert.equal(result.labeled,120);assert.equal(result.requestConcurrency,4);assert.equal(result.inFlight,false);assert.deepEqual(result.pendingRequests,{});
  const checkpoint=JSON.parse(await fs.readFile(path.join(f.directory,run.id,'checkpoint.json'),'utf8'));assert.equal(new Set(checkpoint.labeled.map(row=>row.id)).size,120);
  assert.ok(Math.abs(result.costEstimate-120*cost)<1e-10);
  assert.equal(renderTrainingProgress({id:'test',runId:run.id,role,status:'completed'},{run:result}),'');
  assert.match(renderTrainingProgress({id:'test',runId:run.id,role,status:'labeling'},{run:result}),/并发 <strong>4<\/strong> 路/);
});

test('parallel reservations enforce the shared budget before dispatch',async()=>{
  let calls=0;const f=await fixture(async(_url,options)=>{
    calls++;const [entry]=JSON.parse(await fs.readFile(path.join(f.directory,'index.json'),'utf8'));
    const state=JSON.parse(await fs.readFile(path.join(f.directory,entry.id,'state.json'),'utf8'));
    assert.ok(state.costEstimate+state.pendingReserve<=state.budget+1e-12);
    assert.equal(state.pendingReserve,Object.values(state.pendingRequests).reduce((sum,item)=>sum+item.reserved,0));
    const response=output(options),payload=await response.json();payload.usage={prompt_tokens:100,completion_tokens:6000,total_tokens:6100};
    return {ok:true,json:async()=>payload};
  },{requestConcurrency:4});
  const run=await f.service.start({inputFile,role,sampleCount:120,budget:.05,jointAnnotations:true}),result=await settled(f.service,run.id);
  assert.equal(result.status,'failed');assert.match(result.message,/预算/);assert.ok(calls>0&&calls<4);assert.ok(result.costEstimate<=result.budget);assert.deepEqual(result.pendingRequests,{});
});

test('one disconnected lane drains successful peers and resumes only unfinished samples',async()=>{
  let calls=0;const successful=new Set();
  const f=await fixture(async(_url,options)=>{
    const number=++calls,job=JSON.parse(JSON.parse(options.body).messages[1].content).jobs[0];
    await new Promise(resolve=>setTimeout(resolve,number===2?30:5));
    if(number===1)throw Object.assign(new Error('temporary disconnect'),{code:'ECONNRESET'});
    successful.add(job.title);return output(options);
  },{requestConcurrency:4});
  const run=await f.start(),initial=await settled(f.service,run.id);
  assert.equal(calls,4);assert.equal(initial.status,'failed');assert.equal(initial.labeled,3);assert.equal(initial.unknownUsageRequests,1);assert.equal(initial.requestsCompleted,3);assert.deepEqual(initial.pendingRequests,{});
  let resumed=0;
  const restored=createInsightSupervised(f.dir,{...f.options,readRows:async()=>{throw Error('no resampling');},fetcher:async(_url,options)=>{resumed++;const job=JSON.parse(JSON.parse(options.body).messages[1].content).jobs[0];assert.ok(!successful.has(job.title));return output(options);}});
  await restored.resume(run.id,{confirmed:true});const result=await settled(restored,run.id);
  assert.equal(resumed,117);assert.equal(result.labeled,120);assert.equal(result.status,'completed');assert.equal(result.unknownUsageRequests,1);assert.ok(Math.abs(result.costEstimate-(120*cost+initial.unknownUsageCost))<1e-10);
});

test('crashed parallel wave replays saved peers and reserves each missing response once',async()=>{
  const requests=[];const f=await fixture(async(_url,options)=>{requests.push(options);return {ok:false,status:401};},{requestConcurrency:4});
  const run=await f.start();await settled(f.service,run.id);const folder=path.join(f.directory,run.id);
  const selected=JSON.parse(await fs.readFile(path.join(folder,'sampling.json'),'utf8'));
  const checkpoint=JSON.parse(await fs.readFile(path.join(folder,'checkpoint.json'),'utf8'));checkpoint.handledRequests=0;await fs.writeFile(path.join(folder,'checkpoint.json'),JSON.stringify(checkpoint));
  const state=JSON.parse(await fs.readFile(path.join(folder,'state.json'),'utf8'));
  const pendingRequests={};
  for(let index=0;index<4;index++){
    const n=index+1,sampleId=selected.samples[index].id;pendingRequests[n]={reserved:.02,sampleIds:[sampleId]};
    if(n===1||n===3){await fs.unlink(path.join(folder,'responses',n+'.json'));continue;}
    const payload=await output(requests[index]).json();
    await fs.writeFile(path.join(folder,'responses',n+'.json'),JSON.stringify({usage,content:payload.choices[0].message.content,finishReason:'stop',sampleIds:[sampleId]}));
  }
  Object.assign(state,{inFlight:true,pendingRequests,pendingReserve:.08,requestsCompleted:0,usageRecordedThrough:0,costEstimate:0,promptTokens:0,completionTokens:0,totalTokens:0,unknownUsageCost:0,unknownUsageRequests:0});await fs.writeFile(path.join(folder,'state.json'),JSON.stringify(state));
  let calls=0;const savedTitles=new Set([selected.samples[1].title,selected.samples[3].title]);
  const restored=createInsightSupervised(f.dir,{...f.options,fetcher:async(_url,options)=>{calls++;const job=JSON.parse(JSON.parse(options.body).messages[1].content).jobs[0];assert.ok(!savedTitles.has(job.title));return output(options);}});
  await restored.resume(run.id,{confirmed:true});const result=await settled(restored,run.id);
  assert.equal(result.status,'completed');assert.equal(calls,118);assert.equal(result.labeled,120);assert.equal(result.unknownUsageRequests,2);assert.equal(result.unknownUsageCost,.04);assert.ok(Math.abs(result.costEstimate-(120*cost+.04))<1e-10);assert.deepEqual(result.pendingRequests,{});
});

test('parallel validation retry affects only the failed sample',async()=>{
  let calls=0;const f=await fixture(async(_url,options)=>output(options,{invalid:++calls===1}),{requestConcurrency:4});
  const run=await f.start(),result=await settled(f.service,run.id);
  assert.equal(result.status,'completed');assert.equal(calls,121);assert.equal(result.labeled,120);assert.equal(result.retryRequests,1);assert.equal(result.skipped,0);
});

test('HTTP 429 lowers the following wave from four lanes to two',async()=>{
  let calls=0,active=0,peakAfterThrottle=0;
  const f=await fixture(async(_url,options)=>{
    const n=++calls;active++;if(n>4)peakAfterThrottle=Math.max(peakAfterThrottle,active);
    await new Promise(resolve=>setTimeout(resolve,5));active--;
    return n<=4?{ok:false,status:429}:output(options);
  },{requestConcurrency:4});
  const run=await f.start(),result=await settled(f.service,run.id);
  assert.equal(result.status,'completed');assert.equal(result.effectiveConcurrency,2);assert.equal(peakAfterThrottle,2);assert.equal(result.unknownUsageCost||0,0);assert.equal(result.labeled,120);assert.equal(calls,124);
});

test('cancel drains all four lanes and preserves a completed peer',async()=>{
  let calls=0,firstSaved;const first=new Promise(resolve=>firstSaved=resolve);
  const f=await fixture(async(_url,options)=>{
    const n=++calls;if(n===1){firstSaved();return output(options);}
    await new Promise((resolve,reject)=>{if(options.signal.aborted)return reject(options.signal.reason);options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});});
  },{requestConcurrency:4});
  const run=await f.start();await first;await new Promise(resolve=>setTimeout(resolve,20));await f.service.cancelRun(run.id);
  const result=await settled(f.service,run.id);
  assert.equal(calls,4);assert.equal(result.status,'cancelled');assert.equal(result.labeled,1);assert.equal(result.unknownUsageRequests,3);assert.deepEqual(result.pendingRequests,{});assert.ok(result.resumable);
});
