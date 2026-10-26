import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';
const root=path.resolve(import.meta.dirname,'..'),dir=await fs.mkdtemp(path.join(os.tmpdir(),'hybrid-console-'));
const port=19890,base='http://127.0.0.1:'+port;let logs='',browser;
const server=spawn(process.execPath,['job_collector_ui/server.mjs',String(port)],{cwd:root,env:{...process.env,JOB_UI_PORT:String(port),JOB_UI_DATA_DIR:dir,JOB_UI_START_WORKER:'0',JOB_UI_OPEN_BROWSER:'0'},windowsHide:true});
server.stdout.on('data',v=>logs+=v);server.stderr.on('data',v=>logs+=v);
async function api(route,body,status=200){const res=await fetch(base+route,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});const result=await res.json();assert.equal(res.status,status,JSON.stringify(result));return result;}
try{
  let ready=false;for(let i=0;i<150;i++){ready=await fetch(base+'/api/state').then(r=>r.ok).catch(()=>false);if(ready)break;await new Promise(r=>setTimeout(r,100));}assert.ok(ready,logs);
  const state=await api('/api/state');assert.equal(state.version,'1.15.0');assert.equal(state.capabilities.hybridCollection,true);assert.equal(state.capabilities.collectionTransportPolicy.browserAutomation,false);
  const body={label:'页面采集隔离验收',primaryKeyword:'销售工程师',targetRows:3,candidateTarget:3,cities:['北京'],platforms:['job51','jobonline','liepin']};
  await api('/api/tasks',body,400);
  await api('/api/tasks',{...body,transportMode:'invalid'},400);
  await api('/api/tasks',{...body,transportMode:'http_preferred_browser_fallback',browserMaxPages:51},400);
  const created=await api('/api/tasks',{...body,transportMode:'http_preferred_browser_fallback',browserMaxPages:1,browserMaxRows:3},201);
  const result=await api('/api/tasks/'+encodeURIComponent(created.task.id));
  assert.deepEqual(result.task.availablePlatforms,body.platforms);assert.equal(result.task.collectionTransportPolicy.browserAutomation,true);assert.equal(result.task.status,'ready');
  const saved=JSON.parse(await fs.readFile(path.join(dir,'tasks.json'),'utf8'))[0],config=JSON.parse(await fs.readFile(saved.publicConfigPath));assert.deepEqual(config.browser,{maxPages:1,maxRows:3});assert.equal(config.transportMode,'http_preferred_browser_fallback');
  browser=await chromium.launch({headless:true,chromiumSandbox:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});const page=await browser.newPage();
  await page.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
  const errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(base,{waitUntil:'networkidle'});
  await page.locator('#newTaskBtn').click();
  const select=page.locator('#taskForm select[name="transportMode"]'),input=page.locator('#platformChecks input[value="jobonline"]');
  assert.equal(await select.inputValue(),'http_preferred_browser_fallback');assert.equal(await input.isDisabled(),false);
  await select.selectOption('direct_http_validated_data');assert.equal(await input.isDisabled(),true);
  await select.selectOption('http_preferred_browser_fallback');assert.equal(await input.isDisabled(),false);
  assert.deepEqual(errors,[]);assert.equal((await api('/api/state')).activeCount,0,'creating/settings do not start a crawler');
  console.log('PASS isolated server + real local UI: 1.15 capability, strict API compatibility, explicit hybrid creation, budget validation/persistence, browser-only channels availability and UI mode toggle. No platform network or collection started.');
}finally{await browser?.close();if(server.exitCode===null){server.kill();await new Promise(r=>server.once('close',r));}}
