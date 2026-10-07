import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';
import {randomUUID} from 'node:crypto';
import {writeJsonAtomic} from './collector_storage.mjs';
import {navigatePlatformLogin} from './platform_login_navigation.mjs';
export const platformKeys=['zhaopin','yupao','boss','liepin','job51','jobonline','deepseek','kimi','tongyi','zhipu','doubao'];
export const browserProfileRoot=()=>process.env.JOB_BROWSER_PROFILE_ROOT||path.join(process.env.LOCALAPPDATA||os.tmpdir(),'CodexJobCollectorProfilesV2');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export function processAlive(pid){try{process.kill(Number(pid),0);return Number(pid)>0;}catch{return false;}}
function registryFile(key){if(!platformKeys.includes(key))throw Error('不支持的受管理浏览器平台：'+key);return path.join(browserProfileRoot(),key+'.browser.json');}
export function validBrowserProfile(key,profile){
  if(typeof profile!=='string')return false;
  const relative=path.relative(path.resolve(browserProfileRoot()),path.resolve(profile));
  return relative===key || new RegExp(`^${key}-instances[\\\\/][a-f0-9-]{36}$`).test(relative);
}
async function readBrowserState(key,file){
  const entry=await fs.readFile(file,'utf8').then(JSON.parse).catch(()=>null);
  if(entry?.platform!==key||!validBrowserProfile(key,entry.profile_dir)||entry.state!=='open'||!processAlive(entry.host_pid))return null;
  try{
    const endpoint=new URL(entry.endpoint);
    if(endpoint.hostname!=='127.0.0.1'||endpoint.protocol!=='http:')return null;
    const version=await fetch(entry.endpoint+'/json/version',{signal:AbortSignal.timeout(1500)}).then(r=>r.json());
    if(version.webSocketDebuggerUrl!==entry.browser_ws)return null;
    return entry;
  }catch{return null;}
}
async function activeRegistryFile(key){
  const file=registryFile(key)+'.active';
  return await fs.access(file).then(()=>file).catch(()=>registryFile(key));
}
export async function managedBrowserState(key){return readBrowserState(key,await activeRegistryFile(key));}
async function launchManagedBrowser(key,sessionId,profile,file,executableKind='standard'){
  const log=await fs.open(registryFile(key)+'.log','a');
  const host=spawn(process.execPath,[fileURLToPath(new URL('./managed_browser_host.mjs',import.meta.url)),key,sessionId,profile,file,executableKind],{
    env:{...process.env},detached:true,windowsHide:true,stdio:['ignore',log.fd,log.fd],
  });
  let launchError;host.once('error',e=>launchError=e);host.unref();await log.close();
  for(let i=0;i<360;i++){
    if(launchError)throw launchError;
    const state=await readBrowserState(key,file);if(state?.session_id===sessionId)return {...state,reused:false};
    const result=await fs.readFile(file,'utf8').then(JSON.parse).catch(()=>null);
    if(result?.session_id===sessionId&&result.state==='failed')throw Error(result.message);
    if(i>8&&!processAlive(host.pid))throw Error('受管理浏览器启动失败，请检查浏览器日志；已有登录目录未改动');
    await sleep(250);
  }
  host.kill();
  throw Error('受管理浏览器启动超时；已有登录目录未改动');
}
async function lockFile(file){
  await fs.mkdir(path.dirname(file),{recursive:true});
  for(let i=0;i<150;i++){
    try{const handle=await fs.open(file,'wx');await handle.writeFile(JSON.stringify({pid:process.pid}));return async()=>{await handle.close();await fs.unlink(file).catch(()=>{});};}
    catch(error){if(error.code!=='EEXIST')throw error;const owner=await fs.readFile(file,'utf8').then(JSON.parse).catch(()=>null);
      if(owner&&!processAlive(owner.pid)){await fs.unlink(file).catch(()=>{});continue;}
      await sleep(250);
    }
  }throw Error('该平台浏览器启动锁被占用，请检查活动进程；不要清空登录目录');
}
export async function ensureManagedBrowser(key){
  const registered=await managedBrowserState(key);if(registered)return {...registered,reused:true};
  const file=registryFile(key),release=await lockFile(file+'.lock');
  try{
    const current=await managedBrowserState(key);if(current)return {...current,reused:true};
    const prior=await fs.readFile(await activeRegistryFile(key),'utf8').then(JSON.parse).catch(()=>null);
    const profile=prior?.platform===key&&validBrowserProfile(key,prior.profile_dir)?prior.profile_dir:path.join(browserProfileRoot(),key);
    // Each host owns a separate record, so an older window cannot overwrite the active registry.
    const sessionId=randomUUID(),hostFile=path.join(browserProfileRoot(),`${key}.${sessionId}.host.json`);
    const executableKind=prior?.executable_kind==='isolated'?'isolated':'standard';
    const entry=await launchManagedBrowser(key,sessionId,profile,hostFile,executableKind);
    await writeJsonAtomic(file+'.active',entry);return entry;
  }finally{await release();}
}
export async function switchManagedBrowser(key,{url='https://www.yupao.com/zhaogong/'}={}){
  if(key!=='yupao')throw Error('当前仅支持鱼泡切换浏览器');
  const file=registryFile(key),workerFile=file+'.worker.lock';
  const owner=await fs.readFile(workerFile,'utf8').then(JSON.parse).catch(()=>null);
  if(owner&&processAlive(owner.pid))throw Error('鱼泡采集正在使用浏览器，请先暂停采集再切换');
  const releaseWorker=await lockFile(workerFile);
  let releaseStartup,sourceBrowser,targetBrowser,target;
  try{
    await ensureManagedBrowser(key);
    releaseStartup=await lockFile(file+'.lock');
    const source=await managedBrowserState(key);
    if(!source)throw Error('原浏览器已关闭，请重新打开登录浏览器后再切换');
    sourceBrowser=await chromium.connectOverCDP(source.endpoint);
    const sourceContext=sourceBrowser.contexts()[0];
    const state=await sourceContext.storageState();
    const transferHost=new URL(url).hostname;
    const belongsToTarget=hostname=>hostname===transferHost||hostname.endsWith('.'+transferHost)||(transferHost.endsWith('.yupao.com')&&(hostname==='yupao.com'||hostname.endsWith('.yupao.com')));
    // Local Edge initialization may contain other sites; only transfer the target platform to Chrome.
    state.cookies=state.cookies.filter(cookie=>belongsToTarget(cookie.domain.replace(/^\./,'')));
    state.origins=state.origins.filter(origin=>belongsToTarget(new URL(origin.origin).hostname));
    // CDP reconnects do not track origins previously visited by another client.
    const origins=new Map(state.origins.map(origin=>[origin.origin,origin]));
    for(const page of sourceContext.pages()){
      if(!/^https?:\/\//.test(page.url()))continue;
      if(!belongsToTarget(new URL(page.url()).hostname))continue;
      const origin=await page.evaluate(()=>({origin:location.origin,localStorage:Object.keys(localStorage).map(name=>({name,value:localStorage.getItem(name)}))}));
      origins.set(origin.origin,origin);
    }
    state.origins=[...origins.values()];
    const sessionId=randomUUID(),profile=path.join(browserProfileRoot(),key+'-instances',sessionId);
    const executableKind=source.executable_kind==='isolated'?'standard':'isolated';
    target=await launchManagedBrowser(key,sessionId,profile,path.join(browserProfileRoot(),`${key}.${sessionId}.host.json`),executableKind);
    targetBrowser=await chromium.connectOverCDP(target.endpoint);
    if(source.executable_path&&path.resolve(source.executable_path).toLowerCase()===path.resolve(target.executable_path).toLowerCase())throw Error('新实例未使用不同路径的 EXE，已取消切换');
    if(source.browser_pid&&source.browser_pid===target.browser_pid)throw Error('新实例未创建独立进程，已取消切换');
    const context=targetBrowser.contexts()[0];
    await context.addCookies(state.cookies);
    const installed=await context.cookies();
    if(state.cookies.some(cookie=>!installed.some(item=>item.name===cookie.name&&item.domain===cookie.domain&&item.path===cookie.path&&item.value===cookie.value)))throw Error('Cookie迁移检查失败');
    const page=context.pages()[0]||await context.newPage();
    // Restore localStorage once at its own origin without making authenticated network requests.
    await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html></html>'}));
    try{
      for(const origin of state.origins){
        await page.goto(origin.origin,{waitUntil:'domcontentloaded'});
        await page.evaluate(items=>{for(const item of items)localStorage.setItem(item.name,item.value);},origin.localStorage);
      }
    }finally{await page.unroute('**/*');}
    await navigatePlatformLogin(page,key,url);
    await page.bringToFront();
    const entry={...target,switched_from:source.session_id,switched_at:new Date().toISOString()};
    await writeJsonAtomic(file+'.active',entry);
    return entry;
  }catch(error){
    if(targetBrowser)await (await targetBrowser.newBrowserCDPSession()).send('Browser.close').catch(()=>{});
    throw error;
  }finally{
    await sourceBrowser?.close().catch(()=>{});await targetBrowser?.close().catch(()=>{});
    await releaseStartup?.();await releaseWorker();
  }
}
export async function connectManagedContext(key,{lease=true}={}){
  let releaseLease;
  if(lease){
    const file=registryFile(key)+'.worker.lock';
    // One collector/label worker per platform; a visible login window is not a worker.
    const owner=await fs.readFile(file,'utf8').then(JSON.parse).catch(()=>null);
    if(owner&&processAlive(owner.pid))throw Error('该平台已有采集/打标程序使用浏览器，请先暂停该程序');
    releaseLease=await lockFile(file);
  }
  let browser;
  try{
    const entry=await ensureManagedBrowser(key);
    browser=await chromium.connectOverCDP(entry.endpoint);
    const context=browser.contexts()[0];if(!context)throw Error('受管理浏览器没有默认会话');
    let released=false;
    const close=async()=>{if(released)return;released=true;try{await browser.close();}finally{await releaseLease?.();}};
    return new Proxy(context,{get(target,prop){if(prop==='close')return close;if(prop==='managedSession')return entry;const value=Reflect.get(target,prop,target);return typeof value==='function'?value.bind(target):value;}});
  }catch(error){await browser?.close().catch(()=>{});await releaseLease?.();throw error;}
}
