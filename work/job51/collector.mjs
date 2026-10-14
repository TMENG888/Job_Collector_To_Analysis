import {assertCollectorResources} from '../collector_resources.mjs';
import {checkedJsonResponse} from '../collection_policy.mjs';
import {ChannelError,evidence,guard,openContext,readCheckpoint,saveCheckpoint} from '../browser_channel_common.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export function parse51Payload(body) {
  const job=body?.resultbody?.job;
  if(!job||!Array.isArray(job.items))throw new ChannelError('前程无忧响应无有效岗位列表：可能需要登录、验证或接口结构已变更','invalid_response');
  return {items:job.items,total:Number(job.totalCount??job.totalcount??job.items.length)};
}

export async function collect51Records(keyword,city,{checkpointPath,request={},maxPages=100,contextFactory=openContext}) {
  const saved=await readCheckpoint(checkpointPath);
  if(saved.completed)return {records:saved.records||[],total:saved.total||0};
  const records=new Map((saved.records||[]).map(record=>[String(record.jobId),record]));
  let context,page,total=saved.total||0,pageNo=1,completed=false;
  let lastCompletedPage=Number((saved.lastCompletedPage??(saved.error?0:saved.pageNo))||0);
  try {
    context=await contextFactory('job51');
    page=await context.newPage();
    let pending=null,lastError=null;
    const responses=new Map();
    const listener=response=>{
      let url;
      try{url=new URL(response.url());}catch{return;}
      if(!url.pathname.endsWith('/api/job/search-pc'))return;
      const pageNumber=Number(url.searchParams.get('pageNum')||1);
      pending=(async()=>{
        const parsed=parse51Payload(await checkedJsonResponse(response,'前程无忧'));
        responses.set(pageNumber,parsed);
      })().catch(error=>{lastError=error;});
    };
    page.on('response',listener);
    await page.goto(`https://we.51job.com/pc/search?jobArea=${encodeURIComponent(city.code)}&keyword=${encodeURIComponent(keyword)}&searchType=2`,{waitUntil:'domcontentloaded',timeout:30000});
    async function awaitPage(pageNumber) {
      const deadline=Date.now()+30000;
      while(Date.now()<deadline){
        await guard(page);
        if(lastError)throw lastError;
        if(responses.has(pageNumber))return responses.get(pageNumber);
        await sleep(250);
      }
      throw new ChannelError(`前程无忧第${pageNumber}页未返回岗位数据：已记录页面诊断，请人工检查登录、验证或网络`,'response_timeout');
    }
    let parsed=await awaitPage(1);
    total=parsed.total;
    const pages=Math.min(Math.ceil(total/20)||1,maxPages);
    for(pageNo=1;pageNo<=pages;pageNo++){
      if(pageNo%5===0&&contextFactory===openContext)await assertCollectorResources();
      if(pageNo>1){
        await sleep(Math.max(1200,request.minimumIntervalMs||0));
        await guard(page);
        const next=page.locator('.btn-next');
        if(!await next.count()||!await next.isEnabled())throw new ChannelError('前程无忧分页控件不可用，保留已有记录；请复核页面结构');
        await next.click({timeout:5000});
        parsed=await awaitPage(pageNo);
      }
      if(pageNo<=lastCompletedPage)continue;
      for(const record of parsed.items)if(record.jobId)records.set(String(record.jobId),record);
      lastCompletedPage=pageNo;
      completed=pageNo===pages&&pages>=Math.ceil(total/20);
      await saveCheckpoint(checkpointPath,{records:[...records.values()],total,pageNo,lastCompletedPage,completed});
      console.log(`job51 ${keyword}/${city.name}: ${pageNo}/${pages}，${records.size}条`);
    }
    page.off('response',listener);
    if(pending)await pending;
    return {records:[...records.values()],total};
  }catch(error){
    error.stopChannel=true;
    error.records=[...records.values()];
    error.total=total;
    await saveCheckpoint(checkpointPath,{records:error.records,total,pageNo,lastCompletedPage,completed:false,error:error.message});
    if(page)await evidence(page,checkpointPath,error);
    throw error;
  }finally{
    if(page)await page.close().catch(()=>{});
    if(context)await context.close();
  }
}
