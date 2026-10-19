import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {lookup} from 'node:dns/promises';
import {pathToFileURL} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {safeBrowserURL,siteForURL,publicResourceURL,privateAddress,validateInput,browserSites} from './job-browser-contracts.mjs';
import {searchBrowserURL,readBrowserPlugin,browserAccessState} from './job-browser-plugins.mjs';
import {assertCollectorResources} from './collector_resources.mjs';
import {createJobBrowserManager} from './job-browser-manager.mjs';

export async function workspaceChromium(){
  try{return (await import('playwright')).chromium;}catch{}
  const bundled=path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
  try{return (await import(pathToFileURL(bundled))).chromium;}catch{throw Error('Playwright运行时不可用，请配置本机运行环境');}
}
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function createNavigationBudget({now=Date.now,limit=4,windowMs=20000}={}){
  let history=[],paused=false;
  return {reset(){history=[];paused=false;},pause(){paused=true;},get paused(){return paused;},allow(){history=history.filter(at=>at>now()-windowMs);if(paused||history.length>=limit){paused=true;return false;}history.push(now());return true;}};
}
export function createJobBrowserRuntime({runtimeDir,chromium,resolveDNS=lookup,resourceCheck=assertCollectorResources,event=()=>{},browserManager=createJobBrowserManager(runtimeDir)}){
  let context=null,launching=null,selected=null,streamTab=null,lastPluginAt=0,operation=false,disposed=false,inputQueue=Promise.resolve(),pendingInputs=0;
  let launchConfiguration=null,selectionCheck=null;
  const tabs=new Map(),dnsCache=new Map(),tickets=new Map(),registrations=new WeakMap();
  function tab(id){const t=tabs.get(id);if(!t||t.page.isClosed())throw Error('标签页已关闭，请重新选择');return t;}
  async function allowedNetwork(value){
    if(!publicResourceURL(value))return false;
    const host=new URL(value).hostname,old=dnsCache.get(host);if(old&&old.until>Date.now())return old.ok;
    const addresses=await resolveDNS(host,{all:true}).catch(()=>[]),ok=addresses.length>0&&addresses.every(a=>!privateAddress(a.address));
    dnsCache.set(host,{ok,until:Date.now()+60000});return ok;
  }
  async function syncNativeSelection(){
    if(launchConfiguration?.mode!=='native'||!context||operation)return;
    if(selectionCheck)return selectionCheck;
    selectionCheck=(async()=>{
      for(const t of [...tabs.values()]){
        let timer;const focused=await Promise.race([t.page.evaluate(()=>document.visibilityState==='visible'&&document.hasFocus()).catch(()=>false),new Promise(r=>{timer=setTimeout(()=>r(false),250);})]).finally(()=>clearTimeout(timer));
        if(focused&&tabs.has(t.id)){if(selected!==t.id)tickets.clear();selected=t.id;break;}
      }
    })().finally(()=>{selectionCheck=null;});
    return selectionCheck;
  }
  async function describe(){await syncNativeSelection();return {running:!!context,mode:launchConfiguration?.mode||null,browserId:launchConfiguration?.browserId||null,profileDir:launchConfiguration?.profileDir||null,selectedTabId:selected,tabs:await Promise.all([...tabs.values()].map(async t=>({id:t.id,url:t.page.url(),lastURL:t.lastURL||'',unexpectedBlank:!!t.unexpectedBlank,title:(await t.page.title().catch(()=>'' )).slice(0,150),site:siteForURL(t.page.url())?.id||'',error:t.error||'',navigationPaused:t.navigation.paused}))),busy:operation||!!launching};}
  const publish=()=>{void describe().then(state=>event('state',state)).catch(()=>{});};
  function register(page){
    if(!registrations.has(page))registrations.set(page,registerPage(page));
    return registrations.get(page);
  }
  async function registerPage(page){
    if(tabs.size>=6){await page.close();throw Error('最多保留6个标签页，请先关闭不需要的标签');}
    const t={id:randomUUID(),page,cdp:launchConfiguration.mode==='embedded'?await context.newCDPSession(page):null,generation:0,error:'',lastURL:'',unexpectedBlank:false,lastFrame:0,frameTimer:null,pendingFrame:null,navigation:createNavigationBudget()};tabs.set(t.id,t);selected=t.id;tickets.clear();
    page.on('dialog',dialog=>dialog.dismiss().catch(()=>{}));
    page.on('download',download=>{void download.cancel();t.error='下载已拦截；请使用系统保存岗位或在外部浏览器下载';publish();});
    // Without a filechooser listener a native window keeps its real manual file picker.
    if(launchConfiguration.mode==='embedded')page.on('filechooser',()=>{t.error='附件上传请在原生窗口模式中手动处理；系统不会自动上传本机文件';publish();});
    page.on('framenavigated',frame=>{
      if(frame!==page.mainFrame())return;
      t.generation++;tickets.clear();
      const url=frame.url();
      if(url==='about:blank'){
        // A brand-new tab starting blank is normal; a blank that replaces an already loaded page is not.
        if(t.lastURL){t.unexpectedBlank=true;t.navigation.pause();t.error='网页意外变为空白；尚不能确定是页面脚本、访问限制还是浏览器故障，插件已暂停，请人工核对，不自动重试';}
      }else{
        t.unexpectedBlank=false;
        if(/^https?:/i.test(url))t.lastURL=url;
        if(!t.navigation.paused)t.error='';
      }
      publish();
    });
    page.on('close',()=>{clearTimeout(t.frameTimer);t.pendingFrame=null;tabs.delete(t.id);tickets.clear();if(selected===t.id)selected=tabs.keys().next().value||null;if(streamTab===t.id)streamTab=null;publish();});
    const deliverFrame=()=>{
      t.frameTimer=null;const frame=t.pendingFrame;t.pendingFrame=null;
      if(!frame||streamTab!==t.id||page.isClosed())return;t.lastFrame=Date.now();
      event('frame',{tabId:t.id,data:frame.data,width:page.viewportSize().width,height:page.viewportSize().height});
    };
    t.cdp?.on('Page.screencastFrame',frame=>{
      void t.cdp.send('Page.screencastFrameAck',{sessionId:frame.sessionId}).catch(()=>{});
      if(streamTab!==t.id)return;t.pendingFrame=frame;
      if(t.frameTimer)return;const wait=34-(Date.now()-t.lastFrame);
      if(wait<=0)deliverFrame();else t.frameTimer=setTimeout(deliverFrame,wait);
    });
    publish();return t;
  }
  async function ensure(){
    if(disposed)throw Error('浏览器已释放');if(context)return;if(launching)return launching;
    launching=(async()=>{
      await resourceCheck();await fs.mkdir(path.join(runtimeDir,'temp'),{recursive:true});
      const driver=chromium||await workspaceChromium();
      launchConfiguration=await browserManager.resolve();
      if(launchConfiguration.mode==='extension')throw Error('普通浏览器模式请通过扩展桥启动，不允许交给自动化驱动');
      const native=launchConfiguration.mode==='native';
      context=await driver.launchPersistentContext(launchConfiguration.profileDir,{executablePath:launchConfiguration.executable,headless:!native,chromiumSandbox:true,viewport:native?null:{width:1280,height:800},...native?{}:{deviceScaleFactor:1},locale:'zh-CN',acceptDownloads:false,serviceWorkers:'block',permissions:[],args:['--disk-cache-size=67108864'],env:{...process.env,TEMP:path.join(runtimeDir,'temp'),TMP:path.join(runtimeDir,'temp')}});
      await context.route('**/*',async route=>{
        const req=route.request();
        if(!await allowedNetwork(req.url()))return route.abort('blockedbyclient');
        if(req.isNavigationRequest()&&req.frame()===req.frame().page().mainFrame()){
          try{safeBrowserURL(req.url());}catch{return route.abort('blockedbyclient');}
          const current=[...tabs.values()].find(t=>t.page===req.frame().page());
          // Real native clicks/address-bar submissions grant a new user navigation budget.
          // Scripts cannot set the browser-generated Sec-Fetch-User header themselves.
          if(native&&current&&req.headers()['sec-fetch-user']==='?1')current.navigation.reset();
          if(current&&!current.navigation.allow()){if(!current.unexpectedBlank)current.error='网页20秒内连续跳转超过4次，已暂停跳转和插件；请核对页面后手动刷新或处理验证，不自动重试';publish();return route.abort('blockedbyclient');}
        }
        return route.continue();
      });
      await context.routeWebSocket('**/*',ws=>{
        const u=new URL(ws.url());u.protocol=u.protocol==='wss:'?'https:':'http:';
        void allowedNetwork(u.href).then(ok=>ok?ws.connectToServer():ws.close()).catch(()=>ws.close());
      });
      context.on('page',page=>{void register(page).catch(()=>{});});
      context.on('close',()=>{context=null;tabs.clear();selected=null;streamTab=null;publish();});
      for(const page of context.pages())await register(page);
      if(!tabs.size)await context.newPage();
    })().catch(async error=>{const failed=context;context=null;await failed?.close().catch(()=>{});tabs.clear();selected=null;throw error;}).finally(()=>{launching=null;});
    return launching;
  }
  async function stream(id,enabled){
    if(launchConfiguration?.mode==='native')return;
    if(enabled&&id&&streamTab===id)return;
    if(streamTab){const old=tabs.get(streamTab);clearTimeout(old?.frameTimer);if(old){old.frameTimer=null;old.pendingFrame=null;}await old?.cdp.send('Page.stopScreencast').catch(()=>{});streamTab=null;}
    if(!enabled||!id)return;
    const t=tab(id);streamTab=id;t.lastFrame=0;await t.page.bringToFront();
    await t.cdp.send('Page.startScreencast',{format:'jpeg',quality:60,maxWidth:1600,maxHeight:1000,everyNthFrame:1});
    if(!t.lastFrame)event('frame',{tabId:id,data:(await t.page.screenshot({type:'jpeg',quality:60,timeout:8000})).toString('base64'),...t.page.viewportSize()});
  }
  async function navigate(t,value){
    const url=safeBrowserURL(value);
    tickets.clear();t.error='';t.unexpectedBlank=false;t.navigation.reset();
    try{await t.page.goto(url,{waitUntil:'domcontentloaded',timeout:25000});}
    catch(error){if(!t.navigation.paused)t.error=error.message.includes('Timeout')?'页面加载超时，可在当前画面检查后手动重试':'页面未能加载，请检查网络或网站访问限制';}
    publish();return describe();
  }
  async function input(t,value){
    const p=validateInput(value);
    if((p.type==='mouse'&&p.event==='mousePressed'||p.type==='key'&&p.event==='keyDown'&&p.key==='Enter')&&!(t.unexpectedBlank&&t.page.url()==='about:blank')){t.navigation.reset();t.error='';}
    if(p.type==='text')await t.cdp.send('Input.insertText',{text:p.text});
    else if(p.type==='mouse'){const {type,event:kind,...args}=p;const params={type:kind,...args};if(kind!=='mouseWheel'){delete params.deltaX;delete params.deltaY;}await t.cdp.send('Input.dispatchMouseEvent',params);}
    else{const {type,event:kind,...args}=p;const params={type:kind,...args};if(kind==='keyDown'&&p.key==='Enter'&&!(p.modifiers&7)){params.text='\r';params.unmodifiedText='\r';}await t.cdp.send('Input.dispatchKeyEvent',params);}
    return {ok:true};
  }
  async function actionTarget(t,kind,message){
    if(t.navigation.paused)throw Error(t.error||'网页连续跳转已暂停，请先人工核对');
    safeBrowserURL(t.page.url());const access=await browserAccessState(t.page);if(access.blocked)throw Error(access.message);
    const site=siteForURL(t.page.url());if(!['boss','liepin','zhaopin'].includes(site.id))throw Error('智能沟通与投递首版仅接入BOSS、猎聘、智联，其他网站请手动操作');
    if(kind==='message'){
      if(typeof message!=='string'||message.trim().length<2||message.length>2000)throw Error('请填写2–2000字的沟通正文');
      const headers=t.page.locator('.chat-user-name,.chat-title,.conversation-title,.chat-info .name,.chat-head .name').filter({visible:true});
      if(await headers.count()!==1)throw Error('当前会话收件人无法唯一确认，请手动操作');
      const header=await headers.innerText({timeout:1200}).catch(()=>'');
      if(!header.trim())throw Error('未能可靠识别当前聊天收件人，请先在网页打开指定会话；不会猜测收件人或群发');
      const inputs=t.page.locator('textarea[placeholder*="消息"],textarea[placeholder*="说点"],.chat-input textarea,.chat-input [contenteditable="true"],.chat-editor[contenteditable="true"]').filter({visible:true});
      if(await inputs.count()!==1)throw Error('无法唯一确认聊天输入框，请手动操作');
      const send=t.page.locator('button,[role="button"],.chat-input .btn-send,.chat-editor-area .btn-send').filter({hasText:/^发送(?:消息)?$/}).filter({visible:true});
      if(await send.count()!==1)throw Error('未能唯一识别发送按钮，请手动操作');
      return {locator:send,input:inputs,identity:header.trim().slice(0,120),label:'发送消息',site:site.id,body:message.trim()};
    }
    const job=(await readBrowserPlugin(t.page,'read-detail'))[0];
    const locator=t.page.locator('button,a,[role="button"]').filter({hasText:/^(?:立即沟通|立即投递|投递简历|立即应聘|申请职位|立即申请|申请该职位|立即聊聊)$/}).filter({visible:true});
    if(await locator.count()!==1||!await locator.isEnabled())throw Error('未能唯一识别有效投递/沟通按钮，请在网页手动操作；不会点击相似按钮');
    return {locator,identity:`${job.company||'公司待网页确认'} · ${job.title}`,label:(await locator.innerText()).trim(),site:site.id,job,fingerprint:digest([job.url,job.title,job.company,job.description])};
  }
  async function prepare(t,kind,message){
    const generation=t.generation,url=t.page.url();
    const found=await actionTarget(t,kind,message),id=randomUUID();
    if(t.generation!==generation||t.page.url()!==url||t.id!==selected)throw Error('页面或标签已变化，请重新准备');
    const record={id,tabId:t.id,url:t.page.url(),generation:t.generation,kind,identity:found.identity,label:found.label,body:found.body||'',fingerprint:found.fingerprint||'',expires:Date.now()+120000};
    tickets.clear();tickets.set(id,record);
    return {...record,site:found.site,note:kind==='apply'?'仅点击当前按钮一次。网站可能使用已保存的在线简历或发送默认招呼；附件、二次确认弹窗由你处理。':'仅向当前已识别会话发送上方全文一次；不重试、不群发。'};
  }
  async function confirm(id){
    const ticket=tickets.get(id);if(!ticket||ticket.expires<Date.now())throw Error('确认方案已失效，请重新准备');
    tickets.delete(id); // Single use BEFORE any effect, including uncertain timeouts.
    const t=tab(ticket.tabId);if(selected!==t.id||t.page.url()!==ticket.url||t.generation!==ticket.generation)throw Error('页面已变化，已取消执行，请重新核对');
    let found=await actionTarget(t,ticket.kind,ticket.body);
    if(found.identity!==ticket.identity||found.label!==ticket.label||(found.fingerprint||'')!==ticket.fingerprint)throw Error('收件人、岗位或按钮已变化，已取消执行');
    if(ticket.kind==='message')await found.input.fill(ticket.body,{timeout:5000});
    // Native users can change page/recipient while async locators are resolving.
    found=await actionTarget(t,ticket.kind,ticket.body);
    if(selected!==t.id||t.page.url()!==ticket.url||t.generation!==ticket.generation||found.identity!==ticket.identity||found.label!==ticket.label||(found.fingerprint||'')!==ticket.fingerprint)throw Error('收件人、岗位或页面已变化，已取消执行');
    if(!await found.locator.isEnabled())throw Error('发送/投递按钮尚未就绪，未执行');
    t.navigation.reset();
    // Never press Enter, follow up popups, or retry clicks implicitly.
    try{await found.locator.click({timeout:5000,noWaitAfter:true});}
    catch{throw Error('已尝试执行但结果未确认；可能已经发送/提交，请人工核对。不会自动重试');}
    await new Promise(r=>setTimeout(r,700));
    const success=await t.page.getByText(/^(?:投递成功|申请成功|简历投递成功|已投递)$/).filter({visible:true}).count().catch(()=>0);
    return {attempted:true,confirmed:!!success,message:success?'页面显示投递成功':'已点击一次，网站最终结果未自动确认；请核对页面或处理二次弹窗，不会自动重试'};
  }
  async function command(method,args={}){
    if(method==='status')return describe();
    if(method==='start'){await ensure();return describe();}
    if(method==='shutdown'){disposed=true;tickets.clear();await context?.close();return {ok:true};}
    if(method==='stop'){tickets.clear();await inputQueue;await context?.close();return describe();}
    if(!context)throw Error('请先启动内置浏览器');
    if(method==='input'||method==='input-batch'){
      if(launchConfiguration.mode==='native')throw Error('原生模式请直接在浏览器窗口操作，不转发输入');
      if(operation)throw Error('操作确认进行中，请稍候');
      const t=tab(args.tabId),inputs=method==='input-batch'?args.inputs:[args.input];
      if(!Array.isArray(inputs)||!inputs.length||inputs.length>32)throw Error('输入批次必须包含1–32个事件');
      for(const item of inputs)validateInput(item); // Reject the whole invalid batch before effects.
      if(pendingInputs+inputs.length>256)throw Error('输入队列繁忙，请核对网页后继续操作，不自动重试');
      pendingInputs+=inputs.length;
      const next=inputQueue.then(async()=>{for(const item of inputs){if(t.page.isClosed())throw Error('标签页已关闭');await input(t,item);}return {ok:true};}).finally(()=>{pendingInputs-=inputs.length;});
      inputQueue=next.catch(()=>{});return next;
    }
    if(method==='stream'){await stream(args.tabId,args.enabled);return {ok:true};}
    if(method==='resize'){if(launchConfiguration.mode==='native')return {ok:true};const t=tab(args.tabId);await t.page.setViewportSize({width:Math.max(960,Math.min(1600,Math.round(Number(args.width)||1280))),height:Math.max(600,Math.min(1000,Math.round(Number(args.height)||800)))});return {ok:true};}
    await syncNativeSelection();
    if(operation)throw Error('上一项操作尚未结束，请稍候');operation=true;
    try{
      await inputQueue;
      if(method==='new-tab'){if(tabs.size>=6)throw Error('最多6个标签页');const p=await context.newPage();const t=await register(p);if(args.url)await navigate(t,args.url);return describe();}
      const t=tab(args.tabId||selected);
      if(method==='select'||method==='focus'){tickets.clear();selected=t.id;await t.page.bringToFront();publish();return describe();}
      if(method==='close-tab'){await t.page.close();return describe();}
      if(method==='navigate')return await navigate(t,args.url);
      if(['back','forward','reload'].includes(method)){tickets.clear();t.navigation.reset();t.error='';const fn=method==='back'?'goBack':method==='forward'?'goForward':'reload';await t.page[fn]({waitUntil:'domcontentloaded',timeout:20000}).catch(()=>{t.error='导航未完成，请检查当前页面';});publish();return describe();}
      if(method==='plugin'){
        if(launchConfiguration.mode==='native'&&t.id!==selected)throw Error('浏览器标签已切换，请刷新当前岗位后重试');
        if(t.navigation.paused)throw Error(t.error||'网页连续跳转已暂停，请先人工核对');
        if(Date.now()-lastPluginAt<2000)throw Error('插件操作间隔至少2秒，请稍候');lastPluginAt=Date.now();
        if(args.id==='search'){const access=await browserAccessState(t.page);if(access.blocked)throw Error(access.message);return await navigate(t,searchBrowserURL(args.site,args.keyword,args.city));}
        return {rows:await readBrowserPlugin(t.page,args.id)};
      }
      if(method==='prepare-action'){if(t.id!==selected)throw Error('浏览器标签已切换，请刷新后重新核对');return await prepare(t,args.kind,args.message);}
      if(method==='confirm-action')return await confirm(args.ticketId);
      if(method==='cancel-action'){tickets.clear();return {ok:true};}
      throw Error('不支持的浏览器命令');
    }finally{operation=false;}
  }
  return {command,describe};
}
if(process.argv.includes('--job-browser-worker')){
  const runtime=createJobBrowserRuntime({runtimeDir:process.env.JOB_WORKSPACE_RUNTIME,event:(type,data)=>{if(process.connected)process.send({type,data});}});
  process.on('message',async message=>{try{const result=await runtime.command(message.method,message.args);if(process.connected)process.send({requestId:message.requestId,result});}catch(e){if(process.connected)process.send({requestId:message.requestId,error:String(e.message).slice(0,700)});}});
  process.on('disconnect',()=>{void runtime.command('shutdown').finally(()=>process.exit(0));});
}
