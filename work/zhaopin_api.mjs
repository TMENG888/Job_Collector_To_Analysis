import {parseZhaopinList} from './list_page_guard.mjs';
import {zhaopinCheckpoint} from './zhaopin_checkpoint.mjs';

const failure = (message, code='invalid_response') => Object.assign(new Error(`智联接口：${message}`), {code, stopChannel:true});
export function zhaopinJobId(row) {
  return row?.number ? String(row.number) : row?.jobId != null ? String(row.jobId) : '';
}
export function mergeZhaopinRawRow(previous,row) {
  const merged={...previous,...row};
  // SSR rows and interrupted detail requests must not erase already collected
  // descriptions for the same stable job ID.
  if(!row.jobDetailData?.position?.desc?.description && previous?.jobDetailData?.position?.desc?.description)merged.jobDetailData=previous.jobDetailData;
  if(!row.jobDescription && previous?.jobDescription)merged.jobDescription=previous.jobDescription;
  return merged;
}
export function assertZhaopinCheckpointTask(checkpoint,taskId) {
  if(taskId && checkpoint?.task_id && checkpoint.task_id!==taskId)throw failure('断点任务 ID 与当前任务不一致，拒绝载入其他任务数据','task_ownership_mismatch');
  return checkpoint;
}
export function zhaopinApiCheckpoint(current) {
  const checkpoint={...zhaopinCheckpoint(current),acquisition_mode:'session_api',api_first_page_verified:current.apiFirstPageVerified===true};
  // A terminal bootstrap page does not yet prove that the SSR first page's
  // detail fields have been fetched. A restart must still enrich page one.
  if(!checkpoint.api_first_page_verified)Object.assign(checkpoint,{complete:false,end_page:false,completion_reason:'in_progress'});
  return checkpoint;
}
export function isZhaopinCheckpointExhausted(checkpoint) {
  if(!checkpoint || checkpoint.api_first_page_verified===false)return false;
  const count=Array.isArray(checkpoint.records)?checkpoint.records.length:0,total=Number(checkpoint.total||0);
  return checkpoint.end_page===true || (total>0 && count>=total) || ['end_page','total_reached','confirmed_empty'].includes(checkpoint.completion_reason);
}
export function parseZhaopinApi(body, status=200) {
  if ([401,403,429].includes(status)) throw failure(`HTTP ${status}，请人工检查登录或访问限制，已停止并保留断点`, 'access_blocked');
  if (status !== 200) throw failure(`HTTP ${status}`,'http_error');
  if (typeof body === 'string') {
    try {body=JSON.parse(body);} catch {throw failure('响应不是职位 JSON，请检查登录或安全验证','verification_required');}
  }
  const verification=body?.data?.isVerification;
  if (verification===true || verification===1 || verification==='1' || verification==='true')
    throw failure('网站要求人工验证，已停止并保留断点','verification_required');
  if ([401,403,429,'401','403','429'].includes(body?.code)) throw failure('登录或访问权限已失效，请人工处理','access_blocked');
  if ([401,403,429,'401','403','429'].includes(body?.data?.statusCode)) throw failure('登录或访问权限已失效，请人工处理','access_blocked');
  if(body?.data?.statusCode != null && ![0,200,'0','200'].includes(body.data.statusCode))throw failure('职位接口业务状态异常，不能判定为零岗位');
  try {return parseZhaopinList(body);} catch {throw failure('职位响应业务失败或结构异常，不能判定为零岗位');}
}
export function observedZhaopinTemplate(request, keyword, cityCode) {
  const url=new URL(request.url());
  if(url.origin!=='https://fe-api.zhaopin.com' || url.pathname!=='/c/i/search/positions' || request.method()!=='POST')return null;
  let body;
  try {body=request.postDataJSON();} catch{return null;}
  if(body?.S_SOU_FULL_INDEX!==keyword || String(body?.S_SOU_WORK_CITY)!==String(cityCode))return null;
  if(!Number.isInteger(Number(body.pageIndex)) || Number(body.pageIndex)<1 || !Number.isInteger(Number(body.pageSize)) || Number(body.pageSize)<1)return null;
  // Tokens and site-generated request IDs stay in memory, never in checkpoints/logs.
  const headers=Object.fromEntries(Object.entries(request.headers()).filter(([name])=>/^(content-type|authorization|x-)/i.test(name)));
  return {url:url.href,body:structuredClone(body),headers,pageIndex:Number(body.pageIndex)};
}
export function pageRequestFromTemplate(template,pageIndex) {
  if(!template || !Number.isInteger(pageIndex) || pageIndex<1)throw failure('未捕获当前搜索条件的有效请求模板','api_template_missing');
  return {url:template.url,method:'POST',headers:{...template.headers},body:JSON.stringify({...structuredClone(template.body),pageIndex})};
}
export function zhaopinTemplateForQuery(template,keyword,cityCode) {
  if(!template || new URL(template.url).origin!=='https://fe-api.zhaopin.com')throw failure('尚无当前登录会话生成的请求模板','api_template_missing');
  return {...template,headers:{...template.headers},body:{...structuredClone(template.body),S_SOU_FULL_INDEX:keyword,S_SOU_WORK_CITY:String(cityCode)}};
}
export function mergeZhaopinPage(current,parsed,pageIndex) {
  current.validResponse=true;
  current.explicitEmpty=parsed.explicitEmpty && current.records.size===0;
  current.total=parsed.total;
  if(pageIndex>=Number(current.lastPageIndex||1))current.endPage=parsed.endPage;
  current.lastPageIndex=Math.max(Number(current.lastPageIndex)||1,pageIndex);
  if(!current.observedPages.has(pageIndex)) {
    current.observedPages.add(pageIndex);
    const probe=current.yieldWindow?.observe(parsed.rows.map(zhaopinJobId));
    if(probe?.defer)current.lowYield=probe;
  }
  for(const row of parsed.rows) {
    const id=zhaopinJobId(row);
    if(id)current.records.set(id,mergeZhaopinRawRow(current.records.get(id),row));
  }
}
export async function fetchZhaopinPage(page,template,pageIndex) {
  const request=pageRequestFromTemplate(template,pageIndex);
  let response;
  try {
    response=await page.evaluate(async request=>{
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);
      try {
        const response=await fetch(request.url,{method:request.method,headers:request.headers,body:request.body,credentials:'include',signal:controller.signal});
        return {status:response.status,text:await response.text()};
      } catch {return {networkError:true};} finally {clearTimeout(timer);}
    },request);
  } catch {throw failure('浏览器会话已关闭或网络请求中断，保留断点后再续采','network_error');}
  if(response?.networkError)throw failure('会话请求失败或超时，保留断点后再续采','network_error');
  return parseZhaopinApi(response?.text,response?.status);
}

