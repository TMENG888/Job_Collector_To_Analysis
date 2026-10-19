import {assertCollectorResources} from '../collector_resources.mjs';
import {ChannelError,evidence,guard,openContext,readCheckpoint,saveCheckpoint} from '../browser_channel_common.mjs';
import {gotoWithRetries} from '../browser_navigation_retry.mjs';
import {job51SessionPage,assertBusinessResponse,waitWebsiteClient} from '../website_session_api.mjs';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export function parse51Payload(body) {
  if(!body?.resultbody?.job||!Array.isArray(body.resultbody.job.items))throw new ChannelError('前程无忧响应无有效岗位列表：可能需要登录、验证或接口结构已变更','invalid_response');
  assertBusinessResponse(body,'前程无忧','1');
  const job=body.resultbody.job;
  const rawTotal=job.totalCount??job.totalcount,total=Number(rawTotal);
  if(rawTotal==null||!Number.isSafeInteger(total)||total<0)throw new ChannelError('前程无忧接口缺失有效分页总数，已停止并保留断点','invalid_response');
  return {items:job.items,total};
}
export async function collect51Records(keyword,city,{checkpointPath,request={},maxPages=100,maxRows=Infinity,contextFactory=openContext,wait=sleep}) {
  const saved=await readCheckpoint(checkpointPath);if(saved.completed)return {records:saved.records||[],total:saved.total||0};
  const records=new Map((saved.records||[]).filter(r=>r.jobId).map(r=>[String(r.jobId),r]));
  let context,page,total=Number(saved.total||0),completed=false;
  let lastCompletedPage=Number((saved.lastCompletedPage??(saved.error?0:saved.pageNo))||0);
  let pageNo=Math.max(1,Number(saved.nextPageNo||lastCompletedPage+1)),nextCardIndex=Number(saved.nextCardIndex||0),pageSignature=saved.pageSignature||'';
  const limit=Math.max(0,Number(maxRows)),save=(extra={})=>saveCheckpoint(checkpointPath,{records:[...records.values()],total,pageNo,nextPageNo:pageNo,nextCardIndex,pageSignature,lastCompletedPage,completed,acquisition_mode:'browser_session_api',...extra});
  try {
    if(records.size>=limit){await save();return {records:[...records.values()],total}}
    context=await contextFactory('job51');page=await context.newPage();
    await gotoWithRetries(page,'https://we.51job.com/pc/search?jobArea='+encodeURIComponent(city.code)+'&keyword='+encodeURIComponent(keyword)+'&searchType=2',{waitUntil:'domcontentloaded',timeout:30000,attempts:3});
    await guard(page);
    await waitWebsiteClient(page,'job51');
    for(;pageNo<=Math.max(1,Number(maxPages)||1)&&records.size<limit;){
      if(pageNo%5===0&&contextFactory===openContext)await assertCollectorResources();
      await wait(Math.max(1200,request.minimumIntervalMs||0));
      const parsed=parse51Payload(await job51SessionPage(page,pageNo));total=parsed.total;
      if(!parsed.items.length){completed=true;await save();break}
      const signature=JSON.stringify(parsed.items.map(x=>String(x.jobId)));if(signature!==pageSignature)nextCardIndex=0;pageSignature=signature;
      for(let i=nextCardIndex;i<parsed.items.length&&records.size<limit;i++){
        const row=parsed.items[i];if(row.jobId&&row.jobName)records.set(String(row.jobId),{...row,acquisition_mode:'browser_session_api',access_level:'本地会话接口完整列表字段与岗位描述'});
        nextCardIndex=i+1;await save();
      }
      console.log('job51 '+keyword+'/'+city.name+': 接口第'+pageNo+'页，'+records.size+'条');
      if(nextCardIndex<parsed.items.length)break;
      lastCompletedPage=pageNo;completed=pageNo*20>=total||parsed.items.length<20;pageNo++;nextCardIndex=0;pageSignature='';await save();if(completed)break;
    }
    return {records:[...records.values()],total};
  }catch(error){error.stopChannel=true;error.records=[...records.values()];error.total=total;completed=false;await save({error:error.message});if(page)await evidence(page,checkpointPath,error);throw error}
  finally{if(page)await page.close().catch(()=>{});if(context)await context.close()}
}
