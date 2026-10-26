import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runHybridCollection} from './collect_hybrid_channels.mjs';
import {HYBRID_MODE} from './channel_acquisition.mjs';
import {writeNativeChannelRows,readNativeTaskRows} from './collector_native_sink.mjs';
import {readCollectionSearchQueue,checkpointSearchState} from './collection_search_queue.mjs';
import {browserCheckpointPath} from './browser_dom_collection.mjs';
import {writeJsonAtomic} from './collector_storage.mjs';

const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hybrid-collection-'));
const priorRateDir=process.env.JOB_HTTP_RATE_DIR;process.env.JOB_HTTP_RATE_DIR=path.join(dir,'rates');
const row={platform:'就业在线',job_id:'fixture-001',job_name:'销售工程师',company_name:'隔离测试公司',city:'北京',job_url:'https://www.jobonline.cn/positionDetail?id=fixture-001',job_description:'负责设备销售与技术方案沟通，为客户提供技术咨询和售后支持。'};
const city={name:'全国',code:'全国'};
async function setup(id,platforms){
  const outputDir=path.join(dir,id);await fs.mkdir(outputDir);
  await writeJsonAtomic(path.join(outputDir,'任务归属.json'),{task_id:id});
  const publicConfigPath=path.join(outputDir,'config.json'),zhaopinConfigPath=path.join(outputDir,'logged.json');
  await writeJsonAtomic(publicConfigPath,{task_id:id,transportMode:HYBRID_MODE,keywords:['销售工程师'],browser:{maxPages:2,maxRows:3},platforms:Object.fromEntries(platforms.map(p=>[p,{enabled:true,cities:[city]}]))});
  await writeJsonAtomic(zhaopinConfigPath,{task_id:id,cities:[city]});
  return {taskId:id,outputDir,publicConfigPath,zhaopinConfigPath,platforms,lockDir:path.join(dir,'locks')};
}
try{
  let http=0,browser=0;
  const settings=await setup('hybrid-success',['iguopin','jobonline']);
  const code=await runHybridCollection(settings,{resourceGuard:async()=>{},runHttp:async input=>{http++;assert.equal(input.public,true);assert.equal(input.zhaopin,false);const config=JSON.parse(await fs.readFile(input.publicConfigPath,'utf8'));assert.equal(config.platforms.jobonline.enabled,false);return 0;},runBrowser:async options=>{browser++;await writeNativeChannelRows(options.outputDir,options.taskId,[row]);return {rows:1,valid:1,errors:[],transport:'browser_dom'};}});
  assert.equal(code,0);assert.equal(http,1);assert.equal(browser,1);assert.equal((await readNativeTaskRows(settings.outputDir,settings.taskId)).length,1);
  const legacy=await setup('legacy',['jobonline']);const config=JSON.parse(await fs.readFile(legacy.publicConfigPath));config.transportMode='direct_http_validated_data';await writeJsonAtomic(legacy.publicConfigPath,config);
  await assert.rejects(runHybridCollection(legacy,{resourceGuard:async()=>{}}),/未明确启用/);
  const denied=await setup('denied',['zhaopin']);
  const deniedCode=await runHybridCollection(denied,{resourceGuard:async()=>{},runHttp:async()=>{await writeJsonAtomic(path.join(denied.outputDir,'智联招聘_采集状态.json'),{task_id:denied.taskId,errors:[{code:'verification_required'}]});return 44;},runBrowser:async()=>{throw Error('must not start browser');}});
  assert.equal(deniedCode,44);
  const resource=await setup('resource',['iguopin','jobonline']);
  assert.equal(await runHybridCollection(resource,{resourceGuard:async()=>{},runHttp:async()=>43,runBrowser:async()=>{throw Error('must not start browser');}}),43);
  const output=await setup('output-failure',['jobonline','liepin']);let unsafeCalls=0;
  assert.equal(await runHybridCollection(output,{resourceGuard:async()=>{},runBrowser:async()=>{unsafeCalls++;return {rows:0,errors:[{code:'ENOENT',stopChannel:true}]};}}),42);assert.equal(unsafeCalls,1,'output failure stops later browser channels');
  const paused=await setup('prior-stop',['jobonline']);await writeJsonAtomic(path.join(paused.outputDir,'RPA_jobonline_状态.json'),{task_id:paused.taskId,errors:[{code:'layout_changed',stopChannel:true}]});
  assert.equal(await runHybridCollection(paused,{resourceGuard:async()=>{},runBrowser:async()=>{throw Error('must not retry stopped channel');}}),44);
  // Global lock serializes browser workers even for different tasks.
  const a=await setup('parallel-a',['jobonline']),b=await setup('parallel-b',['jobonline']);let active=0,peak=0;
  const worker=async()=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,60));active--;return {rows:0,errors:[]};};
  await Promise.all([a,b].map(s=>runHybridCollection(s,{resourceGuard:async()=>{},runBrowser:worker})));assert.equal(peak,1);
  const checkpoint=browserCheckpointPath(settings.outputDir,'jobonline','销售工程师',city);
  await fs.mkdir(path.dirname(checkpoint),{recursive:true});
  await writeJsonAtomic(checkpoint,{task_id:settings.taskId,acquisition_mode:'browser_dom',budget_finished:true,records:[row]});
  const queue=await readCollectionSearchQueue({id:settings.taskId,transportMode:HYBRID_MODE,platforms:['jobonline'],primaryKeyword:'销售工程师',keywords:['销售工程师'],outputDir:settings.outputDir,publicConfigPath:settings.publicConfigPath});
  assert.equal(queue[0].state,'browser_budget_limit');
  assert.equal(checkpointSearchState('jobonline',{acquisition_mode:'browser_dom',completed:true,records:[]}),'empty_unverified');
  assert.equal((await fs.readdir(settings.outputDir)).some(f=>f.endsWith('.csv')),false);
  console.log('PASS hybrid orchestrator (injected workers/resource probe): HTTP-first routing, no denied fallback, resource stop, legacy opt-in, sticky failures, global single worker, native SQLite, independent RPA queue budget.');
}finally{if(priorRateDir===undefined)delete process.env.JOB_HTTP_RATE_DIR;else process.env.JOB_HTTP_RATE_DIR=priorRateDir;}
