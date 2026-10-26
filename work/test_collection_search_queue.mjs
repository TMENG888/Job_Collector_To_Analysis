import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runAdaptiveCollection as runAdaptive,readCollectionSearchQueue as readQueue,checkpointSearchState,relatedCollectionKeywords} from './collection_search_queue.mjs';
// Historical checkpoint fixtures exercise scheduler semantics, not transport permission.
const readCollectionSearchQueue=task=>readQueue(task,{channelAvailable:()=>true,rateStateDir:null});
const runAdaptiveCollection=options=>runAdaptive({...options,readQueue:readCollectionSearchQueue});
import {jobonlineContinuation} from './jobonline_continuation.mjs';
import {readCollectionRound,filterCollectionCombinations,retainedChannelErrors} from './task_collection_config.mjs';

const dir=await fs.mkdtemp(path.join(os.tmpdir(),'collection-search-'));
const write=async(file,value)=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(value));};
const city=name=>({name,code:name});
let checks=0;
const task={id:'owned',targetRows:8,platforms:['jobonline','job51','zhaopin'],primaryKeyword:'测试工程师',keywords:['测试工程师','自动化测试工程师'],cities:['北京','深圳'],outputDir:dir,publicConfigPath:path.join(dir,'public.json'),zhaopinConfigPath:path.join(dir,'logged.json')};
const config={task_id:task.id,platforms:{jobonline:{enabled:true,cities:[city('全国')],maxRows:1000,totalMaxRows:100,maxPages:500},job51:{enabled:true,cities:[city('北京'),city('深圳')],maxPages:100}}};
const cp=async(platform,keyword,cityName,value)=>write(path.join(dir,'断点数据',platform==='zhaopin'?'智联招聘':'',`${platform==='zhaopin'?'':platform+'_'}${keyword}_${cityName}.json`),{task_id:task.id,...value});
const manifest=async value=>write(path.join(dir,'采集清单.json'),{task_id:task.id,platforms:value});
const setConfigs=async()=>{await write(task.publicConfigPath,config);await write(task.zhaopinConfigPath,{task_id:task.id,cities:[city('北京'),city('深圳')]});};
try{
  await setConfigs();
  const scoped={code:'pagination_stalled',stopChannel:true};
  assert.deepEqual(retainedChannelErrors({task_id:task.id,platforms:{jobonline:{errors:[scoped]}}},task.id,'jobonline','skip'),[]);checks++;
  const budget={mode:'checkpoint_rounds',start:0,limit:1000,totalLimit:12400};
  assert.deepEqual(jobonlineContinuation({budget,size:1000,checkpoints:[{completed:false,stop_reason:'pagination_stalled'},{completed:false,nextPageNo:2}],errors:[scoped],maxPages:500}),{safe:true,reason:'round_limit'});checks++;
  assert.equal(checkpointSearchState('jobonline',{stop_reason:'pagination_stalled',completed:false}), 'pagination_stalled');checks++;
  assert.equal(checkpointSearchState('job51',{completed:false,nextPageNo:101},{maxPages:100}),'page_limit');checks++;
  assert.equal(checkpointSearchState('jobonline',{completed:false,nextPageNo:501},{maxPages:500}),'page_limit');checks++;
  assert.equal(checkpointSearchState('jobonline',{completed:true,total:10000,records:[]}), 'legacy_pagination_unverified');checks++;
  assert.deepEqual(relatedCollectionKeywords({...task,primaryKeyword:'嵌入式测试工程师'}),[]);checks++;
  assert.deepEqual(relatedCollectionKeywords({...task,adaptiveSearch:false}),[]);checks++;
  const round=readCollectionRound(task.id,JSON.stringify({task_id:task.id,combinations:[{platform:'job51',keyword:'测试工程师',city:city('深圳')}]}));
  assert.deepEqual(filterCollectionCombinations(round,'job51',[{keyword:'测试工程师',city:city('北京')},{keyword:'测试工程师',city:city('深圳')}]),[{keyword:'测试工程师',city:city('深圳')}]);checks++;
  assert.throws(()=>readCollectionRound(task.id,JSON.stringify({task_id:'foreign',combinations:[]})),/归属/);checks++;
  assert.throws(()=>filterCollectionCombinations(round,'job51',[{keyword:'测试工程师',city:city('北京')}]),/超出/);checks++;

  // A stalled condition and an unavailable login cannot suppress the healthy
  // keyword or the second selected city on another platform.
  await cp('jobonline','测试工程师','全国',{completed:false,stop_reason:'pagination_stalled'});
  await cp('job51','测试工程师','北京',{completed:true});
  await manifest({jobonline:{rows:2,errors:[scoped]}});
  await write(path.join(dir,'并发渠道状态.json'),{task_id:task.id,results:[{platform:'zhaopin',code:44}]});
  let valid=2,visits=[];
  const result=await runAdaptiveCollection({task,count:async()=>valid,run:async({combinations})=>{
    visits.push(...combinations);
    assert.ok(combinations.every(c=>c.platform!=='zhaopin'));
    assert.ok(!combinations.some(c=>c.platform==='jobonline'&&c.keyword==='测试工程师'));
    for(const c of combinations)await cp(c.platform,c.keyword,c.city.name,{completed:true,records:[]});
    valid=8;
  }});
  assert.equal(result.targetReached,true);checks++;
  assert.ok(visits.some(c=>c.platform==='job51'&&c.city.name==='深圳'));checks++;
  assert.ok(visits.some(c=>c.platform==='jobonline'&&c.keyword==='自动化测试工程师'));checks++;

  // New related terms run even after a zero-growth batch. No automatic city
  // expansion, and no reattempt of a previously blocked login on a later round.
  task.keywords=['测试工程师'];task.targetRows=20;
  let activated=[],rounds=0;
  const expanded=await runAdaptiveCollection({task,count:async()=>0,activateKeyword:async keyword=>activated.push(keyword),run:async({combinations})=>{
    rounds++;
    assert.ok(combinations.every(c=>c.platform!=='zhaopin'));
    assert.ok(combinations.filter(c=>c.platform==='job51').every(c=>task.cities.includes(c.city.name)));
    // A public-only round overwrites the concurrent runner snapshot. The
    // scheduler must still remember the failed zhaopin login for this run.
    await write(path.join(dir,'并发渠道状态.json'),{task_id:task.id,results:[{platform:'public',code:0}]});
    for(const c of combinations)await cp(c.platform,c.keyword,c.city.name,{completed:true,records:[]});
  }});
  assert.equal(expanded.reason,'partially_blocked');checks++;
  assert.ok(activated.includes('软件测试')&&activated.includes('测试开发工程师'));checks++;
  assert.ok(rounds>1);checks++;
  const journal=JSON.parse(await fs.readFile(path.join(dir,'采集调度状态.json'),'utf8'));
  assert.equal(journal.task_id,task.id);assert.deepEqual(journal.cities,['北京','深圳']);checks++;
  assert.ok(journal.queue.some(c=>c.state==='channel_blocked'&&c.platform==='zhaopin'));checks++;

  let calls=0;
  assert.equal((await runAdaptiveCollection({task,count:async()=>20,run:async()=>calls++})).targetReached,true);assert.equal(calls,0);checks++;
  const paused=await runAdaptiveCollection({task,count:async()=>0,isCancelled:()=>true,run:async()=>calls++});
  assert.equal(paused.paused,true);assert.equal(calls,0);checks++;
  const publicOnly={...task,platforms:['job51'],primaryKeyword:'自定义岗位',keywords:['自定义岗位'],targetRows:1};
  let one=0;
  assert.equal((await runAdaptiveCollection({task:publicOnly,count:async()=>one,run:async({platforms})=>{assert.deepEqual(platforms,['job51']);one=1;}})).targetReached,true);checks++;
  let cancelled=false;
  const cancelledResult=await runAdaptiveCollection({task:publicOnly,count:async()=>0,onRound:async()=>{cancelled=true;},isCancelled:()=>cancelled,run:async()=>calls++});
  assert.equal(cancelledResult.paused,true);assert.equal(calls,0);checks++;
  const bounded=await runAdaptiveCollection({task:publicOnly,count:async()=>0,maxRounds:1,run:async()=>{}});
  assert.equal(bounded.reason,'round_budget_finished');assert.equal(bounded.rounds,1);checks++;
  const mixed={...publicOnly,primaryKeyword:'指纹测试',keywords:['指纹测试'],targetRows:2};
  let mixedValid=0,mixedCalls=[];
  await runAdaptiveCollection({task:mixed,count:async()=>mixedValid,run:async({combinations})=>{
    mixedCalls.push(combinations.map(c=>c.city.name));mixedValid++;
    await cp('job51','指纹测试','北京',{completed:false,nextPageNo:mixedValid+1,records:Array.from({length:mixedValid},()=>({}))});
  }});
  assert.deepEqual(mixedCalls,[['北京','深圳'],['北京']],'one stuck city must not replay just because another city grows');checks++;
  await write(task.publicConfigPath,{...config,task_id:'foreign'});
  await assert.rejects(readCollectionSearchQueue(task),/任务 ID/);checks++;
  await setConfigs();await cp('job51','测试工程师','北京',{task_id:'foreign'});
  await assert.rejects(readCollectionSearchQueue(task),/任务 ID/);checks++;
  console.log(`PASS ${checks} search queue checks: scoped stalls, multiple keywords/cities, zero-growth rotation, conservative expansion, sticky login block, target, pause, limits and ownership`);
}finally{await fs.rm(dir,{recursive:true,force:true});}
