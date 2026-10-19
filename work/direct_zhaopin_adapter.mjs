import {parseZhaopinApi,zhaopinJobId} from './zhaopin_api.mjs';

export const ZHAOPIN_DIRECT_ENDPOINT='https://fe-api.zhaopin.com/c/i/search/positions';
const fail=(message,code='invalid_response')=>Object.assign(Error(`智联直连接口：${message}`),{code,stopChannel:true});
const text=value=>String(value??'').replace(/<br\s*\/?\s*>/gi,'\n').replace(/<\/(?:p|li|div)>/gi,'\n').replace(/<[^>]+>/g,' ').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&quot;/gi,'"').replace(/[ \t]+\n/g,'\n').trim();
const array=value=>Array.isArray(value)?value:[];
const joined=values=>[...new Set(values.map(text).filter(Boolean))].join(' | ');
const safeURL=value=>{try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&(url.hostname==='zhaopin.com'||url.hostname.endsWith('.zhaopin.com'))?url.href:'';}catch{return '';}};

// Only ordinary search fields observed in a successful unauthenticated request.
// Never copy browser cookies, archived tokens, signatures or fingerprint values.
export function directZhaopinRequest(keyword,city,pageIndex,pageSize=20){
  if(typeof keyword!=='string'||!keyword.trim()||!city?.name||!/^\d{1,8}$/.test(String(city.code)))throw fail('搜索关键词或城市代码无效','invalid_config');
  if(!Number.isSafeInteger(pageIndex)||pageIndex<1||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>20)throw fail('分页参数无效','invalid_config');
  return {url:ZHAOPIN_DIRECT_ENDPOINT,options:{method:'POST',headers:{'content-type':'application/json','user-agent':'JobMarketResearch/1.0'},body:JSON.stringify({S_SOU_FULL_INDEX:keyword.trim(),S_SOU_WORK_CITY:String(city.code),pageIndex,pageSize,order:0,platform:13,version:'0.0.0'})}};
}

export async function fetchDirectZhaopinPage(request,keyword,city,pageIndex,pageSize=20){
  const contract=directZhaopinRequest(keyword,city,pageIndex,pageSize),response=await request(contract.url,contract.options);
  const status=typeof response.status==='function'?response.status():response.status;
  if([401,403,429].includes(status))throw fail(`HTTP ${status}，已停止，不重放凭据`,'access_blocked');
  if(status!==200)throw fail(`HTTP ${status}`,'http_error');
  let body;try{body=JSON.parse(await response.text());}catch{throw fail('响应不是有效岗位 JSON，不执行页面或脚本','verification_required');}
  const parsed=parseZhaopinApi(body,status);
  if(body.code==null||body.data?.statusCode==null||!Number.isSafeInteger(parsed.total))throw fail('缺少已核验的业务状态或有效岗位总数');
  if(parsed.rows.some(row=>!zhaopinJobId(row)||!String(row.name??'').trim()))throw fail('岗位缺少稳定 ID 或标题');
  return parsed;
}

export function normalizeDirectZhaopin(row,keyword,cityName,total,collectedAt=new Date().toISOString(),acquisitionMode='public_json_api'){
  const detail=row.jobDetailData?.position||{},staff=row.jobDetailData?.staff||row.staffCard||{},location=detail.workLocation||{};
  const description=text(detail.desc?.description||row.jobDescription||'');
  return {platform:'智联招聘',query_keyword:keyword,query_city:cityName,job_id:zhaopinJobId(row),job_name:text(row.name),company_id:String(row.companyNumber??''),company_name:text(row.companyName),
    salary:text(row.salary60||row.salaryReal),city:text(row.workCity),district:text(row.cityDistrict),experience:text(row.workingExp),education:text(row.education),employment_type:text(row.workType),
    company_nature:text(row.propertyName||row.property),company_size:text(row.companySize),industry:text(row.industryName),publish_time:text(row.publishTime),refresh_time:text(detail.date?.positionUpdateTime||detail.date?.positionUpdateTimeText),deadline:text(detail.date?.dateEnd),
    tags:joined([...array(row.showSkillTags).map(item=>item?.tag),...array(row.welfareLabel).map(item=>item?.value||item?.name||item),...array(row.commercialLabel).map(item=>item?.typeName)]),
    skills:joined([...array(row.jobSkillTags).map(item=>item?.tagName||item?.name||item?.value||item),...array(row.skillLabel).map(item=>item?.value||item?.name||item),...array(row.jobKeyword?.keywords).map(item=>item?.itemValue)]),
    job_description:description,address:text(location.workAddress||location.address),recruiter_name:text(staff.staffName),recruiter_title:text(staff.hrJob),job_url:safeURL(row.positionUrl||row.positionURL),company_url:safeURL(row.companyUrl),source_total:total,
    acquisition_mode:acquisitionMode,detail_status:description.length>=20?'complete':'list_only',access_level:acquisitionMode==='public_json_api'?'独立 HTTP JSON 岗位搜索接口；不使用浏览器或登录凭据':'保留任务归属已核验的历史浏览器接口记录',collected_at:collectedAt};
}
