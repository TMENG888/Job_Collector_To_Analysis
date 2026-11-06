import os from 'node:os';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
const root=new URL('./',import.meta.url).href;
const {snapshotGrowth}=await import(root+'assistant_snapshot_policy.mjs');
const {createBackgroundAssistantStore}=await import(root+'assistant_index_loader.mjs');
const testRoot=process.env.JOB_TEST_WORK_DIR||(process.platform==='win32'?'E:/Codex/temp/job-assistant-snapshot-tests':path.join(os.tmpdir(),'job-assistant-snapshot-tests'));
await fs.mkdir(testRoot,{recursive:true});
const dir=await fs.mkdtemp(path.join(testRoot,'queue-'));
const until=async fn=>{for(let i=0;i<1500;i++){if(await fn())return;await delay(10);}throw Error('fixture wait exceeded');};
assert.equal(snapshotGrowth(100000,119999).reached,false);
assert.equal(snapshotGrowth(100000,120000).reached,true);
assert.equal(snapshotGrowth(101,121).reached,false);
assert.equal(snapshotGrowth(101,122).reached,true);
assert.equal(snapshotGrowth(0,0).reached,false);
assert.equal(snapshotGrowth(0,1).reached,true);
assert.equal(snapshotGrowth(100,90).reached,false);
assert.throws(()=>snapshotGrowth(100,NaN));
const workers=[];
class FixtureWorker extends EventEmitter{
  constructor(_url,options){super();this.options=options;workers.push(this);}
  terminate(){return Promise.resolve(0);}
}
let meta={revision:1,rows:100},available=true;
const store=createBackgroundAssistantStore(dir,{cacheDir:path.join(dir,'cache'),getMetadata:async()=>({...meta}),canRefresh:async()=>available,resourceProbe:async()=>{},pollMs:0,WorkerClass:FixtureWorker});
const index=(rows,revision)=>({jobs:[],frequencies:new Map(),tokenSets:new Map(),skills:[],report:{knowledge:true,roles:[],candidate_rows:rows,revision,generated_at:'fixture'},roleSnapshots:{}});
try{
  const first=store.load();await until(()=>workers.length===1);workers[0].emit('message',{type:'result',index:index(100,1)});await first;
  meta={rows:119,revision:2};await store.checkSnapshots();assert.equal(workers.length,1);
  assert.equal((await store.load()).report.snapshot.baseline_rows,100);
  meta={rows:120,revision:3};available=false;
  assert.equal((await store.checkSnapshots()).status,'queued');assert.equal(workers.length,1);
  available=true;await Promise.all([store.checkSnapshots(),store.checkSnapshots(),store.checkSnapshots()]);assert.equal(workers.length,2);
  assert.equal((await store.load()).report.candidate_rows,100);
  const other=createBackgroundAssistantStore(dir,{cacheDir:path.join(dir,'cache'),getMetadata:async()=>meta,resourceProbe:async()=>{},pollMs:0,WorkerClass:FixtureWorker});
  await assert.rejects(other.checkSnapshots(),e=>e.code==='ASSISTANT_SNAPSHOT_BUSY');other.close();
  meta={rows:125,revision:4};workers[1].emit('message',{type:'result',index:index(120,3)});
  let state=await store.snapshotStatus();assert.equal(state.baseline_rows,120);assert.equal(state.next_trigger_rows,144);
  await store.checkSnapshots();assert.equal(workers.length,2);
  meta={rows:144,revision:5};await store.checkSnapshots();assert.equal(workers.length,3);
  workers[2].emit('message',{type:'error',code:'OUTPUT_LOCKED',message:'fixture save failure'});
  state=await store.snapshotStatus();assert.equal(state.baseline_rows,120);assert.equal(state.status,'failed');
  assert.equal((await store.load()).report.candidate_rows,120);await store.checkSnapshots();assert.equal(workers.length,3);
  await store.refreshSnapshots();assert.equal(workers.length,4);assert.equal(workers[3].options.workerData.force,true);
  workers[3].emit('message',{type:'result',index:index(144,5)});
  meta={rows:145,revision:6};await store.checkSnapshots();assert.equal(workers.length,4);
  await store.refreshSnapshots();assert.equal(workers.length,5);workers[4].emit('message',{type:'result',index:index(145,6)});
  assert.equal((await store.snapshotStatus()).next_trigger_rows,174);
}finally{store.close();}
const before=workers.length;
meta={rows:100,revision:1};
const scheduled=createBackgroundAssistantStore(dir,{cacheDir:path.join(dir,'poll'),getMetadata:async()=>meta,resourceProbe:async()=>{},pollMs:20,WorkerClass:FixtureWorker});
try{
  await until(()=>workers.length>before);workers.at(-1).emit('message',{type:'result',index:index(100,1)});
  meta={rows:120,revision:2};await until(()=>workers.length>before+1);
  assert.equal((await scheduled.snapshotStatus()).reason,'growth_20_percent');
  workers.at(-1).emit('message',{type:'result',index:index(120,2)});
}finally{scheduled.close();}
console.log(JSON.stringify({passed:true,thresholdBoundary:true,rounding:true,zeroBaseline:true,belowThresholdNoRebuild:true,resourceQueue:true,singleWorker:true,crossProcessLock:true,serveOldWhileRefreshing:true,baselineAfterSuccessOnly:true,failureKeepsSnapshot:true,noAutomaticSameFailureRetry:true,manualOverride:true,timerTriggerWithoutQueries:true,paidRequests:0}));
