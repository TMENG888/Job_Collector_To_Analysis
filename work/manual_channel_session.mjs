// Human-in-the-loop browser sessions for channels that need a login or an
// official security check. The collector opens a dedicated Chrome profile,
// brings the official page to the front and waits. A human completes the
// login / slider / search; only then do we persist the resulting session and
// clear the local pause. No captcha solving, stealth flags or cookie replay
// into a different browser.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {launchOrdinaryChromeContext} from './ordinary_chrome_session.mjs';
import {standardBrowserExecutable} from './browser_executables.mjs';
import {writeJsonAtomic} from './collector_storage.mjs';
import {saveChannelVerification} from './channel_verification_state.mjs';

const loginCodes=new Set(['session_required','login_required','auth_required']);
const verifiedCodes=new Set([...loginCodes,'verification_required','access_blocked','navigation_error']);
const originKeys=Object.freeze({
  job51:['https://we.51job.com','https://cupid.51job.com'],
  liepin:['https://api-c.liepin.com','https://www.liepin.com'],
  zhaopin:['https://fe-api.zhaopin.com','https://www.zhaopin.com'],
});
const rateKey=origin=>createHash('sha256').update(origin).digest('hex').slice(0,24);
const profileRoot=()=>process.env.JOB_BROWSER_PROFILE_ROOT||path.join(process.env.LOCALAPPDATA||os.tmpdir(),'CodexJobCollectorProfilesV2');
const zhaopinProfile=()=>process.env.ZHAOPIN_LOGIN_PROFILE||path.join(profileRoot(),'zhaopin-login-session');
export const zhaopinCookieFile=path.resolve(import.meta.dirname,'../ui_data/zhaopin_login/cookies.json');
const alive=pid=>{try{if(!Number.isSafeInteger(Number(pid))||Number(pid)<1)return false;process.kill(Number(pid),0);return true;}catch{return false;}};

export function manualBrowserProfile(platform,override){
  if(override)return override;
  if(platform==='job51')return path.join(profileRoot(),'job51');
  if(platform==='liepin')return process.env.LIEPIN_SESSION_PROFILE||'E:/Codex/work/job-collector-browser-sessions/liepin';
  return zhaopinProfile();
}

