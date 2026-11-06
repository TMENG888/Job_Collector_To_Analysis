import {fetchJobonlinePage,normalizeJobonline} from './direct_jobonline_adapter.mjs';

export const JOBONLINE_PAGINATION_CONTRACT='common-pages-v1';
export function jobonlineCheckpointCurrent(saved){return saved?.pagination_contract===JOBONLINE_PAGINATION_CONTRACT;}

export async function collectJobonlinePublicPages({request,keyword,city,saved={},maxRows=Infinity,maxPages=500,pageSize=20,onCheckpoint=async()=>{},onRows=async()=>{},onPage=()=>{},checkResources=async()=>{}}){
  const known=new Map((saved.records??saved.rows??[]).map(row=>[String(row.job_id),row]));
  const current=jobonlineCheckpointCurrent(saved)&&saved.stop_reason!=='pagination_stalled';
  const seen=new Set(current?saved.query_seen_ids||[]:[]);
  let nextPage=current?Number(saved.nextPageNo||1):1,total=current?Number(saved.total||0):0;
  let completed=current&&saved.completed===true,reason=completed?saved.completion_reason:'pending',lastPage=current?saved.lastPage||0:0;
  const persist=async()=>onCheckpoint({keyword,city,records:[...known.values()],completed,completion_reason:reason,stop_reason:reason==='pagination_stalled'?reason:null,direct_search_verified:true,pagination_contract:JOBONLINE_PAGINATION_CONTRACT,nextPageNo:nextPage,lastPage,total,query_seen_ids:[...seen],acquisition_mode:'public_json_api',collected_at:new Date().toISOString()});
  try{
    if(completed)return [...known.values()];
    while(nextPage<=maxPages){
      await checkResources();
      const page=nextPage;
      const result=await fetchJobonlinePage(request,keyword,city,{page,pageSize});
      total=Math.max(total,result.total);
      const pageIds=new Set(),fresh=[];
      let clipped=false;
      for(const raw of result.list){
        if(city.code&&raw.cityCode!=null&&String(raw.cityCode)!==String(city.code))throw Object.assign(Error('就业在线返回城市与查询不一致，已停止保存'),{code:'api_schema_changed',stopChannel:true});
        const row=normalizeJobonline(raw,keyword,city.name);
        row.source_total=result.total;
        pageIds.add(row.job_id);
        if(!known.has(row.job_id)&&known.size>=maxRows){clipped=true;continue;}
        const previous=known.get(row.job_id)||{};
        const merged={...previous,...row};
        if(String(previous.job_description||'').length>row.job_description.length){merged.job_description=previous.job_description;merged.detail_status=previous.detail_status||merged.detail_status;}
        known.set(row.job_id,merged);fresh.push(merged);
      }
      const newIds=[...pageIds].filter(id=>!seen.has(id));
      for(const row of fresh)seen.add(row.job_id);
      if(!clipped){lastPage=page;nextPage=page+1;}
      completed=!clipped&&seen.size>=total&&(result.list.length<pageSize||page*pageSize>=total);
      reason=completed?(total>=10000?'reported_window_end':'query_finished'):clipped?'row_limit':result.list.length===0||newIds.length===0||page*pageSize>=total?'pagination_stalled':'pending';
      await persist();
      await onRows(fresh);
      onPage({page,total,seen:seen.size,retained:known.size,completed});
      if(completed||clipped)break;
      if(reason==='pagination_stalled')throw Object.assign(Error('就业在线分页未返回新岗位，尚未采完，已保留断点'),{code:'pagination_stalled',stopChannel:false,conditionScoped:true});
    }
    if(!completed&&reason==='pending'){reason='page_limit';await persist();}
    return [...known.values()];
  }catch(error){error.partialRows=[...known.values()];throw error;}
}
