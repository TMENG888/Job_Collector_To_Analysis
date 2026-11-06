import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {createJobonlineLoginManager,readJobonlineWebsiteWindow,jobonlineLoginStatus,saveJobonlineLoginState} from './jobonline_login_session.mjs';
import {collectJobonlineLoggedWindow} from './jobonline_logged_collection.mjs';
import {launchOrdinaryChromeContext} from './ordinary_chrome_session.mjs';
import {renderCollectionDashboard} from '../job_collector_ui/public/collection-dashboard.js';
import {writeNativeChannelRows,readNativeTaskRows} from './collector_native_sink.mjs';
const base='E:/Codex/work/20261104-jobonline-login/tests';
await fs.mkdir(base,{recursive:true});
const city={name:'北京',code:'110100'};
const raw=id=>({id:String(id),positionName:'数据标注',cityCode:110100});
function pageFixture({loggedIn=true,body={code:200,object:{searchList:[raw(1)],moreList:[raw(1),raw(2)]}},responseError}={}){
  let calls=0;
  const page={url:()=> 'https://www.jobonline.cn/findPosition',waitForFunction:async()=>{},bringToFront:async()=>{},evaluate:async(fn,arg)=>{
    if(!arg)return {origin:'https://www.jobonline.cn',loggedIn};
    calls++;return responseError?{ok:false,code:responseError}:{ok:true,body};
  }};
  return {page,calls:()=>calls};
}
const requestFactory=options=>async(url,init)=>options.fetchImpl(url,init);
test('missing login prevents requests; cookie-shaped false positives are insufficient',async()=>{
  const f=pageFixture({loggedIn:false});await assert.rejects(readJobonlineWebsiteWindow(f.page,'数据标注',city,{requestFactory}),{code:'session_required'});assert.equal(f.calls(),0);
});
test('logged website response keeps both lists, deduplicates and avoids Node credentials',async()=>{
  const f=pageFixture();let init;
  const result=await readJobonlineWebsiteWindow(f.page,'数据标注',city,{requestFactory:options=>async(url,value)=>{init=value;return options.fetchImpl(url,value);}});
  assert.equal(result.returnedCount,3);assert.equal(result.list.length,2);assert.equal(result.moreCount,2);assert.equal(result.list[1].website_list,'moreList');assert.doesNotMatch(JSON.stringify(init),/cookie|token|authorization/i);
});
test('expired and verification responses stop without retry',async()=>{
  for(const [code,expected]of [['10002','session_required'],['403','verification_required']]){
    const f=pageFixture({responseError:code});await assert.rejects(readJobonlineWebsiteWindow(f.page,'数据标注',city,{requestFactory}),{code:expected});assert.equal(f.calls(),1);
  }
});
test('existing-only attachment cannot start a browser',async()=>{
  const profile=await fs.mkdtemp(path.join(base,'unconnected-'));let launches=0;
  await assert.rejects(launchOrdinaryChromeContext(profile,{executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',existingOnly:true,launch:()=>{launches++;throw Error('must not launch');}}),{code:'session_required'});
  assert.equal(launches,0);
});
test('manual confirmation requires real search success, not button acknowledgement',async()=>{
  const profile=await fs.mkdtemp(path.join(base,'manager-')),f=pageFixture();let options,closed=0;
  const manager=createJobonlineLoginManager({profile,launchContext:async(p,o)=>{options=o;return {ordinaryPage:async()=>f.page,close:async()=>{closed++;}};},readWindow:async()=>{throw Object.assign(Error('expired'),{code:'session_required'});}});
  await manager.open('数据标注');assert.match(options.executablePath,/Edge/);
  await assert.rejects(manager.verify('数据标注',city),{code:'session_required'});assert.equal(options.existingOnly,true);assert.equal(closed,2);
  const state=JSON.parse(await fs.readFile(path.join(profile,'jobonline-login-state.json'),'utf8'));assert.equal(state.state,'expired');assert.doesNotMatch(JSON.stringify(state),/cookie|token|secret/i);
});
test('success stores only safe metadata and disconnected profile prompts login again',async()=>{
  const profile=await fs.mkdtemp(path.join(base,'state-'));await saveJobonlineLoginState('verified',{profile});assert.equal((await jobonlineLoginStatus({profile})).state,'login_required');
});
test('larger logged window enters native-ingestion callback with dedup and retained history',async()=>{
  const retained=[{platform:'就业在线',job_id:'old',job_description:'历史完整职责'}];let checkpoint,ingested=[];
  const rows=await collectJobonlineLoggedWindow({keyword:'数据标注',city,retained,collectWindow:async()=>({list:Array.from({length:200},(_,i)=>raw(i)),searchCount:20,moreCount:180,returnedCount:200}),onCheckpoint:async value=>{checkpoint=value;},onRows:async values=>{ingested.push(...values);}});
  assert.equal(rows.length,201);assert.equal(ingested.length,200);assert.equal(checkpoint.more_count,180);assert.equal(checkpoint.completed,true);assert.equal(checkpoint.completion_scope,'logged_website_window');
  await assert.rejects(collectJobonlineLoggedWindow({keyword:'数据标注',city,retained,collectWindow:async()=>{throw Object.assign(Error('expired'),{code:'session_required'});}}),e=>e.code==='session_required'&&e.partialRows.length===1);
});
test('credentials check executes only boolean probes in the page',async()=>{
  let credentialProbe;
  const f=pageFixture();const original=f.page.evaluate;f.page.evaluate=async(fn,arg)=>{if(!arg)credentialProbe=fn.toString();return original(fn,arg);};
  await readJobonlineWebsiteWindow(f.page,'数据标注',city,{requestFactory});
  const result=vm.runInNewContext('('+credentialProbe+')()',{location:{origin:'https://www.jobonline.cn'},localStorage:{getItem:()=> 'secret'},document:{querySelectorAll:()=>[]}});
  assert.equal(result.loggedIn,true);assert.doesNotMatch(JSON.stringify(result),/secret/);
});
test('logged collection writes real isolated SQLite with 200 website rows and preserved other channels',async()=>{
  const directory=await fs.mkdtemp(path.join(base,'native-')),id=path.basename(directory);
  await fs.writeFile(path.join(directory,'任务归属.json'),JSON.stringify({task_id:id}));
  await writeNativeChannelRows(directory,id,[{platform:'就业在线',job_id:'historical',job_name:'历史岗位'},{platform:'国聘',job_id:'keep',job_name:'保留其他渠道'}]);
  const retained=await readNativeTaskRows(directory,id,'jobonline');
  await collectJobonlineLoggedWindow({keyword:'数据标注',city,retained,collectWindow:async()=>({list:Array.from({length:200},(_,i)=>raw(i)),searchCount:20,moreCount:180,returnedCount:200}),onRows:rows=>writeNativeChannelRows(directory,id,rows)});
  assert.equal((await readNativeTaskRows(directory,id,'jobonline')).length,201);
  assert.equal((await readNativeTaskRows(directory,id,'iguopin')).length,1);
});
test('login recovery is visible outside collapsed channel details and preserves verified control',()=>{
  const format={number:String,escapeHtml:String},task={id:'owned',status:'ready',platforms:['jobonline'],collectUntilExhausted:true,metrics:{knowledgeRows:258,liveCollection:{platformCounts:{jobonline:258}},jobonlineSession:{state:'login_required',label:'请先登录',connected:false}}};
  let html=renderCollectionDashboard(task,format);assert.ok(html.indexOf('jobonline-login-prompt')<html.indexOf('<details'));assert.match(html,/session-open-jobonline/);assert.doesNotMatch(html,/session-process-jobonline/);
  task.metrics.jobonlineSession={state:'pending',connected:true};html=renderCollectionDashboard(task,format);assert.match(html,/验证并继续采集/);
  task.metrics.jobonlineSession={state:'verified',connected:true};html=renderCollectionDashboard(task,format);assert.doesNotMatch(html,/class="jobonline-login-prompt"/);assert.match(html,/验证并续采/);
});
