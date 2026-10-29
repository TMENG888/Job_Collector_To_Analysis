import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {readCollectionSearchQueue,runAdaptiveCollection,collectionQueueStopReason} from './collection_search_queue.mjs';
import {collectionOutcome} from './collection_goal.mjs';
import {collectionCounts} from './collection_counts.mjs';
import {zhaopinSessionCheckpointPath,validateZhaopinSessionCheckpoint,zhaopinSessionCheckpointState} from './zhaopin_session_checkpoint.mjs';
import {collectZhaopinSession} from './direct_zhaopin_session.mjs';
import {isConditionScopedStop} from './task_collection_config.mjs';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'collection-recovery-'));
const write=async(file,data)=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(data));};
let checks=0;
try{
 const city={name:'北京',code:'530'},keyword='AI漫剧';
 const task={id:'owned',outputDir:dir,publicConfigPath:path.join(dir,'public.json'),zhaopinConfigPath:path.join(dir,'logged.json'),platforms:['zhaopin'],primaryKeyword:keyword,keywords:[keyword],cities:[city.name],collectUntilExhausted:true};
 const config={task_id:task.id,platforms:{zhaopin:{enabled:true,cities:[city],maxPages:60,maxRows:50000}}};
 await write(task.publicConfigPath,config);await write(task.zhaopinConfigPath,{task_id:task.id,acquisitionMode:'session_json_api',cities:[city],maxPages:60});
 const file=zhaopinSessionCheckpointPath(dir,keyword,city);
 // Only an explicit server end is terminal: count can be an estimate.
 const terminal={version:1,platform:'zhaopin',keyword,cityCode:city.code,total:1,rows:1,page:1,received:1,consumedAll:true,serverEnd:true,reason:'server_end'};
 let saved={task_id:task.id,keyword,city,total:1,rows:[{job_id:'one'}],completed:true,nextPage:null,pagination:terminal,acquisition_mode:'session_json_api'};
 await write(file,saved);
 // A stale legacy snapshot cannot overrule the active transport's cursor.
 await write(path.join(dir,'并发渠道状态.json'),{task_id:task.id,results:[{platform:'zhaopin',code:44}]});
 await write(path.join(dir,'断点数据','智联招聘_HTTP',`${keyword}_${city.name}.json`),{task_id:task.id,api_first_page_verified:true,complete:true,completion_reason:'confirmed_empty',records:[]});
 const rates=path.join(dir,'rates');const options={rateStateDir:rates,channelAvailable:()=>true,now:()=>1000};
 let queue=await readCollectionSearchQueue(task,options);assert.equal(queue[0].state,'query_finished');checks++;
 saved={...saved,completed:false,nextPage:2};await write(file,saved);
 queue=await readCollectionSearchQueue(task,options);assert.equal(queue[0].state,'pending');const previous=queue[0].progress;checks++;
 await write(file,{...saved,nextPage:3});assert.notEqual((await readCollectionSearchQueue(task,options))[0].progress,previous);checks++;
 for(const patch of [{task_id:'foreign'},{keyword:'其他岗位'},{city:{name:'上海',code:'538'}},{city:{name:'北京',code:'999'}},{nextPage:0},{acquisition_mode:'public_json_api'},{rows:[{}]},{completed:true,nextPage:2}]){
   await write(file,{...saved,...patch});await assert.rejects(readCollectionSearchQueue(task,options));checks++;
 }
 await write(file,saved);
 const key=createHash('sha256').update('https://fe-api.zhaopin.com').digest('hex').slice(0,24);
 await write(path.join(rates,key+'.json'),{cooldownUntil:9000});
 queue=await readCollectionSearchQueue(task,options);assert.equal(queue[0].state,'origin_cooldown');assert.equal(Date.parse(queue[0].retryAfter),9000);checks++;
 let calls=0;const result=await runAdaptiveCollection({task,count:async()=>1,readQueue:t=>readCollectionSearchQueue(t,options),run:async()=>calls++});
 assert.equal(result.reason,'waiting_cooldown');assert.equal(calls,0);assert.equal(collectionOutcome(task,{valid:1,reason:result.reason}).status,'partial');checks++;
 await write(file,{...saved,completed:true,nextPage:null});assert.equal((await readCollectionSearchQueue(task,options))[0].state,'query_finished');checks++;
 await write(file,saved);await write(path.join(dir,'采集清单.json'),{task_id:task.id,platforms:{zhaopin:{errors:[{keyword,city,code:'verification_required',stopChannel:false,conditionScoped:true}]}}});
 queue=await readCollectionSearchQueue(task,{...options,now:()=>10000});assert.equal(queue[0].state,'pending');assert.ok(isConditionScopedStop({code:'verification_required',conditionScoped:true,stopChannel:false}));assert.equal(isConditionScopedStop({code:'verification_required',stopChannel:true}),false);checks++;
 await write(path.join(dir,'采集清单.json'),{task_id:task.id,platforms:{zhaopin:{errors:[{keyword,city,code:'verification_required',stopChannel:true}]}}});
 assert.equal((await readCollectionSearchQueue(task,{...options,now:()=>10000}))[0].state,'channel_blocked');checks++;
 assert.equal(collectionQueueStopReason([{state:'query_finished'},{state:'channel_blocked'}]),'partially_blocked');
 assert.equal(collectionQueueStopReason([{state:'page_limit'}]),'conditions_deferred');
 assert.equal(collectionQueueStopReason([{state:'no_valid_growth'}]),'conditions_deferred');
 assert.equal(collectionOutcome(task,{valid:1,reason:'conditions_deferred'}).status,'partial');checks++;
 let step=0;
 const progressing=await runAdaptiveCollection({task,count:async()=>0,readQueue:async()=>[{platform:'zhaopin',keyword,city,state:step===2?'query_finished':'pending',progress:String(step)}],run:async()=>{step++;}});
 assert.equal(step,2,'advancing duplicate/incomplete pages must not be retired');assert.equal(progressing.reason,'search_queue_exhausted');checks++;
 const totals=collectionCounts({manifest:{total_rows:2549,platforms:{shixiseng:{rows:901},iguopin:{rows:500},mohrss:{rows:96},jobonline:{rows:236},job51:{rows:501},zhaopin:{rows:315}}}});
 assert.equal(totals.candidates,2549);assert.equal(totals.publicRows,2234);assert.equal(totals.zhaopinRows,315);checks++;
 const overlap=collectionCounts({manifest:{total_rows:3,platforms:{zhaopin:{rows:1},iguopin:{rows:2}}},native:{platformCounts:{zhaopin:1,iguopin:2}},live:{publicRows:3,platformCounts:{iguopin:2}}});assert.equal(overlap.candidates,3);checks++;
 assert.equal(collectionCounts({manifest:{total_rows:5},csv:{zhaopin:2}}).candidates,7);checks++;
 const noCredentials={cookie:'fixture'};let pages=[];
 const cap=await collectZhaopinSession(keyword,city,{session:noCredentials,maxPages:2,request:async(_url,init)=>{const p=JSON.parse(new TextDecoder().decode(init.body)).pageIndex;pages.push(p);return new Response(JSON.stringify({code:200,data:{statusCode:200,list:[{number:String(p),name:keyword}],count:100,isEndPage:0}}));}});
 assert.deepEqual(pages,[1,2]);assert.equal(cap.nextPage,3);assert.equal(cap.endReached,false);checks++;
 const capped={...saved,nextPage:cap.nextPage,pageLimitReached:cap.pageLimitReached};assert.equal(zhaopinSessionCheckpointState(capped,{maxPages:2}),'page_limit');assert.equal(zhaopinSessionCheckpointState(capped,{maxPages:3}),'pending');checks++;
 validateZhaopinSessionCheckpoint({...saved,completed:true,nextPage:null,rows:[]},{taskId:task.id,keyword,city});checks++;
 console.log(`PASS ${checks} collection recovery checks: shared session cursor, isolation, cooldown, scoped verification, no-growth progress, stop states, disjoint counts, page boundary`);
}finally{await fs.rm(dir,{recursive:true,force:true});}
