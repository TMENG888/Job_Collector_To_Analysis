import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {ensureChannelManifest,readChannelVerification,verificationDiagnostic} from './channel_verification_state.mjs';
import {markChannelReady} from './manual_channel_session.mjs';
import {createChannelVerification} from './channel_manual_verification.mjs';
import {writeNativeChannelRows,nativeTaskCounts} from './collector_native_sink.mjs';
import {renderCollectionDashboard} from '../job_collector_ui/public/collection-dashboard.js';

const root=path.resolve(import.meta.dirname,'..');
const workspace=process.env.JOB_TEST_WORK_DIR||'E:/Codex/work/20261103-channel-manifest';
await fs.mkdir(workspace,{recursive:true});
const read=file=>fs.readFile(file,'utf8').then(JSON.parse);
const write=(file,value)=>fs.writeFile(file,JSON.stringify(value));
async function fixture(){
  const directory=await fs.mkdtemp(path.join(workspace,'task-'));
  const task={id:path.basename(directory),outputDir:directory,publicConfigPath:path.join(directory,'public.json'),platforms:['job51','liepin','zhaopin']};
  const config={task_id:task.id,keywords:['测试工程师'],platforms:{job51:{enabled:true,cities:[{name:'广州',code:'030200'}]},liepin:{enabled:true,cities:[{name:'广州',code:'050020'}]},zhaopin:{enabled:true,cities:[{name:'广州',code:'763'}]}}};
  const manifest={task_id:task.id,total_rows:3,note:'preserve-existing',platforms:{}};
  await write(path.join(directory,'任务归属.json'),{task_id:task.id});
  await write(task.publicConfigPath,config);
  await write(path.join(directory,'采集清单.json'),manifest);
  await writeNativeChannelRows(directory,task.id,[{platform:'前程无忧',job_id:'1',job_name:'软件测试'},{platform:'猎聘',job_id:'2',job_name:'软件测试'},{platform:'智联招聘',job_id:'3',job_name:'软件测试'}]);
  return {task,config,manifest,file:path.join(directory,'采集清单.json')};
}

test('empty manifest initializes three selected channels without changing jobs, counts or existing fields',async()=>{
  const f=await fixture(),before=await nativeTaskCounts(f.task.outputDir,f.task.id);
  await Promise.all(f.task.platforms.map(platform=>ensureChannelManifest(f.task,platform)));
  const saved=await read(f.file);
  assert.deepEqual(Object.keys(saved.platforms).sort(),f.task.platforms.toSorted());
  for(const channel of Object.values(saved.platforms))assert.deepEqual(channel,{errors:[]});
  assert.equal(saved.total_rows,3);assert.equal(saved.note,f.manifest.note);
  assert.deepEqual(await nativeTaskCounts(f.task.outputDir,f.task.id),before);
  const bytes=await fs.readFile(f.file,'utf8');await ensureChannelManifest(f.task,'job51');assert.equal(await fs.readFile(f.file,'utf8'),bytes);
});

test('missing summary initializes metadata without inventing collection or verification success',async()=>{
  const f=await fixture();await fs.unlink(f.file);
  const saved=await ensureChannelManifest(f.task,'job51');
  assert.equal(saved.task_id,f.task.id);assert.deepEqual(saved.platforms,{job51:{errors:[]}});
  assert.equal(saved.total_rows,undefined);assert.equal(saved.status,undefined);
  assert.deepEqual(await readChannelVerification(f.task),{});
});

test('unselected, disabled, foreign configuration and foreign task output are rejected without modifying the manifest',async()=>{
  for(const kind of ['unselected','disabled','foreign-config','foreign-owner','foreign-manifest']){
    const f=await fixture();
    if(kind==='unselected')f.task.platforms=[];
    if(kind==='disabled'){f.config.platforms.job51.enabled=false;await write(f.task.publicConfigPath,f.config);}
    if(kind==='foreign-config'){f.config.task_id='foreign';await write(f.task.publicConfigPath,f.config);}
    if(kind==='foreign-owner')await write(path.join(f.task.outputDir,'任务归属.json'),{task_id:'foreign'});
    if(kind==='foreign-manifest'){f.manifest.task_id='foreign';await write(f.file,f.manifest);}
    const bytes=await fs.readFile(f.file,'utf8');await assert.rejects(ensureChannelManifest(f.task,'job51'));
    assert.equal(await fs.readFile(f.file,'utf8'),bytes,kind);
    assert.equal(await fs.stat(path.join(f.task.outputDir,'渠道核验状态.json')).catch(()=>null),null);
  }
});

test('corrupt summary and channel structures are preserved for diagnosis',async()=>{
  const f=await fixture();
  for(const value of [null,[],{...f.manifest,platforms:null},{...f.manifest,platforms:{job51:{errors:'invalid'}}}]){
    await write(f.file,value);const bytes=await fs.readFile(f.file,'utf8');
    await assert.rejects(ensureChannelManifest(f.task,'job51'),/结构无效/);
    assert.equal(await fs.readFile(f.file,'utf8'),bytes);
  }
});

test('confirmation preserves unrelated errors and previously resolved history',async()=>{
  const f=await fixture();
  f.manifest.platforms.job51={rows:1,errors:[{code:'login_required'},{code:'verification_required'},{code:'api_schema_changed'},{code:'access_blocked',resolved_at:'old'}]};
  f.manifest.platforms.liepin={rows:1,errors:[{code:'verification_required'}]};await write(f.file,f.manifest);
  const result=await markChannelReady(f.task,'job51',{state:'logged_in'});
  assert.equal(result.state,'manual_checked');assert.equal(result.verifiedAt,null);assert.equal(result.resolvedCount,1);
  const saved=await read(f.file);
  assert.ok(saved.platforms.job51.errors[0].resolved_at);
  assert.equal(saved.platforms.job51.errors[1].resolved_at,undefined);assert.equal(saved.platforms.job51.errors[2].resolved_at,undefined);
  assert.equal(saved.platforms.job51.errors[3].resolved_at,'old');assert.deepEqual(saved.platforms.liepin,f.manifest.platforms.liepin);
});

