import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {chromium} from 'playwright';
import {spawn} from 'node:child_process';
import {ensureManagedBrowser,connectManagedContext,managedBrowserState} from './managed_browser.mjs';
process.env.JOB_BROWSER_PROFILE_ROOT=await fs.mkdtemp(path.join(os.tmpdir(),'managed-browser-test-'));
process.env.JOB_BROWSER_SOURCE_CONFIG='none';
const server=http.createServer((req,res)=>res.end('<html><body>local shared-browser fixture</body></html>'));
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${server.address().port}`;
const entries=[];
let context;
try{
 const [a,b]=await Promise.all([ensureManagedBrowser('zhaopin'),ensureManagedBrowser('zhaopin')]);
 entries.push(a);assert.equal(a.session_id,b.session_id);assert.equal(a.endpoint,b.endpoint);assert.equal(a.sandbox_enabled,true);
 context=await connectManagedContext('zhaopin');const page=context.pages()[0];await page.goto(url);
 await page.evaluate(()=>{window.sharedMarker='same-tab';document.cookie='fixture=retained';});
 await new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,['work/login_job_platforms.mjs',process.env.JOB_BROWSER_PROFILE_ROOT,'zhaopin'],{env:{...process.env},windowsHide:true});
   let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
   child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error(output)));
 });
 const loginRecord=JSON.parse(await fs.readFile(path.join(process.env.JOB_BROWSER_PROFILE_ROOT,'登录会话状态.json'),'utf8')).platforms.zhaopin;
 assert.equal(loginRecord.browser_session_id,a.session_id);assert.equal(loginRecord.manual_window_closed_at,undefined);assert.equal(loginRecord.login_status,'unknown');
 await assert.rejects(connectManagedContext('zhaopin'),/已有采集/);
 const login=await connectManagedContext('zhaopin',{lease:false});
 assert.equal(await login.pages()[0].evaluate(()=>window.sharedMarker),'same-tab');await login.close();
 assert.equal(await page.evaluate(()=>window.sharedMarker),'same-tab');
 await context.close();context=null;
 assert.ok(await managedBrowserState('zhaopin'),'disconnect must not close shared Chrome');
 context=await connectManagedContext('zhaopin');assert.equal(await context.pages()[0].evaluate(()=>document.cookie),'fixture=retained');await context.close();context=null;
 const other=await ensureManagedBrowser('yupao');entries.push(other);assert.notEqual(a.session_id,other.session_id);assert.notEqual(a.endpoint,other.endpoint);assert.notEqual(a.profile_dir,other.profile_dir);
 const closeBrowser=await chromium.connectOverCDP(a.endpoint);await (await closeBrowser.newBrowserCDPSession()).send('Browser.close');await closeBrowser.close().catch(()=>{});
 for(let i=0;i<30&&await managedBrowserState('zhaopin');i++)await new Promise(r=>setTimeout(r,100));
 assert.equal(await managedBrowserState('zhaopin'),null);
 const replacement=await ensureManagedBrowser('zhaopin');entries.push(replacement);assert.notEqual(a.session_id,replacement.session_id);assert.equal(a.profile_dir,replacement.profile_dir);
 console.log(JSON.stringify({ok:true,checks:['concurrent startup reuses one instance','login and collector share same tab and cookies','worker collision prevented','worker disconnect preserves browser','platform isolation','manual close detection and reopen with same profile','sandbox enabled'],testRoot:process.env.JOB_BROWSER_PROFILE_ROOT}));
}finally{
 await context?.close();
 for(const entry of entries){try{const browser=await chromium.connectOverCDP(entry.endpoint);await (await browser.newBrowserCDPSession()).send('Browser.close');await browser.close().catch(()=>{});}catch{}}
 server.close();
}
