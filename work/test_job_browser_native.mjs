import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {createJobBrowserManager,validateBrowserSettings} from './job-browser-manager.mjs';
import {createJobBrowserRuntime,workspaceChromium} from './job-browser-runtime.mjs';
import {createBrowserWorkspace} from './job-browser-workspace.mjs';

const root=process.env.JOB_BROWSER_TEST_ROOT||'E:/Codex/work/20261019-native-job-browser';
await fs.mkdir(root,{recursive:true});
const fixture=await fs.mkdtemp(path.join(root,'suite-'));
let checks=0;const check=(a,b)=>{assert.deepEqual(a,b);checks++;};
const rejects=async(fn,re)=>{await assert.rejects(fn,re);checks++;};
const manager=createJobBrowserManager(path.join(fixture,'manager'),{env:{}});
check((await manager.read()).mode,'extension');
for(const value of [{mode:'native',browserId:'evil'},{mode:'evil',browserId:'chrome'},{mode:'native',browserId:'chrome',executable:'C:/evil.exe'},{mode:'native',browserId:'chrome',profile:'C:/Users'}]){assert.throws(()=>validateBrowserSettings(value));checks++;}
await manager.save({mode:'native',browserId:'chrome'});
const nativeProfile=(await manager.resolve()).profileDir;
await manager.save({mode:'native',browserId:'edge'});
check(nativeProfile!==(await manager.resolve()).profileDir,true);
await manager.save({mode:'embedded',browserId:'chrome'});
check((await manager.resolve()).profileDir,path.join(fixture,'manager','profile'));
const noBrowser=createJobBrowserManager(path.join(fixture,'absent'),{env:{},stat:async()=>{throw Error('missing');}});
await rejects(noBrowser.save({mode:'native',browserId:'chrome'}),/未安装/);
await rejects(noBrowser.resolve(),/未安装/);

const html=`<!doctype html><meta charset="utf-8"><title>隔离测试岗位</title><h1>销售工程师</h1><div class="company-name">测试公司</div><div class="job-sec-text">负责区域客户开发、商务谈判、销售合同签署与CRM客户管理，维护客户关系并与团队协作完成项目交付。</div><button id="apply" onclick="window.applied=(window.applied||0)+1;document.querySelector('#result').textContent='投递成功'">立即投递</button><p id="result"></p><div class="chat-title">隔离招聘方</div><div class="chat-input"><textarea placeholder="输入消息"></textarea><button onclick="window.sent=(window.sent||0)+1">发送</button></div><input id="native-input"><a id="next" href="/job_detail/two.html">另一个岗位</a><input type="file" id="manual-file">`;
const chromium=await workspaceChromium(),results=[];
for(const mode of ['native','embedded']){
  let context,launchOptions,cdpSessions=0,frames=0;
  const dir=path.join(fixture,mode),settings=createJobBrowserManager(dir,{env:{}});await settings.save({mode,browserId:'chrome'});
  const driver={launchPersistentContext:async(profile,options)=>{
    launchOptions=options;context=await chromium.launchPersistentContext(profile,options);
    const original=context.newCDPSession.bind(context);context.newCDPSession=(...args)=>{cdpSessions++;return original(...args);};
    // All recruiting-origin documents are synthetic; there is no external job-site traffic.
    await context.route('**/*',r=>r.fulfill({contentType:'text/html',body:html}));
    context.on('page',p=>{void p.route('**/*',r=>r.fulfill({contentType:'text/html',body:html}));});
    for(const p of context.pages())await p.route('**/*',r=>r.fulfill({contentType:'text/html',body:html}));
    return context;
  }};
  const runtime=createJobBrowserRuntime({runtimeDir:dir,chromium:driver,browserManager:settings,resourceCheck:async()=>{},event:type=>{if(type==='frame')frames++;}});
  try{
    let state=await runtime.command('start');const id=state.selectedTabId;
    check(state.mode,mode);check(launchOptions.headless,mode!=='native');check(launchOptions.chromiumSandbox,true);
    check(launchOptions.viewport,mode==='native'?null:{width:1280,height:800});
    await runtime.command('navigate',{tabId:id,url:'https://www.zhipin.com/job_detail/fixture.html'});
    const page=context.pages()[0];
    await runtime.command('stream',{tabId:id,enabled:true});
    if(mode==='native'){
      check(cdpSessions,0);check(frames,0);check(page.listenerCount('filechooser'),0);
      await rejects(runtime.command('input',{tabId:id,input:{type:'text',text:'禁止转发'}}),/直接在浏览器/);
      await page.locator('#native-input').click();await page.keyboard.insertText('原生中文输入');
      check(await page.locator('#native-input').inputValue(),'原生中文输入');
      await runtime.command('resize',{tabId:id,width:1000,height:700});check(page.viewportSize(),null);
    }else{check(cdpSessions,1);check(frames>0,true);}
    check((await runtime.command('plugin',{tabId:id,id:'read-detail'})).rows[0].title,'销售工程师');
    const plan=await runtime.command('prepare-action',{tabId:id,kind:'apply'});
    check(await page.evaluate(()=>window.applied||0),0);
    check((await runtime.command('confirm-action',{tabId:id,ticketId:plan.id})).confirmed,true);
    check(await page.evaluate(()=>window.applied),1);
    await rejects(runtime.command('confirm-action',{tabId:id,ticketId:plan.id}),/失效/);
    const message=await runtime.command('prepare-action',{tabId:id,kind:'message',message:'您好，这是隔离测试消息'});
    await runtime.command('confirm-action',{tabId:id,ticketId:message.id});check(await page.evaluate(()=>window.sent),1);
    const changed=await runtime.command('prepare-action',{tabId:id,kind:'message',message:'不得误发的草稿'});
    await page.locator('.chat-title').evaluate(e=>e.textContent='另一个招聘方');
    await rejects(runtime.command('confirm-action',{tabId:id,ticketId:changed.id}),/已变化/);
    check(await page.evaluate(()=>window.sent),1);
    const old=await runtime.command('prepare-action',{tabId:id,kind:'apply'});
    await page.reload();await rejects(runtime.command('confirm-action',{tabId:id,ticketId:old.id}),/失效|已变化/);
    const tab2=await runtime.command('new-tab',{url:'https://www.zhipin.com/job_detail/two.html'});
    if(mode==='native'){
      await page.bringToFront();await new Promise(r=>setTimeout(r,150));
      check((await runtime.describe()).selectedTabId,id);
      await rejects(runtime.command('plugin',{tabId:tab2.selectedTabId,id:'read-detail'}),/标签已切换/);
    }
    await runtime.command('select',{tabId:id});check((await runtime.command('focus',{tabId:id})).selectedTabId,id);
    await page.evaluate(()=>document.title='Security Verification');
    await rejects(runtime.command('prepare-action',{tabId:id,kind:'apply'}),/验证/);
    await rejects(runtime.command('navigate',{tabId:id,url:'http://127.0.0.1:8788/'}),/HTTPS/);
    check((await runtime.command('stop')).running,false);
    check((await runtime.command('start')).running,true);
    results.push({mode,cdpSessions,frames});
  }finally{await runtime.command('shutdown');}
}

