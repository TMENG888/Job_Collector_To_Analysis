import {ChannelError,guard,openContext,readCheckpoint,saveCheckpoint} from './browser_channel_common.mjs';
import {yieldNote} from './collection_yield.mjs';
import {liepinCities} from './liepin_cities.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const text=value=>String(value??'').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').trim();
const join=value=>(Array.isArray(value)?value:[value]).map(item=>text(typeof item==='object'?item?.label||item?.name:item)).filter(Boolean).join(' | ');
const validCount=value=>value!==null&&value!==undefined&&value!==''&&Number.isSafeInteger(Number(value))&&Number(value)>=0;
export const LIEPIN_SEARCH_METHOD='com.liepin.searchfront4c.pc-search-job';

export function liepinSearchURL(keyword,city,pageNo=0){
  const name=typeof city==='string'?city:city?.name;
  if(!Object.hasOwn(liepinCities,name))throw new ChannelError('猎聘城市未配置，拒绝静默改为全国','invalid_config');
  const url=new URL('https://www.liepin.com/zhaopin/');
  url.searchParams.set('key',keyword);url.searchParams.set('dq',liepinCities[name]);url.searchParams.set('curPage',String(pageNo));
  return url.href;
}

export function parseLiepinPayload(body,expectedPage){
  if(!body||typeof body!=='object')throw new ChannelError('猎聘未返回有效 JSON，已停止并保留断点','invalid_response');
  const info=body.data;
  if(info?.backUrl||info?.euuid||/安全验证|短信验证|账号.*异常|验证码/.test(String(body.message||body.msg||'')))throw new ChannelError('猎聘需要人工安全/短信验证；不会自动处理验证','verification_required');
  if(Number(body.flag)!==1)throw new ChannelError('猎聘会话失效或接口拒绝访问，请人工检查登录状态','login_required');
  const pagination=info?.pagination,items=info?.data?.jobCardList;
  if(!Array.isArray(items)||!pagination||!['currentPage','totalPage','totalCounts','pageSize'].every(key=>validCount(pagination[key]))||Number(pagination.pageSize)<1){
    throw new ChannelError('猎聘岗位列表或分页结构变化，不能认定采集完成','invalid_response');
  }
  if(expectedPage!=null&&Number(pagination.currentPage)!==expectedPage)throw new ChannelError('猎聘实际页码未跟随请求，已停止深分页并保留断点','pagination_stalled');
  const total=Number(pagination.totalCounts),totalPages=Number(pagination.totalPage);
  if(items.length&&total===0||!items.length&&total>0||total>0&&totalPages<1)throw new ChannelError('猎聘分页总数与岗位列表不一致，已停止并保留断点','invalid_response');
  return {items,total,totalPages,pageNo:Number(pagination.currentPage),pageSize:Number(pagination.pageSize)};
}

export function normalizeLiepinRecord(card,keyword,city,total=0){
  const job=card.job||{},comp=card.comp||{},recruiter=card.recruiter||{};
  if(!job.jobId||!job.title)throw new ChannelError('猎聘岗位缺少 ID 或标题，已停止避免静默丢弃','invalid_response');
  // The observed search API does not provide full JD text. Never present list
  // fields as completed details or infer skills from the search keyword.
  return {platform:'猎聘',query_keyword:keyword,query_city:typeof city==='string'?city:city.name,
    job_id:String(job.jobId),job_name:text(job.title),company_id:String(comp.compId||''),company_name:text(comp.compName),salary:text(job.salary),
    city:text(job.dq),district:'',experience:text(job.requireWorkYears),education:text(job.requireEduLevel),employment_type:text(job.jobKind),
    company_nature:'',company_size:text(comp.compScale),industry:text(comp.compIndustry),publish_time:'',refresh_time:text(job.refreshTime),deadline:'',
    tags:join(job.labels||[]),skills:'',job_description:'',address:text(job.dq),recruiter_name:text(recruiter.recruiterName),recruiter_title:'',
    job_url:safeJobURL(job.link||job.pcOuterLink),company_url:safeJobURL(comp.link),source_total:total,
    acquisition_mode:'browser_session_api',access_level:'猎聘搜索接口列表字段；未采集完整岗位详情',detail_status:'list_only',collected_at:new Date().toISOString()};
}
function safeJobURL(value){if(!value)return '';try{const url=new URL(value,'https://www.liepin.com');return url.protocol==='https:'&&(url.hostname==='liepin.com'||url.hostname.endsWith('.liepin.com'))?url.href:'';}catch{return '';}}
function isSearchResponse(response){try{const url=new URL(response.url());return (url.hostname==='liepin.com'||url.hostname.endsWith('.liepin.com'))&&url.pathname.endsWith('/'+LIEPIN_SEARCH_METHOD);}catch{return false;}}

async function readSearchPage(page,url,pageNo,{timeoutMs=15000,wait=sleep}={}){
  let result;
  const response=page.waitForResponse(isSearchResponse,{timeout:timeoutMs}).then(async response=>{
    if([401,403,429].includes(response.status()))throw new ChannelError('猎聘接口拒绝访问或限流，已停止；请人工检查会话','access_blocked');
    if(response.status()!==200)throw new ChannelError('猎聘接口返回异常状态，已停止并保留断点','invalid_response');
    let body;try{body=await response.json();}catch{throw new ChannelError('猎聘接口未返回 JSON，可能需要人工验证','invalid_response');}
    return parseLiepinPayload(body,pageNo);
  });
  // Attach rejection handling before navigation; an early HTTP rejection must
  // not become an unhandled promise while goto is in progress.
  const settled=response.then(value=>{result={value};},error=>{result={error};});
  try{
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});
    const deadline=Date.now()+timeoutMs;
    while(!result&&Date.now()<deadline){await guard(page);await wait(150);}
    await guard(page);
    if(!result)throw new ChannelError('猎聘搜索接口未响应，请检查当前登录/验证页面后续采','navigation_error');
    if(result.error){if(result.error instanceof ChannelError)throw result.error;throw new ChannelError('猎聘搜索接口等待失败，已保留断点；请检查登录/验证状态','navigation_error');}
    return result.value;
  }finally{void settled;}
}