test('ordinary browser acknowledgment remains unverified and exposes manual continuation',async()=>{
  const f=await fixture(),manager=createChannelVerification();
  const finished=await manager.finish(f.task,'job51');
  assert.equal(finished.state,'manual_checked');assert.equal(finished.verifiedAt,null);assert.doesNotMatch(finished.message,/复检采集会话|搜索已核验/);
  const state=await readChannelVerification(f.task);assert.equal(state.job51.state,'manual_checked');
  assert.equal(verificationDiagnostic(null,state.job51).label,'已处理，待采集验证');
  const html=renderCollectionDashboard({...f.task,status:'paused',metrics:{knowledgeRows:3,channelVerification:state}},{number:String,escapeHtml:String});
  assert.match(html,/data-action="session-resume-job51"/);assert.doesNotMatch(html,/data-action="verify-recheck-/);
});

test('observed website success can finish with a missing channel; an unverified window cannot',async()=>{
  const f=await fixture(),page=new EventEmitter(),context=new EventEmitter();let url='about:blank',closed=0;
  page.url=()=>url;page.goto=async value=>{url=value;};page.bringToFront=async()=>{};
  page.locator=()=>({filter(){return this;},allInnerTexts:async()=>[],innerText:async()=> '岗位列表'});
  context.pages=()=>[page];context.close=async()=>{closed++;context.emit('close');};
  const manager=createChannelVerification({openContext:async()=>({context,owned:true,release:async()=>{}})});
  await manager.open(f.task,'job51',f.config,f.manifest,{mode:'collector'});
  await assert.rejects(manager.finish(f.task,'job51'),/尚未观察到官网搜索成功/);
  assert.deepEqual((await read(f.file)).platforms,{});
  page.emit('response',{url:()=> 'https://we.51job.com/api/job/search-pc',status:()=>200,json:async()=>({status:'1',resultbody:{job:{totalCount:1,items:[{jobId:'1'}]}}})});
  for(let attempt=0;attempt<100&&manager.status(f.task.id).job51?.state!=='ready';attempt++)await new Promise(resolve=>setTimeout(resolve,5));
  const result=await manager.finish(f.task,'job51');assert.equal(result.state,'verified');assert.ok(result.verifiedAt);assert.equal(closed,1);
  assert.deepEqual((await read(f.file)).platforms,{job51:{errors:[]}});assert.equal((await readChannelVerification(f.task)).job51.state,'verified');
});

test('real HTTP confirmation accepts missing summaries and preserves unverified and disabled-channel states',async()=>{
  const directory=await fs.mkdtemp(path.join(workspace,'http-')),probe=http.createServer();
  await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const child=spawn(process.execPath,['job_collector_ui/server.mjs',String(port)],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,JOB_UI_DATA_DIR:directory,JOB_UI_OPEN_BROWSER:'0',JOB_UI_START_WORKER:'0',JOB_TASK_OUTPUT_ROOT:path.join(directory,'outputs'),JOB_TASK_BACKUP_ROOT:path.join(directory,'backups'),JOB_INSIGHT_SEMANTIC_DIR:path.join(directory,'semantics'),JOB_ROLE_DISCOVERY_DIR:path.join(directory,'discovery')}});
  let logs='';child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
  const base='http://127.0.0.1:'+port,post=(route,body)=>fetch(base+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  try{
    let ready=false;for(let attempt=0;attempt<100;attempt++){try{if((await fetch(base+'/api/tasks')).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,50));}assert.ok(ready,logs);
    const retired=await post('/api/tasks',{label:'已撤下渠道回归',primaryKeyword:'测试工程师',keywords:['测试工程师'],cities:['广州'],platforms:['liepin'],targetRows:2});
    assert.equal(retired.status,400);assert.match((await retired.json()).error,/渠道已撤下/);
    const response=await post('/api/tasks',{label:'渠道清单隔离回归',primaryKeyword:'测试工程师',keywords:['测试工程师'],cities:['广州'],platforms:['job51'],targetRows:2});
    assert.equal(response.status,201,await response.clone().text());const {task}=await response.json();
    const route=platform=>'/api/tasks/'+encodeURIComponent(task.id)+'/channels/'+platform+'/session/mark';
    for(const platform of ['job51']){
      const confirmed=await post(route(platform),{state:'verified'});assert.equal(confirmed.status,200,await confirmed.clone().text());
      const result=await confirmed.json();assert.equal(result.state,'manual_checked');assert.equal(result.verifiedAt,null);assert.doesNotMatch(result.message,/官网搜索已核验|冷却已清理/);
    }
    const file=path.join(task.outputDir,'采集清单.json'),before=await fs.readFile(file,'utf8');
    const rejected=await post(route('zhaopin'),{state:'verified'});assert.equal(rejected.status,400);assert.match((await rejected.json()).error,/未在当前任务中启用/);
    assert.equal(await fs.readFile(file,'utf8'),before);
    assert.deepEqual(Object.keys((await read(file)).platforms),['job51']);
    assert.equal((await fetch(base+'/api/tasks').then(r=>r.json())).activeCount,0);
    assert.doesNotMatch(logs,/▶ 多平台/);
  }finally{child.kill();if(child.exitCode===null)await new Promise(resolve=>child.once('exit',resolve));}
});
