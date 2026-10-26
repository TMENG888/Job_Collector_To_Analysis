import fs from 'node:fs/promises';
import path from 'node:path';
import {guard,ChannelError} from './browser_channel_common.mjs';
import {chromium} from 'playwright';
import {resolveBrowserExecutable} from './browser_executables.mjs';
import {assertBrowserPlatform} from './managed_browser.mjs';
import {assertCollectorResources} from './collector_resources.mjs';
import {writeJsonAtomic} from './collector_storage.mjs';
import {readNativeTaskRows,writeNativeChannelRows,nativeChannelNames} from './collector_native_sink.mjs';
import {validJobRecord,otherChannelValidCount} from './task_collection_target.mjs';
import {assertTaskOutputOwnership} from './task_dataset_scope.mjs';
import {withBrowserStep,assertBrowserAccess,recordBrowserDenial} from './browser_fallback_policy.mjs';
import {liepinCities} from './liepin_cities.mjs';

function liepinPageURL(keyword,city){
  if(!Object.hasOwn(liepinCities,city.name))throw new ChannelError('猎聘城市未配置','invalid_config');
  const url=new URL('https://www.liepin.com/zhaopin/');url.searchParams.set('key',keyword);url.searchParams.set('dq',liepinCities[city.name]);return url.href;
}

