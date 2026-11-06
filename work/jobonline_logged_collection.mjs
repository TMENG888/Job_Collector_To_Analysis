import {normalizeJobonline} from './direct_jobonline_adapter.mjs';
import {normalizeJobonlineDetail,jobonlineDetailSettled,mergeJobonlineRows,hasJobonlineDetail} from './jobonline_details.mjs';
import {collectionExitCode} from './collection_policy.mjs';

export async function collectJobonlineLoggedWindow({keyword,city,saved={},retained=[],maxRows=Infinity,collectWindow,collectDetail,detailCache=new Map(),onCheckpoint=async()=>{},onRows=async()=>{},checkResources=async()=>{},onFlow=()=>{},now=()=>new Date().toISOString()}){
  const known=new Map();
  for(const row of [...retained,...(saved.records||[])])known.set(String(row.job_id),mergeJobonlineRows(known.get(String(row.job_id)),row));
  let listComplete=Boolean(saved.logged_window_verified&&(saved.list_complete??saved.completed)),clipped=Boolean(saved.completion_reason==='row_limit');
  let searchCount=saved.search_count||0,moreCount=saved.more_count||0,returnedCount=saved.returned_count||0,currentUnique=saved.current_unique||0;
  const dirty=new Map();
  for(const [id,row]of known)if(jobonlineDetailSettled(row))dirty.set(id,row);
  const persist=async()=>{
    const rows=[...known.values()],successful=rows.filter(hasJobonlineDetail).length,unavailable=rows.filter(row=>row.detail_status==='job_unavailable').length;
    const pending=rows.length-successful-unavailable,detailsComplete=Boolean(collectDetail)&&pending===0;
    await onCheckpoint({keyword,city,records:rows,list_complete:listComplete,details_enabled:Boolean(collectDetail),details_complete:detailsComplete,details:{successful,unavailable,pending},completed:listComplete&&(!collectDetail||detailsComplete),completion_reason:clipped?'row_limit':collectDetail&&!detailsComplete?'details_pending':'query_finished',completion_scope:'logged_website_window',logged_window_verified:listComplete,search_count:searchCount,more_count:moreCount,returned_count:returnedCount,current_unique:currentUnique,acquisition_mode:'session_client_api',collected_at:now()});
    if(dirty.size){await onRows([...dirty.values()]);dirty.clear();}
  };
  try{
    if(listComplete&&dirty.size)await persist();
    if(!listComplete){
      const result=await collectWindow(keyword,city);clipped=false;
      searchCount=result.searchCount;moreCount=result.moreCount;returnedCount=result.returnedCount;currentUnique=result.list.length;
      for(const raw of result.list){
        const row=normalizeJobonline(raw,keyword,city.name);
        if(!known.has(row.job_id)&&known.size>=maxRows){clipped=true;continue;}
        const merged=mergeJobonlineRows(known.get(row.job_id),{...row,acquisition_mode:'session_client_api',access_level:'就业在线本人登录会话搜索响应',website_list:raw.website_list||'searchList',source_total:result.returnedCount});
        known.set(row.job_id,merged);dirty.set(row.job_id,merged);
      }
      listComplete=!clipped;
      await persist();
    }
    if(collectDetail){
      onFlow({stage:'details_started'});
      for(const [id,row]of known){
        if(jobonlineDetailSettled(row))continue;
        await checkResources();
        let next;
        const cached=detailCache.get(id);
        if(cached&&jobonlineDetailSettled(cached))next={...mergeJobonlineRows(row,cached),query_keyword:row.query_keyword,query_city:row.query_city};
        else{
          try{next=normalizeJobonlineDetail(row,await collectDetail(row),{now});}
          catch(error){
            if(error.stopChannel||['TASK_OUTPUT_OWNERSHIP','RESOURCE_PRESSURE'].includes(error.code)||collectionExitCode(error)===42)throw error;
            const unavailable=error.code==='job_unavailable';
            next={...row,detail_status:unavailable?'job_unavailable':'detail_failed',detail_checked_at:now(),detail_result:{status:unavailable?'unavailable':'failed',code:error.code||'collection_error',checked_at:now()}};
          }
        }
        known.set(id,next);dirty.set(id,next);
        if(jobonlineDetailSettled(next))detailCache.set(id,next);
        await persist();
      }
      onFlow({stage:'details_finished'});
    }
    await persist();
    if(collectDetail&&[...known.values()].some(row=>!jobonlineDetailSettled(row)))throw Object.assign(Error('就业在线部分岗位详情为空或失败，已保存列表和成功正文，待续补；不判定详情采集完成'),{code:'details_incomplete',conditionScoped:true,stopChannel:false});
    return [...known.values()];
  }catch(error){
    if(collectionExitCode(error)!==42)try{await persist();}catch(storageError){storageError.cause??=error;storageError.partialRows=[...known.values()];throw storageError;}
    error.partialRows=[...known.values()];throw error;
  }
}
