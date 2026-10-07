import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {chromium} from 'playwright';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ensureManagedBrowser,connectManagedContext,managedBrowserState,switchManagedBrowser} from './managed_browser.mjs';
import {openContext} from './browser_public_channels.mjs';

process.env.JOB_BROWSER_PROFILE_ROOT=await fs.mkdtemp(path.join(os.tmpdir(),'browser-switch-test-'));
process.env.JOB_BROWSER_SOURCE_CONFIG='none';
const server=http.createServer((req,res)=>res.end('<!doctype html><html><body>browser migration fixture</body></html>'));
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}`;
const entries=[];
let context;
let processEvidence;
async function closeWindow(entry){
  try{const browser=await chromium.connectOverCDP(entry.endpoint);await (await browser.newBrowserCDPSession()).send('Browser.close');await browser.close().catch(()=>{});}catch{}
}
try{
  const source=await ensureManagedBrowser('yupao');entries.push(source);
  const other=await ensureManagedBrowser('zhaopin');entries.push(other);
  context=await connectManagedContext('yupao');
  await context.addCookies([{name:'httpOnlySession',value:'fixture-secret',url,httpOnly:true,sameSite:'Lax'},{name:'persistentSession',value:'fixture-persistent',url,expires:Math.floor(Date.now()/1000)+3600}]);
  await context.addCookies([{name:'unrelatedAccount',value:'other-site-fixture',url:'https://unrelated.example.test'}]);
  const page=context.pages()[0];await page.goto(url);
  await page.evaluate(()=>localStorage.setItem('fixture-token','local-session'));
  await assert.rejects(switchManagedBrowser('yupao',{url}),/暂停/);
  assert.equal((await managedBrowserState('yupao')).session_id,source.session_id);
  await context.close();context=null;
  const target=await switchManagedBrowser('yupao',{url});entries.push(target);
  assert.notEqual(target.session_id,source.session_id);assert.notEqual(target.endpoint,source.endpoint);assert.notEqual(target.profile_dir,source.profile_dir);
  assert.notEqual(target.executable_path,source.executable_path);assert.notEqual(target.browser_pid,source.browser_pid);
  const {stdout}=await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Get-Process -Id ${Number(source.browser_pid)},${Number(target.browser_pid)} | Select-Object Id,Path,PrivateMemorySize64 | ConvertTo-Json -Compress`],{windowsHide:true});
  processEvidence=JSON.parse(stdout);assert.equal(processEvidence.length,2);
  for(const entry of [source,target]){
    const process=processEvidence.find(item=>item.Id===entry.browser_pid);
    assert.equal(process.Path.toLowerCase(),entry.executable_path.toLowerCase());assert.ok(process.PrivateMemorySize64>0);
  }
  assert.equal((await managedBrowserState('zhaopin')).session_id,other.session_id);
  context=await openContext('yupao');
  assert.equal(context.managedSession.session_id,target.session_id);
  const cookies=await context.cookies();
  assert.ok(!cookies.some(cookie=>cookie.name==='unrelatedAccount'));
  assert.ok(cookies.some(c=>c.name==='httpOnlySession'&&c.value==='fixture-secret'&&c.httpOnly));
  assert.equal(await context.pages()[0].evaluate(()=>localStorage.getItem('fixture-token')),'local-session');
  await context.addCookies([{name:'target-only',value:'isolated',url}]);
  const original=await chromium.connectOverCDP(source.endpoint);
  assert.ok(!(await original.contexts()[0].cookies()).some(cookie=>cookie.name==='target-only'));
  await original.close();
  await context.close();context=null;
  await closeWindow(source);
  assert.equal((await managedBrowserState('yupao')).session_id,target.session_id);
  await assert.rejects(switchManagedBrowser('yupao',{url:'http://127.0.0.1:1'}));
  assert.equal((await managedBrowserState('yupao')).session_id,target.session_id);
  context=await openContext('yupao');assert.equal(context.managedSession.session_id,target.session_id);await context.close();context=null;
  await closeWindow(target);
  for(let i=0;i<30&&await managedBrowserState('yupao');i++)await new Promise(resolve=>setTimeout(resolve,100));
  const reopened=await ensureManagedBrowser('yupao');entries.push(reopened);
  assert.equal(reopened.profile_dir,target.profile_dir);
  assert.equal(reopened.executable_path,target.executable_path);
  context=await openContext('yupao');
  assert.ok((await context.cookies()).some(c=>c.name==='persistentSession'&&c.value==='fixture-persistent'));
  await context.pages()[0].goto(url);
  assert.equal(await context.pages()[0].evaluate(()=>localStorage.getItem('fixture-token')),'local-session');
  await context.close();context=null;
  const switchedBack=await switchManagedBrowser('yupao',{url});entries.push(switchedBack);
  assert.equal(switchedBack.executable_path,source.executable_path);assert.notEqual(switchedBack.executable_path,reopened.executable_path);
  assert.notEqual(switchedBack.browser_pid,reopened.browser_pid);
  context=await openContext('yupao');assert.equal(context.managedSession.session_id,switchedBack.session_id);await context.close();context=null;
  console.log(JSON.stringify({ok:true,processEvidence,checks:['different executable paths verified by Windows','different browser PIDs and private memory','cookie changes are isolated after migration','active collector blocks switching','fresh browser and profile','HTTP-only and persistent cookies transferred','localStorage transferred','actual collector uses new instance','other platforms unchanged','old window close does not replace new registry','failed migration preserves active session','reopen uses migrated profile and executable','repeated switching alternates EXEs and collector follows']}));
}finally{
  await context?.close();for(const entry of entries)await closeWindow(entry);server.close();
}
