import {ChannelError,guard} from './browser_channel_common.mjs';
import {checkedJsonResponse} from './collection_policy.mjs';
export const JOBONLINE_LIST_PATH='/jobtbao-es-api/elastic/api/position/queryPositionByCon';
export const JOBONLINE_DETAIL_PATH='/jobtbao-platform-srv/v1/platform/unsafe/position/getPositionDetail?target=POSITION_DETAIL';
export function assertBusinessResponse(body,channel,success='200') {
  const code=String(body?.code??body?.status??'');
  if(code!==success){
    const message=String(body?.message||body?.msg||'接口返回非成功业务状态');
    const blocked=/401|403|429/.test(code)||/登录|验证|验证码|限制|频繁|captcha|token/i.test(message);
    throw new ChannelError(`${channel}：${message} (${code||'无状态码'})，已停止并保留断点`,blocked?'verification_required':'invalid_response');
  }
  return body;
}
export async function waitWebsiteClient(page,channel,{timeoutMs=25000}={}){
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    await guard(page);
    const ready=await page.evaluate(({operation,channel})=>[...document.querySelectorAll('*')].some(e=>{
      const vm=e.__vue__;return channel==='jobonline'?typeof vm?.$post==='function'&&vm.condition&&Array.isArray(vm.positionList):vm?.$options?.name==='PCSearch'&&typeof vm.getSearch==='function'&&!vm.isLoading;
    }),{operation:'session_client_ready',channel});
    if(ready)return;
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  throw new ChannelError(`${channel} 网站 API 客户端加载超时，已停止并保留断点`,'client_unavailable');
}
function watchVerification(page,reject){
  let checking=false;
  return setInterval(()=>{if(checking)return;checking=true;guard(page).catch(reject).finally(()=>{checking=false})},300);
}
// Calls the loaded site's client: session cookies, encryption and signatures remain
// in the local browser. Saved credentials, ciphertext and static signatures are not replayed.
export async function jobonlineSessionRequest(page,url,data,{timeoutMs=30000}={}) {
  await guard(page);let rejectBlocked,timer;
  const blocked=new Promise((_,reject)=>{rejectBlocked=reject});
  const listener=response=>{
    try {if(new URL(response.url()).pathname!==new URL(url,'https://api.jobonline.cn').pathname)return;}catch{return;}
    checkedJsonResponse(response,'就业在线').then(body=>assertBusinessResponse(body,'就业在线')).catch(rejectBlocked);
  };
  page.on('response',listener);const watchdog=watchVerification(page,rejectBlocked);
  try{
    const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new ChannelError('就业在线会话接口超时，已停止并保留断点','response_timeout')),timeoutMs)});
    const result=await Promise.race([page.evaluate(async({operation,url,data})=>{
      const vm=[...document.querySelectorAll('*')].map(e=>e.__vue__).find(x=>typeof x?.$post==='function');
      if(!vm)return {ok:false,message:'页面未加载就业在线 API 客户端',code:'client_unavailable'};
      try{return {ok:true,data:await vm.$post(url,data)}}
      catch(error){return {ok:false,message:error.message||String(error),code:error.response?.status?'http_error':'request_failed'}};
    },{operation:'jobonline_api',url,data}),blocked,timeout]);
    if(!result?.ok)throw new ChannelError(result?.message||'就业在线客户端响应异常',result?.code||'invalid_response');
    await guard(page);return assertBusinessResponse(result.data,'就业在线');
  }finally{clearTimeout(timer);clearInterval(watchdog);page.off('response',listener)}
}
export async function job51NextPageState(page){
  const next=page.locator('.btn-next');
  if(typeof next.count!=='function'||typeof next.isEnabled!=='function'||!await next.count())return null;
  // The button is also disabled transiently while getSearch is loading. Wait
  // for the website client to settle before treating disabled as an end page.
  await waitWebsiteClient(page,'job51');
  return Boolean(await next.isEnabled());
}
export async function job51SessionPage(page,pageNo,{timeoutMs=30000,method='client'}={}) {
  await guard(page);let resolveResponse,rejectResponse,timer;
  const received=new Promise((resolve,reject)=>{resolveResponse=resolve;rejectResponse=reject});
  const listener=response=>{
    let url;try{url=new URL(response.url())}catch{return}
    if(url.pathname!=='/api/job/search-pc'||Number(url.searchParams.get('pageNum')||1)!==pageNo)return;
    checkedJsonResponse(response,'前程无忧').then(body=>assertBusinessResponse(body,'前程无忧','1')).then(resolveResponse,rejectResponse);
  };
  page.on('response',listener);const watchdog=watchVerification(page,rejectResponse);
  try{
    const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new ChannelError(`前程无忧第${pageNo}页接口超时，请人工检查本地会话；已保留断点`,'response_timeout')),timeoutMs)});
    // Restore the old website-next path for consecutive pages. A resumed cursor
    // jumps once through the official client, avoiding replay of pages 1..N.
    const useNext=method==='next'&&await job51NextPageState(page)!==null;
    const invocation=useNext?(async()=>{
      if(!await job51NextPageState(page))throw new ChannelError('前程无忧下一页当前不可用，保留断点待复核','pagination_stalled');
      await page.locator('.btn-next').click({timeout:5000});
    })():page.evaluate(({operation,pageNo})=>{
      const vm=[...document.querySelectorAll('*')].map(e=>e.__vue__).find(x=>x?.$options?.name==='PCSearch'&&typeof x.getSearch==='function');
      if(!vm)return {ok:false,message:'前程无忧页面 API 客户端未加载，不能安全生成新请求',code:'client_unavailable'};
      vm.searchParams.pageNum=pageNo;Promise.resolve(vm.getSearch(pageNo)).catch(()=>{});return {ok:true};
    },{operation:'job51_api',pageNo}).then(result=>{if(!result?.ok)throw new ChannelError(result?.message||'前程无忧客户端调用失败',result?.code||'invalid_response')});
    const body=await Promise.race([received,timeout,invocation.then(()=>received)]);
    await guard(page);return body;
  }finally{clearTimeout(timer);clearInterval(watchdog);page.off('response',listener)}
}
