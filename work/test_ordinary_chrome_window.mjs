import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {ordinaryChromeArguments,assertOrdinaryChromePage,selectOrdinaryChromePage,launchOrdinaryChromeContext} from './ordinary_chrome_session.mjs';
import {createChannelVerification} from './channel_manual_verification.mjs';
import {collectLiepinWebsite} from './liepin_website_session.mjs';

const root='E:/Codex/work/20261023-chrome-window-fix';
await fs.mkdir(root,{recursive:true});
function fixture(urls,{invalid=[],width=1200,height=800}={}){
  let detached=0,attached=0;
  const pages=urls.map(url=>({url:()=>url,isClosed:()=>false}));
  const context={pages:()=>pages,newCDPSession:async page=>{
    attached++;return {send:async method=>{
      if(method==='Target.getTargetInfo')return {targetInfo:{targetId:String(pages.indexOf(page))}};
      if(invalid.includes(page.url()))throw Error('Browser window not found');
      return {windowId:12,bounds:{width,height,windowState:'normal'}};
    },detach:async()=>{detached++;}};
  }};
  return {context,pages,counts:()=>({attached,detached})};
}
test('startup skips only Chrome onboarding; no site-security bypass switches',()=>{
  const args=ordinaryChromeArguments('E:/test/profile');
  assert.ok(args.includes('--no-first-run'));assert.ok(args.includes('--new-window'));
  assert.doesNotMatch(args.join(' '),/--app|--headless|--kiosk|no-sandbox|disable-blink|user-agent|ignore-certificate/);
});
for(const url of ['chrome://intro/','chrome://settings/','devtools://devtools/','data:text/html,test']){
  test('reject browser-internal/non-web target '+url,async()=>{
    const f=fixture([url]);await assert.rejects(selectOrdinaryChromePage(f.context),{code:'session_required',stopChannel:true});
    assert.equal(f.counts().attached,0);
  });
}
test('ordinary blank page has real window association and diagnostic session detaches',async()=>{
  const f=fixture(['about:blank']);assert.equal(await selectOrdinaryChromePage(f.context),f.pages[0]);
  assert.deepEqual(f.counts(),{attached:1,detached:1});
});
test('normal Chrome new-tab window remains usable with native window validation',async()=>{
  const f=fixture(['chrome://newtab/']);assert.equal(await selectOrdinaryChromePage(f.context,{hosts:['www.liepin.com']}),f.pages[0]);
  assert.deepEqual(f.counts(),{attached:1,detached:1});
});
test('already-navigated onboarding shell cannot masquerade as a browser tab',async()=>{
  const url='https://safe.liepin.com/page/liepin/captchaPage_ip_PC',f=fixture([url],{invalid:[url]});
  await assert.rejects(selectOrdinaryChromePage(f.context),/关闭旧猎聘窗口/);
  assert.deepEqual(f.counts(),{attached:1,detached:1});
});
test('challenge is preferred over search/blank; malformed challenge cannot be sidestepped',async()=>{
  const search='https://www.liepin.com/zhaopin/',challenge='https://safe.liepin.com/page/test';
  const f=fixture([search,'about:blank',challenge],{invalid:[challenge]});
  await assert.rejects(selectOrdinaryChromePage(f.context,{hosts:['safe.liepin.com','www.liepin.com']}),{code:'session_required'});
  assert.equal(f.counts().attached,1);
});
test('normal challenge remains selected without navigation or replacement',async()=>{
  const f=fixture(['about:blank','https://safe.liepin.com/page/test']);
  assert.equal(await selectOrdinaryChromePage(f.context,{hosts:['safe.liepin.com']}),f.pages[1]);
});
test('foreign tabs are not selected for recruitment navigation',async()=>{
  const f=fixture(['https://example.com/']);await assert.rejects(selectOrdinaryChromePage(f.context,{hosts:['www.liepin.com']}),{code:'session_required'});
});
test('zero-sized window rejected and CDP session detached on failure',async()=>{
  const f=fixture(['about:blank'],{width:0});await assert.rejects(assertOrdinaryChromePage(f.context,f.pages[0]));
  assert.equal(f.counts().detached,1);
});
test('verification exposes actionable shell error and releases lease without goto',async()=>{
  let navigations=0,released=0,closed=0;
  const page={url:()=> 'chrome://intro/',goto:async()=>{navigations++;}};
  const context={pages:()=>[page],ordinaryPage:async()=>{throw Object.assign(Error('请关闭旧猎聘窗口后重新打开'),{code:'session_required'});},close:async()=>{closed++;}};
  const manager=createChannelVerification({openContext:async()=>({context,owned:true,release:async()=>{released++;}})});
  const task={id:'isolated',platforms:['liepin']},config={task_id:task.id,keywords:['测试'],platforms:{liepin:{enabled:true,cities:[{name:'广州',code:'050020'}]}}};
  const manifest={task_id:task.id,platforms:{liepin:{errors:[{code:'verification_required'}]}}};
  await assert.rejects(manager.open(task,'liepin',config,manifest,{mode:'collector'}),/关闭旧猎聘窗口/);
  assert.deepEqual({navigations,released,closed},{navigations:0,released:1,closed:1});
  assert.deepEqual(manager.status(task.id),{});
});
test('collector refuses shell before search and preserves resumable checkpoint',async()=>{
  const dir=await fs.mkdtemp(path.join(root,'collector-'));let reads=0,closed=0;
  await assert.rejects(collectLiepinWebsite('测试',{name:'广州',code:'050020'},{taskId:'test',checkpointPath:path.join(dir,'checkpoint.json'),profileDir:path.join(dir,'profile'),rateDir:path.join(dir,'rates'),contextFactory:async()=>({ordinaryPage:async()=>{throw Object.assign(Error('shell'),{code:'session_required'});},close:async()=>{closed++;}}),readPage:async()=>{reads++;}}),{code:'session_required'});
  assert.equal(reads,0);assert.equal(closed,1);const saved=JSON.parse(await fs.readFile(path.join(dir,'checkpoint.json'),'utf8'));
  assert.equal(saved.completed,false);assert.equal(saved.lastPage,0);assert.equal(saved.error_code,'session_required');
});
test('real Chrome fresh profile: browser window survives disconnect/reconnect',async()=>{
  const profile=await fs.mkdtemp(path.join(root,'live-'));let context,browser,second;
  try{
    context=await launchOrdinaryChromeContext(profile,{executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});browser=context.browser();
    const page=await context.ordinaryPage();assert.equal(page.url(),'about:blank');
    const before=await assertOrdinaryChromePage(context,page);const pid=context.ordinarySession.pid;
    await context.close();context=null;
    second=await launchOrdinaryChromeContext(profile,{executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});browser=second.browser();
    assert.equal(second.ordinarySession.pid,pid);assert.equal(second.ordinarySession.reused,true);
    const after=await assertOrdinaryChromePage(second,await second.ordinaryPage());assert.equal(after.windowId,before.windowId);
    console.log(JSON.stringify({nativeWindowTest:true,samePid:true,sameWindow:true,windowState:after.bounds.windowState,recruitmentSiteVisited:false}));
  }finally{
    if(browser){const session=await browser.newBrowserCDPSession().catch(()=>null);await session?.send('Browser.close').catch(()=>{});}
    await second?.close().catch(()=>{});await context?.close().catch(()=>{});
  }
});
