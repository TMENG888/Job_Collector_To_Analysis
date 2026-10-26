// User-clicked, visible website verification. No CAPTCHA automation, Cookie
// export or arbitrary URL/CDP attachment; only the collector's own sessions.
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DEFAULT_LIEPIN_PROFILE,launchWebsiteContext,websiteSearchURL,assertWebsitePage} from './liepin_website_session.mjs';
import {parseLiepinResponse} from './direct_liepin_adapter.mjs';
import {writeJsonAtomic} from './collector_storage.mjs';
import {liepinCities} from './liepin_cities.mjs';
import {openOfficialInOrdinaryBrowser} from './official_manual_browser.mjs';
import {channelErrorDiagnostic} from './channel_collection_diagnostics.mjs';
import {saveChannelVerification,readChannelVerification} from './channel_verification_state.mjs';
import {guard} from './browser_channel_common.mjs';
import {parse51Payload} from './job51/collector.mjs';

const supported=new Set(['job51','liepin']);
const manualCodes=new Set(['verification_required','session_required','login_required','access_blocked','navigation_error']);
const requiresManual=error=>manualCodes.has(error.code)||channelErrorDiagnostic([error])?.status==='manual';
const fail=(message,status=409)=>Object.assign(Error(message),{status});
export function verificationTarget(task,platform,config,manifest){
  if(!supported.has(platform)||!task.platforms?.includes(platform))throw fail('该渠道不支持当前验证入口',400);
  if(config?.task_id!==task.id||manifest?.task_id!==task.id)throw fail('配置或采集清单归属不匹配',400);
  const settings=config.platforms?.[platform];
  if(!settings?.enabled||!Array.isArray(settings.cities)||!settings.cities.length)throw fail('缺少渠道采集配置',400);
  const errors=(manifest.platforms?.[platform]?.errors||[]).filter(e=>requiresManual(e)&&!e.resolved_at);
  if(!errors.length)throw fail('当前渠道没有待处理的官网会话问题');
  const last=errors.at(-1),keywords=config.keywords||[];
  const keyword=keywords.includes(last.keyword)?last.keyword:keywords[0];
  const city=settings.cities.find(c=>c.name===last.city?.name)||settings.cities[0];
  if(typeof keyword!=='string'||!keyword.trim()||keyword.length>200||!city?.name)throw fail('搜索条件无效',400);
  let url;
  if(platform==='liepin'){
    if(String(city.code)!==liepinCities[city.name])throw fail('猎聘城市编码无效',400);
    url=websiteSearchURL(keyword,city);
  }else{
    if(!/^\d{6}$/.test(String(city.code)))throw fail('前程无忧城市编码无效',400);
    const target=new URL('https://we.51job.com/pc/search');target.search=new URLSearchParams({jobArea:city.code,keyword,searchType:'2'});url=target.href;
  }
  return {platform,keyword,city,url,profileDir:settings.browserProfileDir||process.env.LIEPIN_SESSION_PROFILE||DEFAULT_LIEPIN_PROFILE};
}
async function leaseProfile(profile,taskId){
  if(!path.isAbsolute(profile))throw fail('会话目录无效',400);
  await fs.mkdir(path.dirname(profile),{recursive:true});const file=profile+'.collector.lock';
  const raw=JSON.stringify({pid:process.pid,task_id:taskId,manual_verification:randomUUID()});
  for(let attempt=0;attempt<2;attempt++){
    try{const handle=await fs.open(file,'wx');await handle.writeFile(raw);return async()=>{await handle.close();if(await fs.readFile(file,'utf8').catch(()=>null)===raw)await fs.unlink(file);};}
    catch(error){
      if(error.code!=='EEXIST')throw error;
      const before=await fs.readFile(file,'utf8');let owner;try{owner=JSON.parse(before);}catch{throw fail('会话锁状态异常，请先检查采集进程');}
      if(!Number.isInteger(owner.pid)||owner.pid<1)throw fail('会话锁归属异常');
      try{process.kill(owner.pid,0);throw fail('该渠道正在使用浏览器，请先暂停采集后再验证');}catch(probe){
        if(probe.code!=='ESRCH')throw probe;
        if(await fs.readFile(file,'utf8')===before)await fs.unlink(file);
      }
    }
  }throw fail('该渠道会话正忙，请稍后再试');
}
async function openOwnedContext(target,task){
  if(target.platform==='liepin'){
    const release=await leaseProfile(target.profileDir,task.id);
    try{return {context:await launchWebsiteContext(target.profileDir),release,owned:true};}catch(error){await release();throw error;}
  }
  const {connectManagedContext}=await import('./managed_browser.mjs');
  return {context:await connectManagedContext('job51',target.recheck?{existingOnly:true,timeoutMs:5000}:{}),release:async()=>{},owned:false};
}
function officialPage(platform,value){
  try{const url=new URL(value);return platform==='liepin'?url.origin==='https://www.liepin.com'&&url.pathname.startsWith('/zhaopin/'):url.origin==='https://we.51job.com'&&url.pathname.startsWith('/pc/search');}catch{return false;}
}
export async function successfulWebsiteResponse(platform,response){
  const url=new URL(response.url());
  if(response.status()!==200)return false;
  if(platform==='liepin'){
    if(url.origin!=='https://api-c.liepin.com'||url.pathname!=='/api/com.liepin.searchfront4c.pc-search-job')return false;
    parseLiepinResponse(await response.json(),{requirePagination:true});return true;
  }
  if(url.protocol!=='https:'||!(url.hostname==='51job.com'||url.hostname.endsWith('.51job.com'))||url.pathname!=='/api/job/search-pc')return false;
  parse51Payload(await response.json());return true;
}
function isSearchResponse(platform,response){
  try{const url=new URL(response.url());return platform==='liepin'?url.origin==='https://api-c.liepin.com'&&url.pathname==='/api/com.liepin.searchfront4c.pc-search-job':url.protocol==='https:'&&(url.hostname==='51job.com'||url.hostname.endsWith('.51job.com'))&&url.pathname==='/api/job/search-pc';}catch{return false;}
}
export function createCollectorChannelVerification({openContext=openOwnedContext,now=()=>new Date().toISOString(),checkTimeoutMs=10000}={}){
  const sessions=new Map(),opening=new Set();
  const snapshot=entry=>({platform:entry.platform,state:entry.ready?'ready':entry.state,openedAt:entry.openedAt,verifiedAt:entry.verifiedAt||null});
  const status=taskId=>Object.fromEntries([...sessions.values()].filter(s=>s.task.id===taskId).map(s=>[s.platform,snapshot(s)]));
  async function closeEntry(entry){
    if(entry.closing)return entry.closing;
    entry.closing=(async()=>{
      sessions.delete(entry.platform);entry.page?.off('response',entry.listener);
      try{if(entry.owned)await entry.context.close();else{await entry.page?.close().catch(()=>{});await entry.context.close();}}
      finally{await entry.release();}
    })();return entry.closing;
  }
  return {
    status,
    assertAvailable(task){if([...sessions.values()].some(s=>task.platforms.includes(s.platform))||[...opening].some(p=>task.platforms.includes(p)))throw fail('请先完成验证或关闭该渠道验证窗口，再启动采集');},
    async open(task,platform,config,manifest,options={}){
      const previous=sessions.get(platform);
      if(previous){
        if(previous.task.id!==task.id)throw fail('该平台已有其他任务的验证窗口，请先完成或关闭');
        if(previous.context.assertOrdinaryPage)await previous.context.assertOrdinaryPage(previous.page);
        await previous.page.bringToFront();return {...snapshot(previous),message:'已切回官网验证窗口'};
      }
      if(opening.has(platform))throw fail('验证窗口正在打开，请勿重复点击');
      const target=verificationTarget(task,platform,config,manifest);opening.add(platform);
      let entry;
      try{
        const opened=await openContext({...target,recheck:options.recheck===true},task);entry={...opened,task,platform,target,state:'open',ready:false,openedAt:now()};
        entry.page=entry.context.ordinaryPage
          ? await entry.context.ordinaryPage({hosts:['safe.liepin.com','passport.liepin.com','www.liepin.com']})
          : entry.owned?(entry.context.pages()[0]||await entry.context.newPage()):await entry.context.newPage();
        sessions.set(platform,entry);
        entry.listener=async response=>{
          try{
            if(!isSearchResponse(platform,response)||!officialPage(platform,entry.page.url()))return;
            // A genuine search response, not an optimistic user click, is the
            // proof. No request bodies/headers or response data are persisted.
            const success=await successfulWebsiteResponse(platform,response);
            if(sessions.get(platform)===entry){entry.ready=success;entry.verifiedAt=success?now():null;if(!success)entry.checkFailure={code:'verification_required'};}
          }catch(error){entry.ready=false;entry.checkFailure={code:error.code||'invalid_response'};}
        };
        entry.page.on('response',entry.listener);
        const detach=()=>{if(sessions.get(platform)===entry)void closeEntry(entry).catch(()=>{});};
        entry.page.once('close',detach);entry.context.once('close',detach);
        await entry.page.bringToFront();
        const current=entry.page.url();
        const preserveNativePage=platform==='liepin'&&entry.context.ordinarySession?.reused&&/^https:\/\/(?:www|safe|passport)\.liepin\.com\//.test(current);
        // Reconnecting must not refresh a challenge or discard manual progress.
        if(!preserveNativePage){
          try{await entry.page.goto(target.url,{waitUntil:'domcontentloaded',timeout:25000});}
          catch{entry.state='navigation_pending';}
        }
        // Keep a visible verification/login page open for the human. Never
        // refresh, solve a challenge or automatically restart collection.
        return {...snapshot(entry),message:preserveNativePage?'已连接原普通 Chrome 窗口，未刷新；请手动完成验证或搜索':'官网窗口已打开；请手动验证，完成后点击“完成验证”'};
      }catch(error){if(entry)await closeEntry(entry).catch(()=>{});throw Object.assign(fail(error.status||error.code==='session_required'?error.message:'打开官网会话失败，请检查浏览器占用或本机会话配置',error.status||409),{code:error.code||'session_required'});}
      finally{opening.delete(platform);}
    },
    async finish(task,platform){
      const entry=sessions.get(platform);if(!entry||entry.task.id!==task.id)throw fail('当前任务没有对应的验证窗口');
      if(!entry.ready||!officialPage(platform,entry.page.url()))throw fail('尚未观察到官网搜索成功，请完成验证并在官网手动搜索一次');
      if(platform==='liepin')await assertWebsitePage(entry.page);
      else{const {guard}=await import('./browser_channel_common.mjs');await guard(entry.page);}
      const file=path.join(task.outputDir,'采集清单.json');const manifest=JSON.parse(await fs.readFile(file,'utf8'));
      if(manifest.task_id!==task.id)throw fail('采集清单归属不匹配',400);
      const channel=manifest.platforms?.[platform];if(!channel)throw fail('渠道清单不存在',400);
      const verifiedAt=entry.verifiedAt;
      channel.errors=(channel.errors||[]).map(error=>requiresManual(error)&&!error.resolved_at?{...error,resolved_at:verifiedAt,resolution:'manual_website_search'}:error);
      await writeJsonAtomic(file,manifest);
      await closeEntry(entry);
      return {state:'verified',platform,verifiedAt,message:'官网搜索已核验，会话已保留；请手动续采，站点冷却期不变'};
    },
    async recheck(task,platform,config,manifest){
      try{
        await this.open(task,platform,config,manifest,{recheck:true});
        const deadline=Date.now()+checkTimeoutMs;
        while(Date.now()<deadline){
          const entry=sessions.get(platform);
          if(!entry||entry.task.id!==task.id)throw fail('采集会话已断开，请重新核对');
          if(platform==='liepin')await assertWebsitePage(entry.page);else await guard(entry.page);
          if(entry.checkFailure)throw Object.assign(fail('采集会话复检未通过'),entry.checkFailure);
          if(entry.ready)return await this.finish(task,platform);
          await new Promise(resolve=>setTimeout(resolve,100));
        }
        throw Object.assign(fail('未观察到采集会话的有效搜索响应'),{code:'session_required'});
      }finally{
        const entry=sessions.get(platform);if(entry?.task.id===task.id)await closeEntry(entry);
      }
    },
    async close(task,platform){if(opening.has(platform))throw fail('验证窗口正在打开，请稍后再关闭');const entry=sessions.get(platform);if(entry&&entry.task.id!==task.id)throw fail('验证窗口归属不匹配');if(entry)await closeEntry(entry);return {message:platform==='liepin'?'验证连接已断开；普通 Chrome 窗口及登录资料保留，未启动采集':'验证窗口已关闭，会话资料保留；未启动采集'};},
  };
}

