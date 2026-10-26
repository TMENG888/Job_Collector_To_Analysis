// Search expansion only discovers candidates; it never decides target labels.
export const MOHRSS_RELATED_POLICY='empty-smart-agent-v1';
export function mohrssRelatedKeywords(keyword,settings={}) {
  const value=String(keyword||'').trim();
  return settings.relatedSearch===false||!value.includes('智能体')||value==='智能体'?[]:['智能体'];
}
export function mohrssConsumedPages(saved={}) {
  return Number((saved.original_search||saved).lastPage||0)+(saved.supplemental_search?.searches||[]).reduce((n,search)=>n+Number(search.lastPage||0),0);
}
export function mohrssCheckpointNeedsContinuation(saved,{keyword,city,settings={},taskId}={}) {
  if(!saved||!saved.completed)return false;
  if(taskId!==undefined&&(saved.task_id??null)!==(taskId??null))return false;
  if(saved.keyword!=null&&saved.keyword!==keyword||saved.city?.name&&saved.city.name!==city?.name)return false;
  const original=saved.original_search||saved;
  if(Number(original.total)!==0||!original.completed)return false;
  const consumed=mohrssConsumedPages(saved);
  if(consumed>=bound(settings.maxPages))return false;
  if((saved.records||[]).length>=bound(settings.maxRows))return false;
  const keywords=mohrssRelatedKeywords(keyword,settings);
  return keywords.some(value=>!saved.supplemental_search?.searches?.some(search=>search.keyword===value&&search.completed));
}
const bound=value=>Number.isFinite(Number(value))&&Number(value)>0?Math.max(1,Math.floor(Number(value))):Infinity;
function invalid(message,code='api_schema_changed'){return Object.assign(new Error(message),{code,stopChannel:true});}
function validateSearch(search) {
  if(search.records!=null&&(!Array.isArray(search.records)||search.records.some(row=>!row||typeof row!=='object'||row.acb200==null)))throw invalid('公共招聘网断点 records 结构异常');
  if(search.lastPage!=null&&(!Number.isSafeInteger(Number(search.lastPage))||Number(search.lastPage)<0))throw invalid('公共招聘网断点页码无效');
  for(const name of ['total','totalPages'])if(search[name]!=null&&(!Number.isFinite(Number(search[name]))||Number(search[name])<0))throw invalid('公共招聘网断点分页总量无效');
}
export async function collectMohrssCandidates({keyword,city,settings={},taskId=null,saved={},fetchPage,persist,onEvent=()=>{}}) {
  if(Object.keys(saved).length&&(saved.task_id??null)!==taskId)throw invalid('公共招聘网断点任务 ID 不匹配','TASK_OUTPUT_OWNERSHIP');
  if(saved.keyword!=null&&saved.keyword!==keyword||saved.city?.name&&saved.city.name!==city.name)throw invalid('公共招聘网断点查询条件不匹配','TASK_OUTPUT_OWNERSHIP');
  if(saved.original_search?.keyword!=null&&saved.original_search.keyword!==keyword||saved.supplemental_search?.original_keyword!=null&&saved.supplemental_search.original_keyword!==keyword)throw invalid('公共招聘网子搜索断点条件不匹配','TASK_OUTPUT_OWNERSHIP');
  validateSearch(saved);
  const pageLimit=bound(settings.maxPages),rowLimit=bound(settings.maxRows);
  const eligible=row=>city.name==='全国'||`${row.aab302||''} ${row.area_||''} ${row.acb202||''}`.includes(city.name);
  const original={...(saved.original_search||saved),keyword,records:[...(saved.original_search?.records||saved.records||[])]};
  delete original.original_search;delete original.supplemental_search;
  validateSearch(original);
  const related=[];
  for(const previous of saved.supplemental_search?.searches||[]) {
    // Turning expansion off stops new requests, not already collected evidence.
    if(!mohrssRelatedKeywords(keyword,{...settings,relatedSearch:true}).includes(previous.keyword))continue;
    validateSearch(previous);related.push({...previous,records:[...(previous.records||[])]});
  }
  const searches=[original,...related];
  let limitReason=null;
  const knownIds=new Set(searches.flatMap(search=>(search.records||[]).filter(eligible).map(row=>String(row.acb200))));
  const allRows=()=>[...new Map(searches.flatMap(search=>(search.records||[]).filter(eligible).map(row=>[String(row.acb200),{...row,_mohrss_search_keyword:search.keyword,_mohrss_expanded:search!==original,_mohrss_source_total:Number(search.total)||0}]))).values()];
  const mayExpand=()=>original.completed&&Number(original.total)===0;
  const ensureRelated=()=>{if(mayExpand())for(const value of mohrssRelatedKeywords(keyword,settings))if(!searches.some(search=>search.keyword===value))searches.push({keyword:value,records:[],lastPage:0,total:0,totalPages:0,completed:false});};
  ensureRelated();
  const done=()=>Boolean(original.completed)&&searches.slice(1).every(s=>Boolean(s.completed)||settings.relatedSearch===false);
  const snapshot=()=>({task_id:taskId,keyword,city,total:searches.reduce((n,s)=>n+(Number(s.total)||0),0),totalPages:searches.reduce((n,s)=>n+(Number(s.totalPages)||0),0),lastPage:Number(original.lastPage)||0,completed:done(),records:allRows(),original_search:{keyword,total:Number(original.total)||0,totalPages:Number(original.totalPages)||0,lastPage:Number(original.lastPage)||0,completed:Boolean(original.completed),records:original.records},supplemental_search:{version:1,policy:MOHRSS_RELATED_POLICY,original_keyword:keyword,searches:searches.slice(1)},limit_reason:limitReason,migrated:Boolean(saved.migrated),acquisition_mode:'server_embedded_json'});
  const save=()=>persist(snapshot());
  const consumedPages=()=>searches.reduce((n,s)=>n+(Number(s.lastPage)||0),0);
  try {
    for(let index=0;index<searches.length;index++) {
      const search=searches[index];
      if(index>0&&settings.relatedSearch===false)break;
      if(index>0&&!search.completed)onEvent({type:'related_search',originalKeyword:keyword,keyword:search.keyword,city:city.name,policy:MOHRSS_RELATED_POLICY,candidateOnly:true});
      const records=new Map((search.records||[]).filter(eligible).map(row=>[String(row.acb200),row]));
      search.records=[...records.values()];
      while(!search.completed&&consumedPages()<pageLimit&&(knownIds.size<rowLimit||!Number(search.lastPage))) {
        const page=(Number(search.lastPage)||0)+1;
        const result=await fetchPage({keyword:search.keyword,city,page,areaCode:settings.areaCode||city.areaCode||''});
        if(!result||!Array.isArray(result.records)||!Number.isFinite(Number(result.total))||!Number.isSafeInteger(Number(result.totalPages))||Number(result.total)<0||Number(result.totalPages)<0||result.records.some(row=>!row||row.acb200==null))throw invalid('公共招聘网响应分页结构异常');
        if(result.records.length===0&&result.total>0&&page<=result.totalPages)throw invalid('公共招聘网非空结果中出现空分页；保留断点停止');
        search.total=Number(result.total);search.totalPages=Number(result.totalPages);
        let truncated=false;
        for(const row of result.records) {
          if(!eligible(row))continue;
          const id=String(row.acb200);
          if(!knownIds.has(id)&&knownIds.size>=rowLimit){truncated=true;break;}
          records.set(id,row);knownIds.add(id);
        }
        search.records=[...records.values()];
        if(!truncated)search.lastPage=page;
        search.completed=!truncated&&(search.totalPages===0||Number(search.lastPage)>=search.totalPages);
        ensureRelated();
        limitReason=truncated||knownIds.size>=rowLimit&&!search.completed?'max_rows':consumedPages()>=pageLimit&&!done()?'max_pages':null;
        await save();
        onEvent({type:'page',keyword:search.keyword,city:city.name,page,totalPages:search.totalPages,records:knownIds.size,total:search.total});
        if(truncated||knownIds.size>=rowLimit)break;
      }
      if(!search.completed)break;
    }
    if(!done()&&!limitReason)limitReason=knownIds.size>=rowLimit?'max_rows':consumedPages()>=pageLimit?'max_pages':null;
    await save();return snapshot();
  }catch(error){error.partialMohrssSnapshot=snapshot();try{await save();}catch(saveError){error.checkpointError=String(saveError.message||saveError);}throw error;}
}