let running=false,releaseStart;const dir=path.join(fixture,'api');await fs.mkdir(dir,{recursive:true});
const service=createBrowserWorkspace(dir,{runtimeDir:dir,credentials:{status:async()=>({configured:false})},rpc:async method=>{
  if(method==='status')return {running,tabs:[],selectedTabId:null};
  if(method==='start'){await new Promise(r=>{releaseStart=r;});running=true;return {running};}
  if(method==='stop'){running=false;return {running};}return {ok:true};
}});
const server=http.createServer((req,res)=>void service.handler(req,res,new URL(req.url,'http://127.0.0.1').pathname));
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
try{
  const status=await(await fetch(base+'/api/browser/status')).json();check(status.workspaceVersion,8);check(status.features.nativeWindow,true);
  const post=(route,body={},token=status.token)=>fetch(base+'/api/browser/'+route,{method:'POST',headers:{'content-type':'application/json','x-job-browser-token':token},body:JSON.stringify(body)});
  check((await post('configuration',{mode:'native',browserId:'chrome'},'')).status,403);
  check((await post('configuration',{mode:'native',browserId:'chrome',executable:'evil'})).status,400);
  check((await post('configuration',{mode:'native',browserId:'chrome'})).status,200);
  const start=post('start');while(!releaseStart)await new Promise(r=>setTimeout(r,10));
  check((await post('configuration',{mode:'embedded',browserId:'chrome'})).status,400);releaseStart();check((await start).status,200);
  check((await post('configuration',{mode:'embedded',browserId:'chrome'})).status,400);
  check((await post('stop')).status,200);
  check((await post('configuration',{mode:'embedded',browserId:'chrome'})).status,200);
}finally{await service.dispose();await new Promise(r=>server.close(r));}
const result={passed:true,checks,results,fixture,externalSiteRequests:0,paidModelCalls:0,realMessages:0,realApplications:0};
await fs.writeFile(path.join(fixture,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
