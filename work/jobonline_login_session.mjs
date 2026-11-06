import fs from 'node:fs/promises';
import path from 'node:path';
import {launchOrdinaryChromeContext} from './ordinary_chrome_session.mjs';
import {isolatedBrowserExecutable} from './browser_executables.mjs';
import {writeJsonAtomic} from './collector_storage.mjs';
import {createPoliteHttpClient} from './polite_http_client.mjs';
import {parseJobonlineResponse} from './direct_jobonline_adapter.mjs';
import {JOBONLINE_DETAIL_ENDPOINT} from './jobonline_details.mjs';

export const jobonlineLoginProfile=()=>process.env.JOBONLINE_SESSION_PROFILE||'E:/Codex/work/job-collector-browser-sessions/jobonline-edge';
const endpoint='https://api.jobonline.cn/jobtbao-es-api/elastic/api/position/common/v1/showlist?bodytarget=SEARCH_RESULT_PAGE';
const fail=(message,code='session_required')=>Object.assign(Error(message),{code,stopChannel:true,status:409});
const read=async file=>fs.readFile(file,'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
const alive=pid=>{try{process.kill(Number(pid),0);return Number(pid)>0;}catch{return false;}};
const labels={login_required:'请先登录',expired:'登录已失效',pending:'待验证登录',verified:'登录已验证',verification_required:'请完成人工验证'};
export async function saveJobonlineLoginState(state,{profile=jobonlineLoginProfile(),now=()=>new Date().toISOString()}={}){
  const entry={state,checkedAt:now(),label:labels[state]||'待核验登录',browser:'edge'};
  await fs.mkdir(profile,{recursive:true});await writeJsonAtomic(path.join(profile,'jobonline-login-state.json'),entry);return entry;
}
export async function jobonlineLoginStatus({profile=jobonlineLoginProfile()}={}){
  const [saved,browser]=await Promise.all([read(path.join(profile,'jobonline-login-state.json')),read(path.join(profile,'.job-collector-normal-chrome.json'))]);
  const connected=browser?.kind==='job-collector-normal-chrome-v1'&&alive(browser.pid);
  if(!connected)return {state:'login_required',label:'请先登录',connected:false,browser:'edge',reason:'请用本系统的 Edge 登录窗口完成就业在线登录，随后验证并续采'};
  return {...saved,state:saved?.state||'pending',label:labels[saved?.state]||'待验证登录',connected:true,browser:'edge'};
}
export function jobonlineSearchParam(keyword,city){
  if(typeof keyword!=='string'||!keyword.trim()||keyword.length>200||!city?.name||city.code&&!/^\d{6}$/.test(String(city.code)))throw fail('就业在线查询条件无效','invalid_config');
  return {jobFairId:null,licenseNumber:null,industryCode:null,jobAge:null,eduDegree:null,salaryRange:null,nature:null,size:null,introCategory:null,channelNumber:null,cityCode:city.code?Number(city.code):null,areaCode:null,areaCodes:null,positionCode:null,positionCode1:null,positionCode1s:null,positionCode2:null,positionCode3:null,name:null,id:null,positionName3:keyword.trim(),companyId:null,sortType:1,provinceCode:null,provinceCodes:null,areaId:null,zc:null,zcAreaId:null,cityCodes:null,category:'',pageorder:'DESC'};
}
export async function assertJobonlineCredential(page){
  let value;
  try{value=await page.evaluate(()=>({origin:location.origin,loggedIn:Boolean(localStorage.getItem('token_key')),verificationRequired:[...document.querySelectorAll('#WAF_NC_WRAPPER,.aliyunCaptcha-sliding-body,.nc-container,.geetest_panel,.verify-wrap,.captcha-dialog')].some(element=>element.getClientRects().length>0&&getComputedStyle(element).visibility!=='hidden')}));}
  catch(cause){throw Object.assign(fail('就业在线登录窗口不可用，请重新打开窗口并核验登录','client_unavailable'),{cause});}
  if(value.verificationRequired)throw fail('就业在线要求人工验证，请在登录窗口处理','verification_required');
  if(value.origin!=='https://www.jobonline.cn'||!value.loggedIn)throw fail('未检测到就业在线登录会话，请先在登录窗口完成人工登录');
}
async function readJobonlineWebsiteApi(page,url,data,{requestOptions={},requestFactory=createPoliteHttpClient}={}){
  await assertJobonlineCredential(page);
  const request=requestFactory({stateDir:process.env.JOB_HTTP_RATE_DIR||path.resolve(import.meta.dirname,'../ui_data/http_rate_limits'),minimumIntervalMs:requestOptions.minimumIntervalMs||4000,jitterMs:requestOptions.jitterMs??1000,attempts:1,fetchImpl:async()=>{
    await assertJobonlineCredential(page);
    let result;
    try{result=await page.evaluate(async({url,data})=>{
      const vm=[...document.querySelectorAll('*')].map(element=>element.__vue__).find(value=>typeof value?.$post==='function');
      if(!vm)return {ok:false,code:'client_unavailable'};
      let timer;
      try{
        const payload={...data};
        if(payload.businessEnum==='POSITION_DETAIL')payload.activityCode=sessionStorage.getItem('activityCode')||'';
        return await Promise.race([vm.$post(url,payload).then(body=>({ok:true,body})),new Promise(resolve=>{timer=setTimeout(()=>resolve({ok:false,code:'network_timeout'}),15000);})]);
      }
      catch(error){return {ok:false,code:String(error?.response?.status||error?.code||'request_failed')};}
      finally{clearTimeout(timer);}
    },{url,data});}
    catch(cause){throw Object.assign(fail('就业在线页面会话调用中断，已停止并保留断点','client_unavailable'),{cause});}
    if(!result.ok)throw fail('就业在线会话接口请求未通过，请在登录窗口核对后重新验证',['10002','10004','401'].includes(result.code)?'session_required':['403','429'].includes(result.code)?'verification_required':result.code);
    const body=result.body;
    if(['10002','10004','401'].includes(String(body?.code)))throw fail('就业在线登录已过期，请重新登录');
    if(['403','429'].includes(String(body?.code)))throw fail('就业在线要求人工验证，请在登录窗口处理','verification_required');
    return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
  }});
  const response=await request(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
  return response.json();
}
export async function readJobonlineWebsiteDetail(page,jobId,options={}){
  if(typeof jobId!=='string'||!/^\d{1,30}$/.test(jobId))throw fail('详情岗位 ID 无效','invalid_config');
  return readJobonlineWebsiteApi(page,JOBONLINE_DETAIL_ENDPOINT,{positionId:jobId,businessEnum:'POSITION_DETAIL'},options);
}
export async function readJobonlineWebsiteWindow(page,keyword,city,options={}){
  const param=jobonlineSearchParam(keyword,city);
  const body=await readJobonlineWebsiteApi(page,endpoint,{target:'SEARCH_RESULT_PAGE',param},options),parsed=parseJobonlineResponse(body);
  if(parsed.paginated)throw fail('官网登录搜索窗口契约发生变化，已保留数据','api_schema_changed');
  const search=body.object.searchList,more=body.object.moreList||[];
  const unique=new Map();
  for(const [source,rows]of [['searchList',search],['moreList',more]])for(const row of rows)if(!unique.has(String(row.id)))unique.set(String(row.id),{...row,website_list:source});
  return {...parsed,searchCount:search.length,moreCount:more.length,returnedCount:search.length+more.length,list:[...unique.values()]};
}
export function createJobonlineLoginManager({profile=jobonlineLoginProfile(),launchContext=launchOrdinaryChromeContext,readWindow=readJobonlineWebsiteWindow,readDetail=readJobonlineWebsiteDetail}={}){
  let opening=false,checking=false;
  const attach=()=>launchContext(profile,{executablePath:isolatedBrowserExecutable,existingOnly:true});
  const pick=async context=>context.ordinaryPage?context.ordinaryPage({hosts:['www.jobonline.cn']}):context.pages().find(page=>page.url().startsWith('https://www.jobonline.cn/'));
  const prepare=async(context,keyword)=>{
    const page=await pick(context);if(!page)throw fail('未找到就业在线登录页面');
    if(!page.url().startsWith('https://www.jobonline.cn/'))await page.goto('https://www.jobonline.cn/findPosition?q='+encodeURIComponent(keyword),{waitUntil:'domcontentloaded',timeout:30000});
    return page;
  };
  return {
    async status(){const state=await jobonlineLoginStatus({profile});return {...state,...(checking?{state:'checking',label:'正在验证登录'}:{})};},
    async open(keyword){
      if(opening||checking)throw fail('登录操作正在进行，请稍候');opening=true;let context;
      try{context=await launchContext(profile,{executablePath:isolatedBrowserExecutable});const page=await prepare(context,keyword);await page.bringToFront();await saveJobonlineLoginState('pending',{profile});return {state:'pending',message:'Edge 登录窗口已打开；人工登录后点击“验证并继续采集”'};}
      finally{await context?.close().catch(()=>{});opening=false;}
    },
    async verify(keyword,city,options={}){
      if(opening||checking)throw fail('登录操作正在进行，请稍候');checking=true;let context;
      try{context=await attach();const page=await prepare(context,keyword);await page.waitForFunction(()=>[...document.querySelectorAll('*')].some(e=>typeof e.__vue__?.$post==='function'),null,{timeout:15000});const result=await readWindow(page,keyword,city,options);await saveJobonlineLoginState('verified',{profile});return {state:'verified',searchCount:result.searchCount,moreCount:result.moreCount,message:'登录和官网搜索已验证，将继续原任务的就业在线采集'};}
      catch(error){await saveJobonlineLoginState(error.code==='verification_required'?'verification_required':'expired',{profile});throw error;}
      finally{await context?.close().catch(()=>{});checking=false;}
    },
    async withCollection(keyword,city,callback,options={}){
      let context;
      try{
        context=await attach();const page=await prepare(context,keyword);
        await page.waitForFunction(()=>[...document.querySelectorAll('*')].some(e=>typeof e.__vue__?.$post==='function'),null,{timeout:15000});
        const result=await callback({collectWindow:()=>readWindow(page,keyword,city,options),collectDetail:row=>readDetail(page,String(row.job_id),options)});
        await saveJobonlineLoginState('verified',{profile});return result;
      }catch(error){if(['session_required','login_required','access_blocked','verification_required'].includes(error.code))await saveJobonlineLoginState(error.code==='verification_required'?'verification_required':'expired',{profile});throw error;}
      finally{await context?.close().catch(()=>{});}
    },
    async collect(keyword,city,options={}){
      let context;
      try{context=await attach();const page=await prepare(context,keyword);const result=await readWindow(page,keyword,city,options);await saveJobonlineLoginState('verified',{profile});return result;}
      catch(error){if(['session_required','login_required','access_blocked','verification_required'].includes(error.code))await saveJobonlineLoginState(error.code==='verification_required'?'verification_required':'expired',{profile});throw error;}
      finally{await context?.close().catch(()=>{});}
    }
  };
}
