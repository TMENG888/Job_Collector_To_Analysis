import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {checkedJsonResponse,boundedFetch,collectionExitCode,stageDisposition} from './collection_policy.mjs';
import {createManualSearchSession} from './manual_search_session.mjs';
let checks=0;
const verify=(condition,message)=>{assert.ok(condition,message);checks++;};
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'collector-resilience-'));
verify(collectionExitCode({code:'RESOURCE_PRESSURE'})===43,'resource pause');
for(const code of ['OUTPUT_LOCKED','ENOSPC','EPERM'])verify(collectionExitCode({code})===42,code+' global pause');
verify(collectionExitCode({code:'USER_ACTION_REQUIRED'})===44,'channel block distinct');
verify(stageDisposition(44,true)==='continue_partial','pipeline continues');
verify(stageDisposition(44,false)==='pause','standalone pauses');
for(const code of [42,43])verify(stageDisposition(code,true)==='pause','never skip unsafe output/resources');
verify(stageDisposition(1,true)==='fail','unknown errors not hidden');
assert.deepEqual(await checkedJsonResponse(new Response('{"items":[]}')), {items:[]});checks++;
for(const html of ['<textarea id="renderData">WAF</textarea>','<!doctype html><meta name="aliyun_waf_aa">','<html>访问验证</html>']) {
  await assert.rejects(checkedJsonResponse(new Response(html),'前程'), e=>e.code==='verification_required'&&e.stopChannel);checks++;
}
for(const status of [401,403,429,404]) {
  let calls=0;
  await assert.rejects(boundedFetch('https://fixture.invalid',{}, {fetchImpl:async()=>{calls++;return new Response('blocked',{status});},wait:async()=>{}}));
  verify(calls===1,'no automatic retry for HTTP '+status);
}
let calls=0;
await boundedFetch('https://fixture.invalid',{}, {fetchImpl:async()=>{calls++;return new Response('{}',{status:calls<3?503:200});},wait:async()=>{}});
verify(calls===3,'bounded 5xx recovery');
calls=0;
await assert.rejects(boundedFetch('https://fixture.invalid',{}, {attempts:99,fetchImpl:async()=>{calls++;throw new TypeError('network failed');},wait:async()=>{}}));
verify(calls===4,'retry upper bound');
calls=0;
await assert.rejects(boundedFetch('https://fixture.invalid',{}, {fetchImpl:async()=>{calls++;return new Response('<html>访问验证</html>');},wait:async()=>{}}),e=>e.code==='verification_required');
verify(calls===1,'HTML verification never retried');
const page={url:()=> 'https://www.zhaopin.com/jobs',isClosed:()=>false,locator:()=>({innerText:async()=> '请先登录',filter:()=>({allInnerTexts:async()=>[]})}),bringToFront:async()=>{throw Error('skip must not wait for human');}};
const session=await createManualSearchSession(dir,'same-task',page,{onBlocked:'skip',settleMs:0});
await assert.rejects(session.guard({keyword:'数据分析师',city:{name:'北京'}}),e=>e.code==='USER_ACTION_REQUIRED');checks++;
const state=JSON.parse(await fs.readFile(path.join(dir,'智联招聘_浏览器会话.json'),'utf8'));
verify(state.task_id==='same-task'&&state.verification_status==='waiting_human','scoped diagnostic evidence');
await session.close();
console.log(JSON.stringify({ok:true,checks,testDir:dir}));
