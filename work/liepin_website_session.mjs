// Explicit website-session transport, not an HTTP failure fallback. Read only
// the search JSON that the official page itself requests. No cookie replay,
// injected fetch, stealth, captcha solving or automatic login.
import fs from 'node:fs/promises';
import path from 'node:path';
import {launchOrdinaryChromeContext} from './ordinary_chrome_session.mjs';
import {createPoliteHttpClient} from './polite_http_client.mjs';
import {withAccountLock} from './collection_concurrency.mjs';
import {writeJsonAtomic} from './collector_storage.mjs';
import {parseLiepinResponse,normalizeLiepinCard} from './direct_liepin_adapter.mjs';
import {LIEPIN_SEARCH_ENDPOINT} from './liepin_session_capture.mjs';
import {liepinCities} from './liepin_cities.mjs';

export const DEFAULT_LIEPIN_PROFILE='E:/Codex/work/job-collector-browser-sessions/liepin';
const fail=(message,code='invalid_response')=>Object.assign(Error(`猎聘：${message}`),{code,stopChannel:true});
export function websiteSearchURL(keyword,city,pageNo=0){
  if(typeof keyword!=='string'||!keyword.trim()||!Object.hasOwn(liepinCities,city?.name)
    ||String(city.code)!==liepinCities[city.name]||!Number.isSafeInteger(pageNo)||pageNo<0)throw fail('关键词、城市或页码无效','invalid_config');
  const url=new URL('https://www.liepin.com/zhaopin/');
  url.search=new URLSearchParams({key:keyword.trim(),dq:liepinCities[city.name],curPage:String(pageNo)});return url.href;
}
export async function assertWebsitePage(page){
  const url=new URL(page.url());
  if(url.hostname!=='www.liepin.com'||!url.pathname.startsWith('/zhaopin/'))throw fail('官网跳转到登录、验证或非搜索页面，请人工检查','verification_required');
  const visible=await page.locator('body').innerText({timeout:2000}).catch(()=> '');
  if(/请完成安全验证|请进行安全验证|访问异常|请按住滑块|访问过于频繁|操作过于频繁|请先登录|拖动滑块/.test(visible))throw fail('官网要求登录、验证或限流，已停止，不自动处理','verification_required');
}
export async function readWebsiteSearch(page,keyword,city,pageNo,{timeoutMs=15000}={}){
  const target=websiteSearchURL(keyword,city,pageNo);
  // Never navigate out of a current security challenge to automatically retry.
  if(/^https:\/\/(?:safe|passport)\.liepin\.com\//.test(page.url()||''))throw fail('当前官网仍在验证或登录页，请人工完成后再续采','verification_required');
  let settled;
  const waiting=page.waitForResponse(response=>{
    if(response.url().split('?')[0]!==LIEPIN_SEARCH_ENDPOINT)return false;
    const request=response.request();
    if(request.method()!=='POST')return false;
    let body;try{body=JSON.parse(request.postData());}catch{return false;}
    const form=body?.data?.mainSearchPcConditionForm;
    return form?.key===keyword.trim()&&String(form.dq)===String(city.code)&&Number(form.currentPage)===pageNo;
  },{timeout:timeoutMs}).then(async response=>{
    if([401,403,429].includes(response.status()))throw fail('官网搜索访问受限，已停止','access_blocked');
    if(response.status()!==200)throw fail('官网搜索返回异常状态','http_error');
    const raw=await response.text();
    if(Buffer.byteLength(raw)>4*1024**2)throw fail('官网搜索响应超过预算','response_too_large');
    let body;try{body=JSON.parse(raw);}catch{throw fail('官网未返回业务 JSON，请人工检查验证页面','verification_required');}
    parseLiepinResponse(body,{expectedPage:pageNo,requirePagination:true});return body;
  }).then(value=>{settled={value};},error=>{settled={error};});
  // Rejections are handled before navigation, including an early HTTP denial.
  try{
    const navigation=await page.goto(target,{waitUntil:'domcontentloaded',timeout:25000});
    if(navigation&&[401,403,429].includes(navigation.status()))throw fail('官网页面访问受限','access_blocked');
    if(navigation&&!navigation.ok())throw fail('官网页面加载失败','http_error');
    await assertWebsitePage(page);
    const deadline=Date.now()+timeoutMs;
    while(!settled&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,200));await assertWebsitePage(page);}
    await assertWebsitePage(page);
    if(settled?.error)throw settled.error;
    if(!settled?.value)throw fail('官网搜索响应超时，请人工检查会话','navigation_error');
    return settled.value;
  }catch(error){
    if(error.stopChannel)throw error;
    // Do not persist navigation exception URLs or headers in task diagnostics.
    throw fail('官网搜索加载失败，请人工检查登录或验证状态','navigation_error');
  }finally{void waiting;}
}
export async function launchWebsiteContext(profileDir,{executablePath=process.env.LIEPIN_BROWSER_EXECUTABLE||'C:/Program Files/Google/Chrome/Application/chrome.exe'}={}){
  if(!profileDir||!path.isAbsolute(profileDir))throw fail('浏览器会话目录必须是显式绝对路径','invalid_config');
  // E: may be absent; fail clearly instead of silently writing a profile to C:.
  await fs.mkdir(profileDir,{recursive:true});
  const tempDir=path.join(profileDir,'temp');await fs.mkdir(tempDir,{recursive:true});
  return launchOrdinaryChromeContext(profileDir,{executablePath});
}
export async function collectLiepinWebsite(keyword,city,{checkpointPath,taskId,maxPages=100,maxRows=Infinity,
  profileDir=process.env.LIEPIN_SESSION_PROFILE||DEFAULT_LIEPIN_PROFILE,
  rateDir=process.env.JOB_HTTP_RATE_DIR||path.resolve(import.meta.dirname,'../ui_data/http_rate_limits'),minimumIntervalMs,
  contextFactory=launchWebsiteContext,readPage=readWebsiteSearch,onPage=()=>{},responseTimeoutMs=15000}={}){
  websiteSearchURL(keyword,city);
  if(!taskId||!checkpointPath||!path.isAbsolute(profileDir)||!path.isAbsolute(rateDir))throw fail('缺少任务归属或会话/限速目录','invalid_config');
  if(!(maxRows===Infinity||Number.isSafeInteger(maxRows)&&maxRows>0)||!Number.isSafeInteger(maxPages)||maxPages<1||maxPages>100)throw fail('采集预算无效','invalid_config');
  let saved=await fs.readFile(checkpointPath,'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return {};throw error;});
  if(Object.keys(saved).length&&(saved.task_id!==taskId||saved.keyword!==keyword||saved.city?.name!==city.name||saved.city?.code!=null&&String(saved.city.code)!==String(city.code)))throw fail('断点任务或查询归属不匹配','TASK_OUTPUT_OWNERSHIP');
  const prior=saved.records??saved.rows??[];
  if(!Array.isArray(prior)||prior.some(row=>!row.job_id||row.platform!=='猎聘'||row.task_id&&row.task_id!==taskId))throw fail('断点记录损坏或归属不匹配','TASK_OUTPUT_OWNERSHIP');
  const known=new Map(prior.map(row=>[String(row.job_id),row]));
  let lastPage=Number(saved.lastPage??saved.nextPageNo??0),previousSignature=saved.previousSignature||'',total=Number(saved.total||0),totalPages=Number(saved.totalPages||0);
  // Old direct checkpoints with completed=true had no verified page bounds.
  // Preserve their rows; require human review rather than silently re-query.
  if(saved.completed&&saved.acquisition_mode!=='website_session_api'&&(!Number.isSafeInteger(saved.totalPages)||saved.totalPages<1))throw Object.assign(fail('旧完成标记缺少已核验分页，请人工复核','legacy_pagination_unverified'),{partialRows:[...known.values()]});
  if(!Number.isSafeInteger(lastPage)||lastPage<0)throw fail('断点页码无效');
  if(saved.completed||lastPage>=maxPages||known.size>=maxRows)return [...known.values()].slice(0,maxRows);
  let completed=false,context;
  const save=extra=>writeJsonAtomic(checkpointPath,{task_id:taskId,keyword,city,records:[...known.values()],lastPage,nextPageNo:lastPage,total,totalPages,previousSignature,completed,completion_reason:completed?'reported_page_window_end':null,acquisition_mode:'website_session_api',...extra});
  return withAccountLock(profileDir+'.collector.lock',taskId,async()=>{
    try{
      context=await contextFactory(profileDir);
      const page=context.ordinaryPage
        ? await context.ordinaryPage({hosts:['safe.liepin.com','passport.liepin.com','www.liepin.com']})
        : context.pages()[0]||await context.newPage();
      // One official page search per rate reservation, same origin lock and
      // cooldown files as HTTP. No HTTP attempt followed by browser fallback.
      const request=createPoliteHttpClient({stateDir:rateDir,minimumIntervalMs:Math.max(8000,Number(minimumIntervalMs)||0),attempts:1,fetchImpl:async()=>{
        const body=await readPage(page,keyword,city,lastPage,{timeoutMs:responseTimeoutMs});
        return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
      }});
      for(;lastPage<maxPages&&known.size<maxRows;){
        const response=await request(LIEPIN_SEARCH_ENDPOINT);
        const {list,pagination}=parseLiepinResponse(await response.json(),{expectedPage:lastPage,requirePagination:true});
        const signature=JSON.stringify(list.map(card=>String(card.job?.jobId||'')));
        if(list.length&&signature===previousSignature)throw fail('相邻页岗位重复，停止并保留断点','pagination_stalled');
        // Validate a whole page before changing records/cursor. Never advance a
        // partial page beyond a row cap: higher budgets can safely resume it.
        const rows=list.map(card=>({...normalizeLiepinCard(card,keyword,city.name),task_id:taskId,source_total:pagination.totalCounts,acquisition_mode:'website_session_api'}));
        for(const row of rows){if(known.size>=maxRows)break;known.set(row.job_id,row);}
        total=pagination.totalCounts;totalPages=pagination.totalPage;
        const wholePage=rows.every(row=>known.has(row.job_id));
        if(wholePage){lastPage++;previousSignature=signature;completed=lastPage>=totalPages;}
        await save();await onPage({page:lastPage,rows:known.size,total,completed});
        if(completed||!wholePage)break;
      }
      return [...known.values()];
    }catch(error){
      error.stopChannel=true;error.partialRows=[...known.values()];
      await save({error_code:error.code||'navigation_error'});throw error;
    }finally{if(context)await context.close();}
  },{interval:500});
}