export async function collectLiepin(keyword,city,{checkpointPath,taskId=process.env.JOB_COLLECTOR_TASK_ID,request={},maxPages=20,maxRows=100,maxNewRows=1000,contextFactory=openContext,yieldWindow=null,onDefer=()=>{},wait=sleep,responseTimeoutMs=15000}={}){
  const firstURL=liepinSearchURL(keyword,city,0),saved=await readCheckpoint(checkpointPath);
  if(saved.task_id&&taskId&&saved.task_id!==taskId)throw new ChannelError('猎聘断点任务 ID 不匹配','TASK_OUTPUT_OWNERSHIP');
  if(saved.keyword&&saved.keyword!==keyword||saved.city?.name&&saved.city.name!==city.name)throw new ChannelError('猎聘断点查询条件不匹配，拒绝混入其他任务','TASK_OUTPUT_OWNERSHIP');
  if(saved.records!=null&&!Array.isArray(saved.records))throw new ChannelError('猎聘断点记录损坏','invalid_response');
  const records=new Map((saved.records||[]).map(row=>[String(row.job_id),row]));
  for(const row of records.values())if(!row.job_id||row.platform!=='猎聘'||row.task_id&&taskId&&row.task_id!==taskId)throw new ChannelError('猎聘断点记录归属不匹配','TASK_OUTPUT_OWNERSHIP');
  if(saved.completed)return [...records.values()];
  const cap=Math.max(0,Math.min(Number(maxRows)||0,records.size+Math.max(0,Number(maxNewRows)||0)));
  const pageLimit=Math.max(1,Math.min(100,Math.floor(Number(maxPages)||1)));
  let context,page,pageNo=Number(saved.nextPageNo??0),nextCardIndex=Number(saved.nextCardIndex||0),pageSignature=saved.pageSignature||'',total=Number(saved.total||0),completed=false,completionReason=null,lowYield=null,previousSignature=saved.previousSignature||'';
  if(!Number.isSafeInteger(pageNo)||pageNo<0||!Number.isSafeInteger(nextCardIndex)||nextCardIndex<0)throw new ChannelError('猎聘断点游标损坏','invalid_response');
  const save=extra=>saveCheckpoint(checkpointPath,{task_id:taskId||null,keyword,city:{name:city.name,code:liepinCities[city.name]},records:[...records.values()],total,nextPageNo:pageNo,nextCardIndex,pageSignature,previousSignature,completed,completion_reason:completionReason,low_yield:lowYield,acquisition_mode:'browser_session_api',...extra});
  try{
    if(records.size>=cap){await save();return [...records.values()];}
    context=await contextFactory('liepin');page=await context.newPage();
    for(;pageNo<pageLimit&&records.size<cap;){
      await wait(Math.max(1200,Number(request.minimumIntervalMs)||0));
      const parsed=await readSearchPage(page,pageNo===0?firstURL:liepinSearchURL(keyword,city,pageNo),pageNo,{timeoutMs:responseTimeoutMs,wait});total=parsed.total;
      if(!parsed.items.length){completed=true;completionReason='empty_result';await save();break;}
      const signature=JSON.stringify(parsed.items.map(card=>String(card.job?.jobId||'')));
      if(previousSignature===signature)throw new ChannelError('猎聘相邻页岗位完全重复，已停止并保留断点，未认定穷尽','pagination_stalled');
      if(pageSignature!==signature)nextCardIndex=0;pageSignature=signature;
      const ids=[];
      for(let index=nextCardIndex;index<parsed.items.length&&records.size<cap;index++){
        const row=normalizeLiepinRecord(parsed.items[index],keyword,city,total);if(taskId)row.task_id=taskId;
        ids.push(row.job_id);if(!records.has(row.job_id))records.set(row.job_id,row);nextCardIndex=index+1;await save();
      }
      console.log('liepin '+keyword+'/'+city.name+': 接口第'+(pageNo+1)+'页，'+records.size+'条（列表字段）');
      if(nextCardIndex<parsed.items.length)break;
      previousSignature=signature;pageNo++;nextCardIndex=0;pageSignature='';
      // Historical payloads contradict hasNext, so use explicit page bounds.
      completed=pageNo>=parsed.totalPages;completionReason=completed?'reported_page_window_end':null;
      if(!completed&&yieldWindow&&ids.length){const probe=yieldWindow.observe(ids);if(probe.defer){lowYield={...probe,at:new Date().toISOString()};await save();onDefer();console.log('[低收益切换] liepin '+yieldNote(probe));break;}}
      await save();if(completed)break;
    }
    return [...records.values()];
  }catch(error){completed=false;error.stopChannel=true;error.partialRows=[...records.values()];
    // Persist only fixed error codes; raw response text, cookies and signed URLs
    // are deliberately excluded from diagnostics and checkpoints.
    try{await save({error_code:error.code||'navigation_error'});}catch(storageError){storageError.stopChannel=true;storageError.partialRows=[...records.values()];throw storageError;}
    throw error;
  }finally{if(page)await page.close().catch(()=>{});if(context)await context.close();}
}
