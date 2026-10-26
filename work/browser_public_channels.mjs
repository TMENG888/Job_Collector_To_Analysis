import {ChannelError,evidence,guard,openContext,readCheckpoint,saveCheckpoint} from './browser_channel_common.mjs';
import {yieldNote} from './collection_yield.mjs';
import {gotoWithRetries} from './browser_navigation_retry.mjs';
import {JobonlinePaginationHealth,unverifiedLegacyCompletion,collectionStopMessage} from './jobonline_pagination_health.mjs';
import {JOBONLINE_LIST_PATH,JOBONLINE_DETAIL_PATH,jobonlineSessionRequest,assertBusinessResponse,waitWebsiteClient} from './website_session_api.mjs';
export {ChannelError,blockedReason,openContext} from './browser_channel_common.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const text=value=>String(value??'').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').trim();
const timestamp=value=>value?(/^\d+$/.test(String(value))?new Date(Number(value)*1000).toISOString():String(value)):'';
export function parseJobonlineList(body){
  assertBusinessResponse(body,'就业在线');
  if(!Array.isArray(body.object?.rows))throw new ChannelError('就业在线分页接口列表结构变化，已停止并保留断点','invalid_response');
  const total=Number(body.object.total);
  if(body.object.total==null||!Number.isSafeInteger(total)||total<0)throw new ChannelError('就业在线接口缺失有效分页总数，已停止并保留断点','invalid_response');
  return {items:body.object.rows,total};
}
export function normalizeJobonlineRecord(list,body,keyword,city){
  assertBusinessResponse(body,'就业在线');const d=body.object;
  if(!d||String(d.id)!==String(list.id))throw new ChannelError('就业在线详情 ID 与列表不一致，已停止并保留断点','invalid_response');
  const c=d.companyBean||{},lo=d.lowSalaryOrigin??list.lowSalaryOrigin,hi=d.highSalaryOrigin??list.highSalaryOrigin;
  const salary=Number(lo)<0||Number(hi)<0?'面议':lo!=null&&hi!=null?lo+'-'+hi+(d.salaryUnitName||list.salaryUnitName||''):[d.lowSalary,d.highSalary].filter(x=>x!=null).join('-');
  return {platform:'就业在线',query_keyword:keyword,query_city:city.name,job_id:String(d.id),job_name:d.positionName||list.positionName,
    company_id:String(d.companyId||list.companyId||''),company_name:c.aliasName||c.name||d.companyName||list.companyName||list.aliasName||'',
    city:[d.provinceName||list.provinceName,d.cityName||list.cityName].filter(Boolean).join('-'),district:d.areaName||list.areaName||'',salary,
    experience:d.jobAgeName||list.jobAge||'',education:d.eduDegree||list.eduDegree||'',employment_type:d.category||list.category||'',
    company_nature:c.natureName||list.nature||'',company_size:c.sizeName||list.size||'',industry:c.industryName||list.industryName||'',
    source_agency:d.channelNumber||list.channelNumber||'',job_description:[text(d.description),text(d.jobRequirements)].filter(Boolean).join('\n'),
    address:d.address||list.address||'',tags:(Array.isArray(d.light||list.light)?(d.light||list.light):[d.light||list.light||'']).map(text).join(' | '),publish_time:timestamp(d.publishTime||list.publishTime),
    refresh_time:timestamp(d.updateTime||list.createTimeP),deadline:timestamp(d.expireTime),job_url:'https://www.jobonline.cn/positionDetail?id='+encodeURIComponent(d.id),
    access_level:'公开会话接口列表与详情',acquisition_mode:'browser_session_api',detail_status:d.description?'complete':'description_missing',collected_at:new Date().toISOString()};
}
// Compatibility exports accept API objects; neither reads DOM cards or details.
export function extractJobonlineCards(body){return parseJobonlineList(body).items}
export function extractJobonlineDetail(body){assertBusinessResponse(body,'就业在线');return body.object}
export async function collectJobonline(keyword,city,{checkpointPath,request={},maxPages=10,maxRows=100,maxNewRows=1000,contextFactory=openContext,yieldWindow=null,onDefer=()=>{},wait=sleep}) {
  const saved=await readCheckpoint(checkpointPath);
  const priorStop=saved.stop_reason||(unverifiedLegacyCompletion(saved)?'legacy_pagination_unverified':null);
  if(['pagination_stalled','legacy_pagination_unverified'].includes(priorStop)){
    await saveCheckpoint(checkpointPath,{...saved,completed:false,completion_reason:null,stop_reason:priorStop});
    console.warn('[分页保护] '+collectionStopMessage(priorStop)+'；保留 '+(saved.records?.length||0)+' 条记录');return saved.records||[];
  }
  if(saved.completed)return saved.records||[];
  const records=new Map((saved.records||[]).filter(r=>r.job_id).map(r=>[String(r.job_id),r]));
  const roundAllowance=Math.max(0,Math.min(1000,Number(maxNewRows)||0));
  const limit=Math.max(0,Math.min(Number(maxRows)||0,records.size+roundAllowance)),pages=Math.max(1,Math.floor(Number(maxPages)||1));
  let context,page,pageNo=Math.max(1,Number(saved.nextPageNo||saved.pageNo||1)),completed=false,total=Number(saved.total||0),lowYield=null,completionReason=null,stopReason=null,pagination=saved.pagination||{};
  const paginationHealth=new JobonlinePaginationHealth(pagination,[...records.keys()]);
  let cursor={nextPageNo:pageNo,nextCardIndex:Number(saved.nextCardIndex||0),pageSignature:saved.pageSignature||''};
  const save=(extra={})=>saveCheckpoint(checkpointPath,{records:[...records.values()],pageNo,...cursor,total,completed,completion_reason:completionReason,stop_reason:stopReason,pagination,low_yield:lowYield,acquisition_mode:'browser_session_api',...extra});
  try{
    if(records.size>=limit){await save();return [...records.values()]}
    context=await contextFactory('jobonline');page=await context.newPage();
    await gotoWithRetries(page,'https://www.jobonline.cn/findPositions?q='+encodeURIComponent(keyword),{waitUntil:'domcontentloaded',timeout:30000,attempts:3});
    await guard(page);
    await waitWebsiteClient(page,'jobonline');
    const conditions=await page.evaluate(({operation})=>{const vm=[...document.querySelectorAll('*')].map(e=>e.__vue__).find(x=>x?.condition&&Array.isArray(x.positionList));return vm?JSON.parse(JSON.stringify(vm.condition)):{}},{operation:'jobonline_conditions'});
    // This channel's configured scope is national; an old browser's city selection
    // must not silently narrow the task. Keep the site's observed filter shape.
    if(city.name==='全国')Object.assign(conditions,{areaCode:null,areaCodes:null,cityCode:null,cityCodes:null,provinceCode:null,provinceCodes:null,areaId:null});
    for(;pageNo<=pages&&records.size<limit;pageNo++){
      await wait(Math.max(1200,request.minimumIntervalMs||0));
      const parsed=parseJobonlineList(await jobonlineSessionRequest(page,JOBONLINE_LIST_PATH,{...conditions,positionName3:keyword,page:pageNo,pagesize:20}));total=parsed.total;
      if(!parsed.items.length){completed=true;completionReason='empty_page';cursor={nextPageNo:pageNo,nextCardIndex:0,pageSignature:''};break}
      const signature=JSON.stringify(parsed.items.map(x=>String(x.id))),pageIds=[];
      const start=signature===cursor.pageSignature?cursor.nextCardIndex:0;
      cursor={nextPageNo:pageNo,nextCardIndex:start,pageSignature:signature};
      for(let i=start;i<parsed.items.length&&records.size<limit;i++){
        const item=parsed.items[i];
        if(!item.id||!item.positionName){cursor.nextCardIndex=i+1;await save();continue}
        const id=String(item.id);pageIds.push(id);
        if(records.has(id)){cursor.nextCardIndex=i+1;await save();continue}
        await wait(Math.max(1200,request.minimumIntervalMs||0));
        const detail=await jobonlineSessionRequest(page,JOBONLINE_DETAIL_PATH,{positionId:id,activityCode:await page.evaluate(()=>sessionStorage.getItem('activityCode')||''),businessEnum:'POSITION_DETAIL'});
        records.set(id,normalizeJobonlineRecord(item,detail,keyword,city));cursor.nextCardIndex=i+1;await save();
      }
      console.log('jobonline '+keyword+'/'+city.name+': 接口第'+pageNo+'页，'+records.size+'条');
      if(cursor.nextCardIndex<parsed.items.length)break;
      cursor={nextPageNo:pageNo+1,nextCardIndex:0,pageSignature:''};
      pagination=paginationHealth.observe(pageNo,pageIds);
      if(pagination.stalled){stopReason='pagination_stalled';throw new ChannelError('就业在线连续5页至少60条候选均为已有岗位，已停止深分页并保留断点；不能据此认定源已采完','pagination_stalled');}
      completed=pageNo*20>=total||parsed.items.length<20;
      completionReason=completed?(parsed.items.length<20?'short_page':total>=10000?'reported_window_end':'reported_total_reached'):null;
      await save();if(completed||records.size>=limit)break;
      if(yieldWindow&&pageIds.length){const probe=yieldWindow.observe(pageIds);if(probe.defer){lowYield={...probe,at:new Date().toISOString()};await save();onDefer();console.log('[低收益切换] jobonline '+keyword+'/'+city.name+': '+yieldNote(probe));break}}
    }
    await save();return [...records.values()];
  }catch(error){error.stopChannel=error.code!=='pagination_stalled';error.partialRows=[...records.values()];completed=false;await save({error:error.message});if(page)await evidence(page,checkpointPath,error);throw error}
  finally{if(page)await page.close().catch(()=>{});if(context)await context.close()}
}



