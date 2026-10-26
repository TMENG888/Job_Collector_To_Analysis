import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {writeNativeChannelRows,readNativeTaskRows} from './collector_native_sink.mjs';
const root=path.resolve(import.meta.dirname,'..'),dir=await fs.mkdtemp(path.join(os.tmpdir(),'direct-console-'));
const preload=path.join(dir,'preload.mjs'),loader=path.join(dir,'loader.mjs'),resources=path.join(dir,'resources.mjs'),calls=path.join(dir,'calls.jsonl');
await fs.writeFile(resources,`export async function assertCollectorResources(){return {}};export function nativeCrashMessage(){return null};export async function readMemorySnapshot(){return {}};export function resourceDecision(){return {ok:true}};`);
await fs.writeFile(loader,`export async function resolve(specifier,context,next){
 if(/(?:browser_public_channels|liepin_channel|job51\\/collector)\\.mjs$/.test(specifier))throw Error('BROWSER ADAPTER IMPORT FORBIDDEN');
 if(specifier.endsWith('collector_resources.mjs'))return {url:${JSON.stringify(pathToFileURL(resources).href)},shortCircuit:true};
 return next(specifier,context);
}`);
await fs.writeFile(preload,`import fs from 'node:fs/promises';import {createHash} from 'node:crypto';
const original=globalThis.fetch;globalThis.fetch=async(value,options)=>{
 const url=new URL(value);if(['localhost','127.0.0.1'].includes(url.hostname))return original(value,options);
 if(url.hostname!=='www.shixiseng.com')throw Error('UNEXPECTED EXTERNAL REQUEST');
 const keyword=url.searchParams.get('keyword')||'',uuid='inn_'+createHash('sha256').update(keyword).digest('hex').slice(0,12);
 await fs.appendFile(${JSON.stringify(calls)},JSON.stringify({path:url.pathname,keyword,at:Date.now(),pid:process.pid})+'\\n');
 const detail=url.pathname.includes('/info/');const msg=detail?{iname:'测试工程师',cname:'隔离验收公司',city:'北京',info:'负责软件质量保障、自动化测试、接口测试和缺陷分析，维护测试环境与回归验证流程。'}:{total:1,pageNumber:20,data:[{uuid,name:keyword,city:'北京',cname:'隔离验收公司'}]};
 return new Response(JSON.stringify({code:100,msg}),{headers:{'content-type':'application/json'}});
};`);
const port=19887,base='http://127.0.0.1:'+port;let child,logs='';
function start(){child=spawn(process.execPath,['job_collector_ui/server.mjs',String(port)],{cwd:root,env:{...process.env,NODE_OPTIONS:`--experimental-loader=${pathToFileURL(loader).href} --import=${pathToFileURL(preload).href}`,JOB_UI_DATA_DIR:dir,JOB_UI_START_WORKER:'0',JOB_UI_OPEN_BROWSER:'0'},windowsHide:true});child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x);}
async function stop(){if(child&&child.exitCode===null){child.kill();await new Promise(r=>child.once('close',r));}}
async function wait(fn){for(let i=0;i<500;i++){if(await fn().catch(()=>false))return;await new Promise(r=>setTimeout(r,100));}throw Error('timeout: '+logs.slice(-5000));}
async function api(route,body,expected){const r=await fetch(base+route,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const value=await r.json();if(expected)assert.equal(r.status,expected,JSON.stringify(value));else assert.ok(r.ok,JSON.stringify(value));return value;}
try{
 start();await wait(async()=>(await fetch(base+'/api/state')).ok);
 const state=await api('/api/state');assert.equal(state.capabilities.collectionTransportPolicy.browserAutomation,false);assert.equal(state.capabilities.job51Collection,false);
 const input={label:'纯接口隔离验收',primaryKeyword:'测试工程师',keywords:['测试工程师','自动化测试工程师'],targetRows:4,candidateTarget:10,cities:['北京'],platforms:['shixiseng'],outputDir:path.join(dir,'output')};
 await api('/api/tasks',{...input,platforms:['job51']},400);
 await api('/api/platforms/zhaopin/login',{},400);
 const {task}=await api('/api/tasks',input),route='/api/tasks/'+encodeURIComponent(task.id);
 await stop();
 const tasksFile=path.join(dir,'tasks.json'),tasks=JSON.parse(await fs.readFile(tasksFile,'utf8'));
 tasks[0].platforms.push('job51','liepin');await fs.writeFile(tasksFile,JSON.stringify(tasks));
 const historical={platform:'前程无忧',job_id:'historical',job_name:'测试工程师',query_keyword:'测试工程师',city:'北京',company_name:'历史公司',job_url:'https://example.invalid/historical',job_description:'负责软件测试和接口质量验证，制定测试用例与自动化回归测试流程。'};
 await writeNativeChannelRows(task.outputDir,task.id,[historical]);
 const checkpoint=path.join(task.outputDir,'断点数据','job51_测试工程师_北京.json');await fs.mkdir(path.dirname(checkpoint),{recursive:true});const old=JSON.stringify({task_id:task.id,nextPageNo:5,records:[historical]});await fs.writeFile(checkpoint,old);
 start();await wait(async()=>(await fetch(base+'/api/state')).ok);
 await api(route+'/run',{stage:'all'});
 await wait(async()=>['completed','partial','failed','paused'].includes((await api(route)).task.status));
 const ended=(await api(route)).task;assert.equal(ended.status,'completed',JSON.stringify(ended));assert.equal(ended.collectionSchedule.valid,4);assert.deepEqual(ended.availablePlatforms,['shixiseng']);assert.equal(ended.pausedPlatforms.length,2);
 assert.equal(await fs.readFile(checkpoint,'utf8'),old);assert.ok((await readNativeTaskRows(task.outputDir,task.id,'job51')).some(r=>r.job_id==='historical'));
 const visits=(await fs.readFile(calls,'utf8')).trim().split('\n').map(JSON.parse),lists=visits.filter(v=>v.keyword);
 assert.deepEqual(lists.map(v=>v.keyword),['测试工程师','自动化测试工程师','软件测试']);assert.equal(visits.length,6);
 for(let i=1;i<visits.length;i++)assert.ok(visits[i].at-visits[i-1].at>=2400,'cross-round shared rate clock');
 const platforms=(await api('/api/platforms')).platforms;assert.ok(!platforms.some(p=>p.group==='招聘平台'));
 console.log('PASS isolated console: strict transport, rejected unsupported creation/login, no browser adapter import, real HTTP adapters + simulated JSON, adaptive keywords, cross-round pacing, native 4/4 ingestion, legacy rows/checkpoint retained. Memory probe stubbed only in this test.');
}finally{await stop();}