// A true ordinary Chrome launch: no CDP/debugging port, so the platform sees
// the same browser shape as a Start-menu launch. The human logs in/solves the
// challenge here, closes the window, and the collector then re-opens the same
// profile with its local debugging port for recheck/collection.
export async function openPureManualBrowser(platform,url,{profile=manualBrowserProfile(platform)}={}){
  if(!['job51','liepin','zhaopin'].includes(platform))throw fail('该渠道不支持普通浏览器登录',400);
  if(typeof url!=='string'||!/^https:\/\//.test(url))throw fail('官网地址无效',400);
  const normal=await fs.readFile(path.join(profile,'.job-collector-normal-chrome.json'),'utf8').then(JSON.parse).catch(()=>null);
  if(normal?.pid&&alive(normal.pid))throw fail('该渠道采集浏览器正在运行；请先关闭它，再用普通浏览器登录');
  if(platform==='job51'){
    const active=await fs.readFile(path.join(profileRoot(),'job51.browser.json.active'),'utf8').then(JSON.parse).catch(()=>null);
    if(active?.state==='open'&&alive(active.host_pid))throw fail('51job 采集窗口正在运行；请先关闭它，再用普通浏览器登录');
  }
  let child;
  try{
    child=spawn(standardBrowserExecutable,[`--user-data-dir=${profile}`,'--no-first-run','--source-shortcut-location=start-menu','--new-window',url],{detached:true,windowsHide:false,stdio:'ignore'});
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
    child.unref();
  }catch{throw fail('普通 Chrome 未能启动，请检查安装路径或配置目录占用',409);}
  return {state:'manual_open',platform,profile,url,message:'已用普通 Chrome 打开（不带调试端口、未接管）；完成登录/验证后请关闭该窗口，再点“复检采集会话”'};
}

const fail=(message,status=409)=>Object.assign(Error(message),{status});
const sessions=new Map();

export async function clearPlatformCooldown(platform,rateDir,{now=new Date().toISOString()}={}){
  for(const origin of originKeys[platform]||[]){
    const file=path.join(rateDir,rateKey(origin)+'.json');
    const state=await fs.readFile(file,'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    if(!state)continue;
    await writeJsonAtomic(file,{...state,cooldownUntil:0,status:`manual_${state.status||'verified'}`,manualVerifiedAt:now});
  }
}

// Resolve only the failures that the human's action actually covers. A login
// acknowledgement must not silently mark a captcha/verification failure as
// resolved; that requires the explicit "已验证" action.
export async function markChannelReady(task,platform,{state='verified',rateDir,note=''}={}){
  if(!['job51','liepin','zhaopin'].includes(platform))throw fail('该渠道不支持人工会话确认',400);
  if(!['logged_in','verified'].includes(state))throw fail('人工状态无效',400);
  const file=path.join(task.outputDir,'采集清单.json');
  const manifest=await fs.readFile(file,'utf8').then(JSON.parse);
  if(manifest.task_id!==task.id)throw fail('采集清单归属不匹配',400);
  const channel=manifest.platforms?.[platform];
  if(!channel)throw fail('渠道清单不存在',400);
  const now=new Date().toISOString(),resolved=[];
  channel.errors=(channel.errors||[]).map(error=>{
    if(error.resolved_at)return error;
    const code=String(error.code||'');
    const covered=state==='verified'?verifiedCodes.has(code):loginCodes.has(code);
    if(!covered)return error;
    resolved.push(code);
    return {...error,resolved_at:now,resolution:`manual_${state}`,...(note?{manual_note:note}:{})};
  });
  await writeJsonAtomic(file,manifest);
  if(rateDir)await clearPlatformCooldown(platform,rateDir,{now});
  const verificationState=state==='verified'?'verified':'manual_checked';
  await saveChannelVerification(task,platform,{
    state:verificationState,mode:'manual',verifiedAt:state==='verified'?now:null,
    acknowledgedAt:now,reason:note||(state==='verified'?'人工已完成登录/验证，采集会话可继续':'人工已确认登录，待观察搜索响应'),
  });
  return {platform,state:verificationState,resolvedCount:resolved.length,resolved,verifiedAt:now};
}

export async function openZhaopinSession(taskId,{url='https://www.zhaopin.com/'}={}){
  const previous=sessions.get(taskId);
  if(previous){
    await previous.page.bringToFront().catch(()=>{});
    return {state:'open',reused:true,profile:zhaopinProfile(),message:'已切回智联登录窗口'};
  }
  const context=await launchOrdinaryChromeContext(zhaopinProfile(),{executablePath:standardBrowserExecutable});
  const page=context.ordinaryPage
    ? await context.ordinaryPage({hosts:['www.zhaopin.com','passport.zhaopin.com']})
    : context.pages()[0]||await context.newPage();
  try{
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
  }catch{/* The visible window may be on a challenge page; leave it for the human. */}
  await page.bringToFront().catch(()=>{});
  sessions.set(taskId,{context,page,openedAt:new Date().toISOString()});
  return {state:'open',profile:zhaopinProfile(),message:'智联登录窗口已打开；请手动登录，完成后点击“已登录”或“已验证”'};
}

export async function saveZhaopinCookies(taskId){
  const entry=sessions.get(taskId);
  if(!entry)throw fail('智联登录窗口未打开，请先点击“打开登录窗口”');
  const cookies=await entry.context.cookies();
  const zhaopin=cookies.filter(cookie=>/(^|\.)zhaopin\.com$/i.test(String(cookie.domain||'').replace(/^\./,''))&&cookie.value);
  const hasAccess=zhaopin.some(cookie=>cookie.name==='at');
  const hasRefresh=zhaopin.some(cookie=>cookie.name==='rt');
  if(!hasAccess||!hasRefresh)throw fail('尚未检测到智联登录态（缺少 at/rt）；请先在窗口中完成登录');
  await fs.mkdir(path.dirname(zhaopinCookieFile),{recursive:true});
  await writeJsonAtomic(zhaopinCookieFile,{
    saved_at:new Date().toISOString(),refreshed_at:null,saved_by:'manual_zhaopin_session',cookies:zhaopin,
  });
  return {count:zhaopin.length,cookieFile:zhaopinCookieFile};
}

export async function closeZhaopinSession(taskId){
  const entry=sessions.get(taskId);
  if(!entry)return {state:'closed'};
  sessions.delete(taskId);
  await entry.context.close().catch(()=>{});
  return {state:'closed',message:'智联登录连接已断开；窗口和登录资料保留'};
}

export function zhaopinSessionOpen(taskId){return sessions.has(taskId);}