export function createChannelVerification({openContext=openOwnedContext,openBrowser=openOfficialInOrdinaryBrowser,now=()=>new Date().toISOString(),checkTimeoutMs=10000,beforeRecheck=async()=>{},recheckIntervalMs=60000}={}){
  const collector=createCollectorChannelVerification({openContext,now,checkTimeoutMs}),external=new Map(),opening=new Set(),checking=new Set();
  const key=(task,platform)=>task.id+':'+platform;
  return {
    status(taskId){return {...Object.fromEntries([...external.values()].filter(entry=>entry.taskId===taskId).map(({taskId,...entry})=>[entry.platform,entry])),
      ...Object.fromEntries(Object.entries(collector.status(taskId)).map(([platform,entry])=>[platform,{...entry,mode:'collector'}]))};},
    async taskStatus(task){
      const result={...await readChannelVerification(task),...this.status(task.id)};
      for(const platform of task.platforms||[])if(checking.has(key(task,platform)))result[platform]={...result[platform],state:'checking',mode:'ordinary'};
      return result;
    },
    assertAvailable(task){if(task.platforms.some(platform=>[...checking].some(id=>id.endsWith(':'+platform))))throw fail('渠道正在复检，请等待结果后再续采');collector.assertAvailable(task);},
    async open(task,platform,config,manifest,options={}){
      if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>!['mode','browserId'].includes(key)))throw fail('浏览器选项无效',400);
      const {mode='ordinary',browserId='edge'}=options;
      if(!['ordinary','collector'].includes(mode))throw fail('浏览器模式无效',400);
      if(mode==='collector'){
        const result=await collector.open(task,platform,config,manifest);
        external.delete(key(task,platform));return {...result,mode:'collector'};
      }
      const target=verificationTarget(task,platform,config,manifest),id=key(task,platform);
      if(collector.status(task.id)[platform])throw fail('请先断开当前采集会话验证连接，再打开普通浏览器');
      if(opening.has(id)||checking.has(id))throw fail('渠道操作进行中，请勿重复点击');
      opening.add(id);
      try{
        const browser=await openBrowser(target,{browserId});
        const entry={taskId:task.id,platform,mode:'ordinary',state:'manual_check',openedAt:now(),verifiedAt:null,...browser};
        external.set(id,entry);
        const {taskId,...result}=entry;
        return {...result,message:`已交给普通 ${browser.browserName} 打开，请在浏览器中手动操作；登录状态不自动同步到采集会话`};
      }finally{opening.delete(id);}
    },
    async finish(task,platform){
      if(opening.has(key(task,platform)))throw fail('普通浏览器正在打开，请稍后再核对');
      if(checking.has(key(task,platform)))throw fail('采集会话正在复检，请稍后再操作');
      if(collector.status(task.id)[platform]){
        const result=await collector.finish(task,platform);
        await saveChannelVerification(task,platform,{...result,mode:'collector'});return result;
      }
      const config=JSON.parse(await fs.readFile(task.publicConfigPath,'utf8')),manifest=JSON.parse(await fs.readFile(path.join(task.outputDir,'采集清单.json'),'utf8'));
      verificationTarget(task,platform,config,manifest);
      await saveChannelVerification(task,platform,{state:'manual_checked',mode:'ordinary',acknowledgedAt:now(),verifiedAt:null});
      external.delete(key(task,platform));
      return {platform,state:'manual_checked',mode:'ordinary',verifiedAt:null,message:'已保存人工核对；请点击“复检采集会话”，通过后再续采'};
    },
    async recheck(task,platform,config,manifest){
      const id=key(task,platform);
      if(opening.has(id)||checking.has(id))throw fail('渠道操作进行中，请勿重复点击');
      verificationTarget(task,platform,config,manifest);
      checking.add(id);
      try{
        const previous=(await readChannelVerification(task))[platform];
        if(previous?.lastCheckAt&&Date.parse(now())-Date.parse(previous.lastCheckAt)<recheckIntervalMs)throw Object.assign(fail('复检间隔至少60秒，请稍后再试'),{code:'rate_limited'});
        external.delete(id);
        await saveChannelVerification(task,platform,{state:'checking',mode:'ordinary',acknowledgedAt:now(),lastCheckAt:now()});
        await beforeRecheck(platform);
        const result=await collector.recheck(task,platform,config,manifest);
        await saveChannelVerification(task,platform,{...result,mode:'ordinary',lastCheckAt:now()});
        return result;
      }catch(error){
        const diagnostic=channelErrorDiagnostic([error]);
        if(diagnostic.code==='session_required')diagnostic.reason='采集会话未连接或未返回有效搜索；普通 Edge 的登录不会自动同步，请打开采集会话后核对';
        await saveChannelVerification(task,platform,{state:'recheck_failed',mode:'ordinary',failureStatus:diagnostic.status,failureCode:diagnostic.code,reason:diagnostic.reason,lastCheckAt:now()});
        return {platform,state:'recheck_failed',message:`复检未通过：${diagnostic.reason}；未启动采集`};
      }finally{checking.delete(id);}
    },
    async close(task,platform){
      if(opening.has(key(task,platform))||checking.has(key(task,platform)))throw fail('渠道操作进行中，请稍后再试');
      if(external.delete(key(task,platform)))return {message:'已收起人工核对状态；普通浏览器窗口及登录资料保持不变'};
      return collector.close(task,platform);
    },
  };
}
