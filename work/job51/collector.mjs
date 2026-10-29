import {assertCollectorResources} from '../collector_resources.mjs';
import {ChannelError,evidence,guard,openContext,readCheckpoint,saveCheckpoint} from '../browser_channel_common.mjs';
import {gotoWithRetries} from '../browser_navigation_retry.mjs';
import {job51SessionPage,job51NextPageState,assertBusinessResponse,waitWebsiteClient} from '../website_session_api.mjs';
import {hasVerifiedSessionCompletion,sessionCompletionNeedsAudit,pageSignature as signatureOf,paginationVersion} from '../session_pagination_health.mjs';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export function parse51Payload(body) {
  if(!body?.resultbody?.job||!Array.isArray(body.resultbody.job.items))throw new ChannelError('前程无忧响应无有效岗位列表：可能需要登录、验证或接口结构已变更','invalid_response');
  assertBusinessResponse(body,'前程无忧','1');
  const job=body.resultbody.job;
  const rawTotal=job.totalCount??job.totalcount,total=Number(rawTotal);
  if(rawTotal==null||!Number.isSafeInteger(total)||total<0)throw new ChannelError('前程无忧接口缺失有效分页总数，已停止并保留断点','invalid_response');
  return {items:job.items,total};
}
export async function collect51Records(keyword,city,{checkpointPath,request={},maxPages=100,maxRows=Infinity,contextFactory=openContext,wait=sleep,paginationMode='website_next'}) {
  const saved=await readCheckpoint(checkpointPath);
  if(saved.keyword!=null&&saved.keyword!==keyword||saved.city!=null&&(saved.city.name!==city.name||String(saved.city.code)!==String(city.code)))throw new ChannelError('前程无忧断点检索条件不匹配','TASK_OUTPUT_OWNERSHIP');
  if(hasVerifiedSessionCompletion(saved,'job51'))return {records:saved.records||[],total:saved.total||0};
  const audit=sessionCompletionNeedsAudit(saved,'job51');
  const records=new Map((saved.records||[]).filter(r=>r.jobId).map(r=>[String(r.jobId),r]));
  let context,page,total=Number(saved.total||0),completed=false,lastRequestedPage=0;
  let lastCompletedPage=audit?0:Number((saved.lastCompletedPage??(saved.error?0:saved.pageNo))||0);
  let pageNo=audit?1:Math.max(1,Number(saved.nextPageNo||lastCompletedPage+1)),nextCardIndex=audit?0:Number(saved.nextCardIndex||0),pageSignature=audit?'':saved.pageSignature||'';
  let pagination=audit?null:saved.pagination||null;
  const pages=audit?[]:[...(pagination?.pages||[])];
  const limit=Math.max(0,Number(maxRows)),save=(extra={})=>saveCheckpoint(checkpointPath,{keyword,city,records:[...records.values()],total,pageNo,nextPageNo:pageNo,nextCardIndex,pageSignature,lastCompletedPage,completed,pagination,acquisition_mode:'browser_session_api',...extra});
  try {
    if(audit)console.log(`[断点复核] 前程无忧 ${keyword}/${city.name} 的旧完成标记缺少分页证据；仅复检该条件，保留${records.size}条记录`);
    if(records.size>=limit){await save();return {records:[...records.values()],total}}
    context=await contextFactory('job51');page=await context.newPage();
    await gotoWithRetries(page,'https://we.51job.com/pc/search?jobArea='+encodeURIComponent(city.code)+'&keyword='+encodeURIComponent(keyword)+'&searchType=2',{waitUntil:'domcontentloaded',timeout:30000,attempts:3});
    await guard(page);
    await waitWebsiteClient(page,'job51');
    for(;pageNo<=Math.max(1,Number(maxPages)||1)&&records.size<limit;){
      if(pageNo%5===0&&contextFactory===openContext)await assertCollectorResources();
      await wait(Math.max(1200,request.minimumIntervalMs||0));
      const parsed=parse51Payload(await job51SessionPage(page,pageNo,{method:paginationMode==='website_next'&&lastRequestedPage>0&&lastRequestedPage===pageNo-1?'next':'client'}));total=parsed.total;lastRequestedPage=pageNo;
      if(parsed.items.some(row=>!row?.jobId||!String(row.jobName||'').trim())||total===0&&parsed.items.length)throw new ChannelError('前程无忧岗位标识、标题或总数与列表不一致','invalid_response');
      if(!parsed.items.length){
        if(total>0||records.size>0)throw new ChannelError('前程无忧空页缺少可靠末页证据，保留当前页待复检','pagination_stalled');
        pagination={version:paginationVersion,platform:'job51',keyword,cityCode:String(city.code),page:pageNo,received:0,total,rows:records.size,consumedAll:true,reason:'confirmed_empty',pages};
        completed=true;await save();break;
      }
      const digest=signatureOf(parsed.items.map(row=>row.jobId));
      if(pages.some(p=>p.page!==pageNo&&p.signature===digest))throw new ChannelError('前程无忧不同页返回相同岗位，保留当前页，不认定采完','pagination_stalled');
      const signature=JSON.stringify(parsed.items.map(x=>String(x.jobId)));if(signature!==pageSignature)nextCardIndex=0;pageSignature=signature;
      pagination={version:paginationVersion,platform:'job51',keyword,cityCode:String(city.code),page:pageNo,received:parsed.items.length,total,rows:records.size,consumedAll:false,reason:'in_progress',pages};
      for(let i=nextCardIndex;i<parsed.items.length&&records.size<limit;i++){
        const row=parsed.items[i];if(row.jobId&&row.jobName)records.set(String(row.jobId),{...row,acquisition_mode:'browser_session_api',access_level:'本地会话接口完整列表字段与岗位描述'});
        nextCardIndex=i+1;pagination.rows=records.size;await save();
      }
      console.log('job51 '+keyword+'/'+city.name+': 接口第'+pageNo+'页，'+records.size+'条');
      if(nextCardIndex<parsed.items.length)break;
      const prior=pages.findIndex(p=>p.page===pageNo),observed={page:pageNo,received:parsed.items.length,signature:digest};
      if(prior<0)pages.push(observed);else pages[prior]=observed;
      pages.sort((a,b)=>a.page-b.page);
      const contiguous=pages.length===pageNo&&pages.every((p,i)=>p.page===i+1);
      const nextEnabled=paginationMode==='website_next'?await job51NextPageState(page):null;
      const websiteEnd=nextEnabled===false;
      completed=nextEnabled!==null?websiteEnd:records.size>=total||contiguous&&pages.reduce((sum,p)=>sum+p.received,0)>=total;
      pagination={...pagination,consumedAll:true,websiteEnd,reason:completed?(websiteEnd?'website_end':records.size>=total?'total_reached':'observed_total_reached'):'in_progress',pages};
      lastCompletedPage=pageNo;pageNo++;nextCardIndex=0;pageSignature='';await save();if(completed)break;
    }
    return {records:[...records.values()],total};
  }catch(error){error.stopChannel=true;error.records=[...records.values()];error.total=total;completed=false;await save({error:error.message});if(page)await evidence(page,checkpointPath,error);throw error}
  finally{if(page)await page.close().catch(()=>{});if(context)await context.close()}
}


