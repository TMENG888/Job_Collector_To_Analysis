// Start vendor Chrome normally, then attach to this application's own profile.
// No Playwright launch defaults, sandbox disabling, stealth or profile copying.
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright-core';
import {withAccountLock} from './collection_concurrency.mjs';
import {writeJsonAtomic} from './collector_storage.mjs';

const failure=message=>Object.assign(Error(message),{code:'session_required',stopChannel:true});
const alive=pid=>{try{if(!Number.isSafeInteger(pid)||pid<1)return false;process.kill(pid,0);return true;}catch{return false;}};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export function ordinaryChromeArguments(profile){
  if(!path.isAbsolute(profile))throw failure('普通浏览器需要独立的绝对路径会话目录');
  // Skip Chrome's own onboarding, NOT website login/security verification.
  // `--source-shortcut-location=start-menu` keeps the launch looking like a
  // normal Start-menu Chrome start while the dedicated profile and localhost
  // debugging port let the collector attach after the human finishes login.
  return [`--user-data-dir=${profile}`,'--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--no-first-run','--source-shortcut-location=start-menu','--new-window','about:blank'];
}
const invalidWindow=()=>failure('当前 Chrome 页面不属于普通浏览器窗口（可能是旧的首次引导窗口）；请关闭旧猎聘窗口后重新打开，登录资料会保留');
const blankTab=value=>value==='about:blank'||value==='chrome://newtab/';
export async function assertOrdinaryChromePage(context,page){
  let url;try{url=new URL(page.url());}catch{throw invalidWindow();}
  if(page.isClosed?.()||!(url.protocol==='http:'||url.protocol==='https:'||blankTab(url.href)))throw invalidWindow();
  let session;
  try{
    session=await context.newCDPSession(page);
    const {targetInfo}=await session.send('Target.getTargetInfo');
    const window=await session.send('Browser.getWindowForTarget',{targetId:targetInfo.targetId});
    if(!Number.isInteger(window.windowId)||!window.bounds||window.bounds.width<=0||window.bounds.height<=0)throw invalidWindow();
    return window;
  }catch{throw invalidWindow();}
  finally{await session?.detach().catch(()=>{});}
}
export async function selectOrdinaryChromePage(context,{hosts=[]}={}){
  const pages=context.pages().filter(page=>!page.isClosed?.());
  const candidates=pages.filter(page=>{
    try{const url=new URL(page.url());return blankTab(url.href)||(['http:','https:'].includes(url.protocol)&&(!hosts.length||hosts.includes(url.hostname)));}catch{return false;}
  });
  // Keep a current verification/login page ahead of a blank tab. If that page
  // is an old malformed onboarding shell, stop rather than navigating around it.
  if(hosts.length)candidates.sort((a,b)=>{
    const rank=page=>{const index=hosts.indexOf(new URL(page.url()).hostname);return index<0?hosts.length:index;};
    return rank(a)-rank(b);
  });
  const page=candidates.find(page=>!blankTab(page.url()))||candidates[0];
  if(!page)throw invalidWindow();
  await assertOrdinaryChromePage(context,page);return page;
}
function endpointFromPortFile(raw){
  const [port,route]=String(raw).trim().split(/\r?\n/);
  if(!/^\d+$/.test(port)||Number(port)<1||Number(port)>65535||!/^\/devtools\/browser\/[a-f0-9-]+$/i.test(route||''))throw failure('普通浏览器本机会话端口无效');
  return {endpoint:`http://127.0.0.1:${port}`,browser_ws:`ws://127.0.0.1:${port}${route}`};
}
export async function launchOrdinaryChromeContext(profile,{executablePath,launch=spawn,connect=(endpoint)=>chromium.connectOverCDP(endpoint,{timeout:10000}),fetchImpl=fetch,processAlive=alive,wait=sleep,timeoutMs=15000}={}){
  if(!executablePath||!path.isAbsolute(executablePath))throw failure('系统 Chrome 路径无效');
  ordinaryChromeArguments(profile);profile=path.resolve(profile);
  await fs.mkdir(profile,{recursive:true});
  const file=path.join(profile,'.job-collector-normal-chrome.json'),portFile=path.join(profile,'DevToolsActivePort');
  const read=file=>fs.readFile(file,'utf8').catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  // Chrome briefly holds this file exclusively while publishing its endpoint.
  // Wait inside the same bounded launch; never spawn a replacement browser.
  const readPort=()=>read(portFile).catch(error=>{if(error.code==='EBUSY')return null;throw error;});
  const check=async entry=>{
    const endpoint=new URL(entry.endpoint);
    if(endpoint.origin!==entry.endpoint||endpoint.hostname!=='127.0.0.1'||endpoint.protocol!=='http:'||!endpoint.port)throw failure('拒绝连接非本机浏览器端口');
    const ws=new URL(entry.browser_ws);
    if(ws.protocol!=='ws:'||ws.hostname!=='127.0.0.1'||ws.port!==endpoint.port||!/^\/devtools\/browser\/[a-f0-9-]+$/i.test(ws.pathname))throw failure('浏览器调试连接不属于该本机会话');
    const version=await fetchImpl(entry.endpoint+'/json/version',{signal:AbortSignal.timeout(1500)}).then(response=>{if(!response.ok)throw failure('普通浏览器端口无响应');return response.json();});
    if(version.webSocketDebuggerUrl!==entry.browser_ws)throw failure('浏览器会话标识已改变，请手动核对原窗口');
  };
  const attached=await withAccountLock(file+'.lock','normal-chrome-start',async()=>{
    const saved=await read(file).then(value=>value?JSON.parse(value):null);
    if(saved&&saved.kind!=='job-collector-normal-chrome-v1')throw failure('浏览器会话记录无效，不接管未知窗口');
    if(saved&&processAlive(saved.pid)){
      if(saved.profile!==profile||saved.executable!==executablePath)throw failure('普通浏览器会话归属不匹配');
      await check(saved);return {...saved,reused:true};
    }
    const previousPort=await readPort(),temp=path.join(profile,'temp');await fs.mkdir(temp,{recursive:true});
    const child=launch(executablePath,ordinaryChromeArguments(profile),{detached:true,windowsHide:false,stdio:'ignore',env:{...process.env,TEMP:temp,TMP:temp}});
    let exited=false;child.once('exit',()=>{exited=true;});
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',()=>reject(failure('普通 Chrome 启动失败，请检查安装路径')));});
    child.unref();
    const deadline=Date.now()+timeoutMs;
    while(Date.now()<deadline){
      if(exited||!processAlive(child.pid))throw failure('会话目录可能被旧窗口占用；请手动关闭旧猎聘窗口后再试，不会强制关闭或清除登录资料');
      const raw=await readPort();
      if(raw&&raw!==previousPort){
        let port;try{port=endpointFromPortFile(raw);}catch{await wait(100);continue;}
        const entry={kind:'job-collector-normal-chrome-v1',profile,executable:executablePath,pid:child.pid,...port,opened_at:new Date().toISOString()};
        try{await check(entry);}catch{await wait(100);continue;}
        await writeJsonAtomic(file,entry);return {...entry,reused:false};
      }
      await wait(100);
    }
    throw failure('普通 Chrome 连接超时；请核对是否仍有旧验证窗口占用，不自动重启或重复打开');
  },{interval:200});
  let browser;try{browser=await connect(attached.endpoint);}catch{throw failure('无法连接工作台的普通 Chrome，请手动核对窗口，不自动重试');}
  const context=browser.contexts()[0];
  if(!context){await browser.close();throw failure('普通 Chrome 缺少可用会话');}
  try{
    const readyDeadline=Date.now()+Math.min(timeoutMs,3000);
    while(!context.pages().length&&Date.now()<readyDeadline)await wait(100);
    await selectOrdinaryChromePage(context);
  }catch(error){await browser.close().catch(()=>{});throw error;}
  // CDP Browser.close disconnects this client; it does not close user windows.
  // Keep the same native process and login session for verification/collection.
  return new Proxy(context,{get(target,key){
    if(key==='ordinarySession')return {reused:attached.reused,pid:attached.pid};
    if(key==='ordinaryPage')return options=>selectOrdinaryChromePage(target,options);
    if(key==='assertOrdinaryPage')return page=>assertOrdinaryChromePage(target,page);
    if(key==='close')return ()=>browser.close();
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
}