export const browserDomSpecs={
  zhaopin:{host:'zhaopin.com',anchors:'a[href*="jobs.zhaopin.com/"],a[href*="/jobdetail/"]',search:(k,c)=>`https://www.zhaopin.com/jobs?jl=${encodeURIComponent(c.code)}&kw=${encodeURIComponent(k)}`},
  job51:{host:'51job.com',anchors:'a[href*="jobs.51job.com/"],a[href*="/jobdetail"]',search:(k,c)=>`https://we.51job.com/pc/search?jobArea=${encodeURIComponent(c.code)}&keyword=${encodeURIComponent(k)}&searchType=2`},
  jobonline:{host:'jobonline.cn',anchors:'a[href*="positionDetail?id="],a[href*="positionDetail?positionId="]',search:k=>`https://www.jobonline.cn/findPositions?q=${encodeURIComponent(k)}`},
  liepin:{host:'liepin.com',anchors:'a[href*="/job/"],a[href*="/a/"]',search:liepinPageURL},
};
const safe=s=>String(s).replace(/[\\/:*?"<>|]/g,'_');
export function browserCheckpointPath(dir,platform,keyword,city){return path.join(dir,'断点数据','RPA',platform,`${safe(keyword)}_${safe(city.name)}.json`);}
export function browserJobIdentity(value,platform){
  try{
    const url=new URL(value),spec=browserDomSpecs[platform];
    if(!spec||url.protocol!=='https:'||url.username||url.password||!(url.hostname===spec.host||url.hostname.endsWith('.'+spec.host)))return null;
    let id='';
    if(platform==='jobonline')id=url.searchParams.get('id')||url.searchParams.get('positionId')||'';
    else if(platform==='job51')id=url.searchParams.get('jobId')||url.pathname.match(/\/(\d+)\.html?$/)?.[1]||'';
    else if(platform==='liepin')id=url.pathname.match(/\/(?:job|a)\/([\w-]+)\.(?:s?html?)$/)?.[1]||'';
    else id=url.pathname.match(/\/([\w-]+)\.html?$/)?.[1]||url.pathname.match(/\/jobdetail\/([\w-]+)/)?.[1]||'';
    if(!/^[\w-]{3,160}$/.test(id))return null;
    url.search='';url.hash='';if(platform==='jobonline')url.searchParams.set('id',id);if(platform==='job51'&&url.pathname.includes('jobdetail'))url.searchParams.set('jobId',id);
    return {id,url:url.href};
  }catch{return null;}
}
export async function readBrowserCards(page,spec){
  return page.locator(spec.anchors).evaluateAll(anchors=>anchors.filter(a=>a.getClientRects().length).map(a=>{
    const card=a.closest('article,li,.joblist-box__item,.job-card-wrapper,.joblist-item,.job-card,.position-item,.job-list-item')||a.parentElement;
    const get=selector=>card?.querySelector(selector)?.textContent?.trim()||'';
    return {url:a.href,title:(a.getAttribute('title')||a.innerText||'').trim(),company:get('.company-name,.companyName,.company__title,a[href*="/company/"],a[href*="/gongsi/"]'),salary:get('.salary,.job-salary,.job-salary__text'),city:get('.city,.work-city,.job-area,.area,.job-location')};
  }));
}
export async function readBrowserDetail(page){
  return page.evaluate(()=>{
    const get=selector=>document.querySelector(selector)?.innerText?.trim()||'';
    // Deliberately no whole-body fallback: navigation/footer/login text must
    // never masquerade as a job description or a complete record.
    return {title:get('h1'),company:get('.company-name,.companyName,.company__title'),city:get('.job-address,.work-city,.job-area,.job-location'),salary:get('.salary,.job-salary'),experience:get('.job-experience,.work-experience'),education:get('.job-education,.education'),description:get('.job-detail-description,.job-detail-describe,.describtion__detail-content,.job-desc,.job-description,.job-description-container,.position-description,.job-intro-content')};
  });
}
export async function clickNextBrowserPage(page){
  const next=page.getByRole('button',{name:/^(下一页|下页|Next)$/i}).or(page.getByRole('link',{name:/^(下一页|下页|Next)$/i})).first();
  if(!await next.count()||!await next.isVisible())return false;
  if(await next.isDisabled()||await next.getAttribute('aria-disabled')==='true'||/disabled/.test(await next.getAttribute('class')||''))return false;
  await next.click({timeout:15000});return true;
}
const readJSON=file=>fs.readFile(file,'utf8').then(JSON.parse).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
async function openDomContext(platform){
  assertBrowserPlatform(platform);await assertCollectorResources();
  if(!process.env.JOB_BROWSER_PROFILE_ROOT)throw new ChannelError('缺少独立浏览器目录','invalid_config');
  const profile=path.join(path.resolve(process.env.JOB_BROWSER_PROFILE_ROOT),'dom',platform);await fs.mkdir(profile,{recursive:true});
  // This worker owns this visible context and closes it on completion/pause.
  // Do not import personal profiles, proxies, cookies or stealth extensions.
  return chromium.launchPersistentContext(profile,{headless:false,chromiumSandbox:true,viewport:null,locale:'zh-CN',executablePath:await resolveBrowserExecutable('standard')});
}
export async function collectBrowserDom({platform,taskId,outputDir,combinations,maxPages=3,maxRows=200,taskTargetRows=0,stateDir,request={},contextFactory=openDomContext,resourceGuard=assertCollectorResources,step,spec=browserDomSpecs[platform],log=console.log}={}){
  if(!spec||!Number.isSafeInteger(maxPages)||maxPages<1||maxPages>50||!Number.isSafeInteger(maxRows)||maxRows<1||maxRows>10000)throw new ChannelError('浏览器分页/条数预算无效','invalid_config');
  await assertTaskOutputOwnership({id:taskId,outputDir});await resourceGuard();
  if(!step)await assertBrowserAccess(platform,stateDir);
  const rate=step||((action)=>withBrowserStep(platform,stateDir,action,request));
  const known=await readNativeTaskRows(outputDir,taskId,platform),rows=new Map(known.map(r=>[String(r.job_id),r]));
  const other=taskTargetRows?await otherChannelValidCount(outputDir,platform,taskId):0;
  let processed=0,valid=[...rows.values()].filter(validJobRecord).length;
  // A round's budget counts work done now, not historical HTTP rows. Otherwise
  // a large partial HTTP result would prevent any DOM detail enrichment.
  const enough=()=>processed>=maxRows||taskTargetRows>0&&other+valid>=taskTargetRows;
  let context,listPage,detailPage,blocked=null;const errors=[];
  try{
    if(enough())return {rows:rows.size,processed,valid,errors,transport:'browser_dom'};
    context=await contextFactory(platform);listPage=await context.newPage();detailPage=await context.newPage();
    const watch=response=>{void (async()=>{try{
      const url=new URL(response.url());if(!(url.hostname===spec.host||url.hostname.endsWith('.'+spec.host)))return;
      if([401,403,429].includes(response.status()))blocked=new ChannelError('浏览器页面请求被拒绝/限流，停止该渠道','access_blocked');
      // Observe only the normal page's response status, never replay a client
      // API. A failed list request must not be mistaken for an empty market.
      if(platform==='jobonline'&&url.pathname==='/jobtbao-es-api/elastic/api/position/queryPositionByCon'){
        const body=await response.json();if(body.code!=null&&String(body.code)!=='200')blocked=new ChannelError('网站页面自身的岗位列表请求失败，需人工复核','page_business_error');
      }
    }catch{}})();};
    listPage.on('response',watch);detailPage.on('response',watch);
    const check=async page=>{
      if(blocked)throw blocked;
      const current=new URL(page.url());
      if(!(current.hostname===spec.host||current.hostname.endsWith('.'+spec.host)))throw new ChannelError('页面跳转到未适配域名，停止人工复核','access_blocked');
      if(/security[-_]?center|captcha|\/login(?:\/|$)/i.test(current.pathname)||await page.locator('#WAF_NC_WRAPPER,.aliyunCaptcha-sliding-body,.geetest_panel,.captcha-dialog').filter({visible:true}).count())throw new ChannelError('页面需要人工登录或验证，停止该渠道','verification_required');
      await guard(page);if(blocked)throw blocked;
    };
    for(const {keyword,city}of combinations){
      if(enough())break;
      const file=browserCheckpointPath(outputDir,platform,keyword,city),saved=await readJSON(file);
      await fs.mkdir(path.dirname(file),{recursive:true});
      if(saved&&saved.task_id!==taskId)throw new ChannelError('RPA 断点任务归属不匹配','TASK_OUTPUT_OWNERSHIP');
      if(saved?.completed||saved?.budget_finished)continue;
      let lastSignature='',completed=false,budgetFinished=false,pageNo=1,stopReason=null;
      const records=new Map((saved?.records||[]).map(r=>[String(r.job_id),r]));
      const save=()=>writeJsonAtomic(file,{task_id:taskId,platform,keyword,city,records:[...records.values()],lastPage:pageNo,completed,budget_finished:budgetFinished,stop_reason:stopReason,acquisition_mode:'browser_dom',updatedAt:new Date().toISOString()});
      try{
        await rate(async()=>{await listPage.goto(spec.search(keyword,city),{waitUntil:'domcontentloaded',timeout:30000});await check(listPage);});
        for(;pageNo<=maxPages&&!enough();pageNo++){
          await resourceGuard();await check(listPage);
          // A fresh normal navigation can replay earlier visible pages after a
          // pause. Stable IDs skip known details; HTTP cursors are never copied.
          let cards=[],empty=false;
          for(let attempt=0;attempt<20;attempt++){await check(listPage);cards=await readBrowserCards(listPage,spec);if(cards.length)break;empty=/暂无(?:相关)?(?:职位|岗位)|未找到(?:相关)?(?:职位|岗位)|没有符合条件的职位/.test(await listPage.locator('body').innerText());await new Promise(r=>setTimeout(r,500));}
          if(!cards.length){await check(listPage);throw new ChannelError(empty?'页面显示空结果，但尚不能证实来源穷尽':'页面岗位链接未适配，需复核页面结构',empty?'empty_unverified':'layout_changed');}
          if(completed){await save();break;}
          const selected=new Map();for(const card of cards){const identity=browserJobIdentity(card.url,platform);if(identity&&card.title)selected.set(identity.id,{...card,...identity});}
          if(!selected.size)throw new ChannelError('页面未发现已适配的岗位链接，停止而非假报空结果','layout_changed');
          const signature=JSON.stringify([...selected.keys()]);if(signature===lastSignature)throw new ChannelError('页面翻页后岗位未变化，保留断点并切换条件','pagination_stalled');lastSignature=signature;
          for(const card of selected.values()){
            if(enough())break;
            if(validJobRecord(rows.get(card.id)||{})){records.set(card.id,rows.get(card.id));continue;}
            await resourceGuard();
            const detail=await rate(async()=>{await detailPage.goto(card.url,{waitUntil:'domcontentloaded',timeout:30000});await check(detailPage);await detailPage.locator('.job-detail-description,.job-detail-describe,.describtion__detail-content,.job-desc,.job-description,.job-description-container,.position-description,.job-intro-content').first().waitFor({state:'visible',timeout:4000}).catch(()=>{});await check(detailPage);return readBrowserDetail(detailPage);});
            const row={platform:nativeChannelNames[platform][0],task_id:taskId,job_id:card.id,job_url:card.url,job_name:detail.title||card.title,company_name:detail.company||card.company,city:detail.city||card.city,salary:detail.salary||card.salary,experience:detail.experience,education:detail.education,job_description:detail.description,query_keyword:keyword,query_city:city.name,acquisition_mode:'browser_dom',detail_status:detail.description.length>=20?'complete':'list_only',collected_at:new Date().toISOString()};
            processed++;
            if(validJobRecord(row))valid++;
            rows.set(card.id,row);records.set(card.id,row);await writeNativeChannelRows(outputDir,taskId,[row]);await save();
          }
          log(`[RPA页面] ${platform} ${keyword}/${city.name}: 第${pageNo}页，累计${rows.size}条；字段缺失不虚构`);
          if(enough()||pageNo===maxPages){budgetFinished=true;await save();break;}
          const next=await rate(async()=>{await check(listPage);const clicked=await clickNextBrowserPage(listPage);if(clicked)await listPage.waitForTimeout(800);await check(listPage);return clicked;});
          // Absence of an adapted next button is not proof of source exhaustion.
          if(!next){budgetFinished=true;await save();break;}await save();
        }
      }catch(error){stopReason=error.code||'navigation_error';await save();const scoped=['pagination_stalled','empty_unverified'].includes(error.code);errors.push({keyword,city,code:stopReason,stopChannel:!scoped});if(!scoped)throw error;}
    }
  }catch(error){if(!step)await recordBrowserDenial(platform,stateDir,error.code);if(!errors.some(e=>e.code===error.code))errors.push({code:error.code||'navigation_error',stopChannel:true});}
  finally{await listPage?.close().catch(()=>{});await detailPage?.close().catch(()=>{});await context?.close().catch(()=>{});}
  return {rows:rows.size,processed,valid,errors,transport:'browser_dom'};
}
