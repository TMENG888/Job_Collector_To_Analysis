export const JOBONLINE_DETAIL_ENDPOINT='https://api.jobonline.cn/jobtbao-platform-srv/v1/platform/unsafe/position/getPositionDetail?target=POSITION_DETAIL';
const fail=(message,code='invalid_response',stopChannel=true)=>Object.assign(Error(`就业在线：${message}`),{code,stopChannel});
const plain=value=>String(value??'').replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/gi,'').replace(/<(?:br\s*\/?|\/p|\/div|\/li)>/gi,'\n').replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;/gi,' ').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&amp;/gi,'&').replace(/[ \t]+/g,' ').replace(/ *\n */g,'\n').replace(/\n{3,}/g,'\n\n').trim();
export function hasJobonlineDetail(row){return ['detail_success','complete','成功'].includes(row?.detail_status)&&Boolean(String(row.job_description||'').trim());}
export function jobonlineDetailSettled(row){return hasJobonlineDetail(row)||row?.detail_status==='job_unavailable';}
export function mergeJobonlineRows(previous={},next={}){
  const result={...previous,...next};
  if(hasJobonlineDetail(previous)&&!hasJobonlineDetail(next)){
    for(const key of ['job_description','job_duties','job_requirements','detail_status','detail_checked_at','detail_result'])if(previous[key]!=null)result[key]=previous[key];
  }else if(String(previous.job_description||'').length>String(next.job_description||'').length)result.job_description=previous.job_description;
  return result;
}
export function normalizeJobonlineDetail(row,body,{now=()=>new Date().toISOString()}={}){
  const code=String(body?.code??'');
  if(['10002','10004','401'].includes(code))throw fail('详情请求登录已失效','session_required');
  if(['403','429'].includes(code))throw fail('详情请求需要人工验证或触发限流','verification_required');
  if(code!=='200'){
    if(/(?:职位|岗位).{0,8}(?:已下架|已删除|不存在|已过期)|(?:已下架|已删除|不存在).{0,8}(?:职位|岗位)/.test(String(body?.message||body?.msg||'')))throw fail('岗位已下架或不存在','job_unavailable',false);
    throw fail(`详情接口业务状态异常（${code||'missing'}）`);
  }
  const detail=body.object;
  if(!detail||typeof detail!=='object'||Array.isArray(detail)||detail.id==null||typeof detail.id==='number'&&!Number.isSafeInteger(detail.id)||String(detail.id)!==String(row.job_id))throw fail('详情 ID 或响应结构与当前岗位不一致','api_schema_changed');
  const duties=plain(detail.description),requirements=plain(detail.jobRequirements);
  const description=[duties,requirements&&!duties.includes(requirements)?requirements:''].filter(Boolean).join('\n\n');
  const at=now(),company=detail.companyBean||{},success=Boolean(description);
  const result={...row,job_duties:duties,job_requirements:requirements,job_description:description||row.job_description||'',detail_status:success?'detail_success':'detail_empty',detail_checked_at:at,detail_result:{status:success?'success':'empty',checked_at:at},acquisition_mode:'session_client_api',access_level:'就业在线本人登录会话列表与详情接口',collected_at:at};
  const updates={job_name:detail.positionName,company_id:detail.companyId,company_name:detail.companyName||company.aliasName||company.name,city:detail.cityName,district:detail.areaName,address:detail.address,experience:detail.jobAgeName,education:detail.eduDegree,employment_type:detail.category,industry:company.industryName,company_nature:company.natureName,company_size:company.sizeName};
  for(const [key,value]of Object.entries(updates))if(value!=null&&String(value).trim())result[key]=plain(value);
  if(detail.negotiable===true||detail.negotiable===1||Number(detail.salaryRange)===70||Number(detail.lowSalary)<0||Number(detail.highSalary)<0)result.salary='面议';
  else if(detail.lowSalary!=null&&detail.highSalary!=null){
    const range=[detail.lowSalary,detail.highSalary].map(plain).join('-'),unit=plain(detail.salaryUnitName);
    result.salary=range+(/\/(?:月|年|日|时|天)/.test(range)?'':/元/.test(range)?unit.includes('/')?'/'+unit.split('/').at(-1):'':unit);
  }
  return mergeJobonlineRows(row,result);
}