// Arm before navigation. Normal site requests establish the live template;
// subsequent pages are requested directly through the same browser session.
export function captureZhaopinTemplate(page, current, onPage=()=>{}) {
  let template=null,error=null,disposed=false;
  const pending=new Set();
  const requests=new WeakMap();
  const onRequest=request=>{
    const observed=observedZhaopinTemplate(request,current.keyword,current.city.code);
    if(observed)requests.set(request,observed);
  };
  const onResponse=response=>{
    const observed=requests.get(response.request());
    if(!observed || disposed)return;
    const task=(async()=>{
      try {
        const parsed=parseZhaopinApi(await response.text(),response.status());
        if(disposed)return;
        template=observed;
        mergeZhaopinPage(current,parsed,observed.pageIndex);
        await onPage(current);
      } catch(e) {if(!disposed)error=e;}
    })();
    pending.add(task);task.then(()=>pending.delete(task),()=>pending.delete(task));
  };
  page.on('request',onRequest);page.on('response',onResponse);
  return {
    get template(){return template;},
    check(){if(error)throw error;},
    async settle(){await Promise.all(pending);if(error)throw error;},
    async dispose(){disposed=true;page.off('request',onRequest);page.off('response',onResponse);await Promise.all(pending);},
  };
}

export async function establishZhaopinTemplate(page,capture,{before=async()=>{},wait=ms=>new Promise(r=>setTimeout(r,ms)),timeoutMs=15000}={}) {
  capture.check();
  if(capture.template)return capture.template;
  await before();
  // SSR sends page one in HTML. One normal site's load-more action is needed
  // to observe its authentic API request; it is not the pagination strategy.
  await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline) {
    await wait(250);capture.check();
    if(capture.template){await capture.settle();return capture.template;}
  }
  await capture.settle();
  throw failure('未收到网站生成的职位接口请求；请人工检查当前搜索页，已保存断点','api_template_missing');
}
