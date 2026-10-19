import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {createExtensionBridge} from './job-browser-extension.mjs';
import {createJobBrowserManager} from './job-browser-manager.mjs';
import {workspaceChromium} from './job-browser-runtime.mjs';
import {pageOperation} from '../job_collector_ui/browser-extension/dom.mjs';

const root=await fs.mkdtemp(path.join(os.tmpdir(),'job-browser-extension-test-'));
let checks=0;const check=(a,b)=>{assert.deepEqual(a,b);checks++;};const rejects=async(fn,re)=>{await assert.rejects(fn,re);checks++;};
const manager=createJobBrowserManager(root,{env:{}});await manager.save({mode:'extension',browserId:'chrome'});
let launchRecord,launches=0,lastChild;const bridge=createExtensionBridge({browserManager:manager,pollMs:60,commandMs:500,outputDir:path.join(root,'package'),launch:(exe,args,options)=>{launches++;launchRecord={exe,args,options};const child=lastChild=new EventEmitter();child.unref=()=>{};queueMicrotask(()=>child.emit('spawn'));return child;}});
const server=http.createServer((req,res)=>{void bridge.handler(req,res,new URL(req.url,'http://127.0.0.1').pathname);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}/api/browser/extension/`,extensionId='a'.repeat(32);let token;
async function post(route,body={},headers={}){return new Promise((resolve,reject)=>{const req=http.request(base+route,{method:'POST',headers:{host:'127.0.0.1:8788','content-type':'application/json','x-job-extension-token':token||'',...headers}},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>resolve({status:res.statusCode,value:JSON.parse(Buffer.concat(chunks).toString())}));});req.on('error',reject);req.end(JSON.stringify(body));});}
const tab={id:'123',url:'https://www.zhipin.com/job_detail/fixture.html',title:'测试岗位',lastURL:'https://www.zhipin.com/job_detail/fixture.html',generation:1};
const snapshot=(generation=1)=>({tabs:[{...tab,generation}],selectedTabId:'123'});
async function respond(method,args,result){const task=bridge.command(method,{tabId:'123',...args});const response=await post('poll',snapshot());check(response.value.command.method,method);await post('result',{id:response.value.command.id,result});return task;}
let context;
try{
 check((await manager.read()).mode,'extension');const started=await bridge.command('start');check(launchRecord.args.some(a=>/remote-debug|automation|disable-blink|load-extension/.test(a)),false);check(launchRecord.args[0],`--user-data-dir=${manager.profileFor({mode:'extension',browserId:'chrome'})}`);
 check(launchRecord.args.at(-1),'https://www.zhipin.com/');check(started.extension.connected,false);check(started.busy,false);check(started.openRequest.verified,false);
 const boss=await bridge.command('open-site',{url:'https://www.zhipin.com/'});check(boss.openRequest.transport,'system-browser-launch');check(launchRecord.args.at(-1),'https://www.zhipin.com/');
 const address='https://www.zhipin.com/web/geek/jobs?query='+encodeURIComponent('销售工程师')+'&city=101010100';await bridge.command('open-site',{url:address});check(launchRecord.args.at(-1),address);
 await bridge.command('plugin',{id:'search',site:'boss',keyword:'销售工程师',city:'北京'});check(new URL(launchRecord.args.at(-1)).searchParams.get('query'),'销售工程师');
 await bridge.command('extension-manager');check(launchRecord.args.at(-1),'chrome://extensions/');
 await manager.save({mode:'extension',browserId:'edge'});await bridge.command('extension-manager');check(launchRecord.args.at(-1),'edge://extensions/');await manager.save({mode:'extension',browserId:'chrome'});
 const beforeInvalid=launches;for(const url of ['javascript:alert(1)','file:///C:/Windows/win.ini','http://127.0.0.1/','chrome://extensions/','https://www.zhipin.com.evil.example/'])await rejects(bridge.command('open-site',{url}),/HTTPS/);check(launches,beforeInvalid);
 for(const method of ['plugin','prepare-action','confirm-action'])await rejects(bridge.command(method,{id:'read-detail',kind:'apply'}),/招聘网站标签/);
 lastChild.emit('exit',7);check((await bridge.status()).extension.launchRequest.error.includes('代码7'),true);check(launches,beforeInvalid);
 const failed=createExtensionBridge({browserManager:manager,launch:()=>{const child=new EventEmitter();queueMicrotask(()=>child.emit('error',Error('fixture')));return child;}});await rejects(failed.command('start'),/启动失败/);check((await failed.status()).busy,false);await failed.dispose();
 const setup=await bridge.onboarding();check((await fs.stat(path.join(setup.extensionPath,'manifest.json'))).isFile(),true);
 const manifest=JSON.parse(await fs.readFile(path.join(setup.extensionPath,'manifest.json'),'utf8'));check(manifest.permissions.some(p=>['debugger','cookies','webRequest','proxy'].includes(p)),false);check('content_scripts' in manifest,false);
 check((await post('pair',{code:setup.code,extensionId},{origin:'https://evil.example'})).status,403);
 check((await post('pair',{code:'wrong',extensionId})).status,401);
 const pair=await post('pair',{code:setup.code,extensionId},{origin:`chrome-extension://${extensionId}`,'sec-fetch-site':'cross-site'});check(pair.status,200);token=pair.value.token;
 check((await post('pair',{code:setup.code,extensionId})).status,401);check((await post('poll',snapshot(),{'x-job-extension-token':'wrong'})).status,401);
 await post('poll',snapshot());check((await bridge.status()).running,true);
 const beforeConnected=launches,open=bridge.command('open-site',{url:'https://www.liepin.com/'});const openPoll=await post('poll',snapshot());check(openPoll.value.command.method,'new-tab');check(openPoll.value.command.args.url,'https://www.liepin.com/');await post('result',{id:openPoll.value.command.id,result:{ok:true}});check((await open).openRequest.transport,'extension');check(launches,beforeConnected);
 const read=await respond('plugin',{id:'read-detail'},{rows:[{url:tab.url+'?tracking=secret',title:'销售工程师',company:'隔离公司',description:'负责区域客户开发与商务谈判以及销售合同签署和客户关系维护，按团队要求推进项目交付。'}]});check(read.rows[0].url,tab.url);check(read.rows[0].source,'browser-extension-visible-dom');
 await rejects(bridge.command('navigate',{tabId:'123',url:'http://127.0.0.1/'}),/HTTPS/);
 await rejects(bridge.command('input',{tabId:'123'}),/直接操作/);
 const plan=await respond('prepare-action',{kind:'apply'},{id:'ticket1',identity:'公司 · 销售',label:'投递',fingerprint:'hash'});check(plan.id,'ticket1');
 await post('poll',snapshot(2));await rejects(bridge.command('confirm-action',{tabId:'123',ticketId:plan.id}),/变化/);
 await post('poll',snapshot());await respond('prepare-action',{kind:'apply'},{id:'ticket2',identity:'公司 · 销售',label:'投递',fingerprint:'hash'});
 check((await respond('confirm-action',{ticketId:'ticket2'},{attempted:true,confirmed:false})).attempted,true);
 await rejects(bridge.command('confirm-action',{tabId:'123',ticketId:'ticket2'}),/变化/);
 const timeout=bridge.command('focus',{tabId:'123'});await rejects(timeout,/超时/);const expired=await post('poll',snapshot());check(expired.value.command,null);
 await bridge.command('stop');check((await bridge.status()).running,false);check((await post('poll',snapshot())).status,401);

 const chromium=await workspaceChromium();context=await chromium.launchPersistentContext(path.join(root,'dom-profile'),{executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,env:{...process.env,TEMP:root,TMP:root}});
 const page=context.pages()[0];const html='<!doctype html><meta charset="utf-8"><h1>销售工程师</h1><div class="company-name">隔离公司</div><div class="job-sec-text">负责区域客户开发与商务谈判以及销售合同签署和客户关系维护，按团队要求推进项目交付。</div><button id="apply" onclick="window.applied=(window.applied||0)+1">立即投递</button><div class="chat-title">招聘方甲</div><div class="chat-input"><textarea placeholder="输入消息"></textarea><button onclick="window.sent=(window.sent||0)+1">发送</button></div>';
 await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:html}));await page.goto(tab.url);
 const op=a=>page.evaluate(pageOperation,a);
 check((await op({op:'read-detail'})).rows[0].title,'销售工程师');
 let prepared=await op({op:'prepare',kind:'apply'});check(await page.evaluate(()=>window.applied||0),0);check((await op({op:'confirm',ticketId:prepared.id})).attempted,true);check(await page.evaluate(()=>window.applied),1);
 await rejects(op({op:'confirm',ticketId:prepared.id}),/失效/);
 prepared=await op({op:'prepare',kind:'message',body:'您好，这是隔离测试消息'});await page.locator('.chat-title').evaluate(e=>e.textContent='招聘方乙');await rejects(op({op:'confirm',ticketId:prepared.id}),/变化/);check(await page.evaluate(()=>window.sent||0),0);
 prepared=await op({op:'prepare',kind:'message',body:'您好，这是隔离测试消息'});await op({op:'confirm',ticketId:prepared.id});check(await page.locator('textarea').inputValue(),'您好，这是隔离测试消息');check(await page.evaluate(()=>window.sent),1);
 prepared=await op({op:'prepare',kind:'apply'});await page.reload();await rejects(op({op:'confirm',ticketId:prepared.id}),/失效/);
 await page.goto('https://www.zhipin.com/web/passport/zp/403.html');await rejects(op({op:'read-detail'}),/限制访问/);
 await page.goto('https://www.zhipin.com/web/user/');await rejects(op({op:'read-detail'}),/手动登录/);
 const result={passed:true,checks,transport:'real-local-http-with-simulated-extension-client',dom:'real-Chromium-synthetic-page',actualUnpackedExtensionInstalled:false,realWebsiteRequests:0,realMessages:0,realApplications:0,paidModelCalls:0,fixture:root};console.log(JSON.stringify(result));
}finally{await context?.close();await bridge.dispose();await new Promise(r=>server.close(r));}
