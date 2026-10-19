// Endpoints verified against the official desktop bundle and live responses.
// Rate limits, retries, checkpoints and task ownership remain caller controlled.
export const PUBLIC_API_EVIDENCE = Object.freeze({
  shixiseng: { transport: 'json-api', list: 'https://www.shixiseng.com/app/interns/search/v2', detail: 'https://www.shixiseng.com/proxy-prefix/new-intern-api-host/api/interns/v3.0/interns/info/wxz', source: 'https://sxsimg.xiaoyuanzhao.com/static_sxs/dist/desktop/dist/client/97f082f.js' },
  mohrss: { transport: 'server_data', list: 'http://job.mohrss.gov.cn/cjobs/jobinfolist/listJobinfolist', source: 'The official GET form submits pageNo; records are the JSON-valued findjoblist input.', limitation: 'No standalone recruitment JSON endpoint observed in the list page and its linked scripts. This adapter reports SSR explicitly.' },
});

function stop(message, code='api_schema_changed') { return Object.assign(new Error(message), { code, stopChannel:true }); }
function requirePage(page) { if(!Number.isSafeInteger(page)||page<1)throw new TypeError('page must be a positive integer'); }
function cityName(city) { return typeof city==='string'?city:city?.name||'全国'; }
function assertResponse(response, body, {hasExpectedData=false}={}) {
  if([401,403,429].includes(response.status))throw stop(`接口需要登录、验证或已限流（HTTP ${response.status}）；保存断点后停止`, 'verification_required');
  if(response.ok===false)throw stop(`数据接口 HTTP ${response.status}`, 'api_http_error');
  if(!hasExpectedData&&/^\s*</.test(body)&&/验证码|安全验证|访问过于频繁|verify|captcha|challenge/i.test(body))throw stop('接口出现验证页面；保存断点后停止', 'verification_required');
}
async function fetchJson(request, url) {
  const response=await request(url,{headers:{accept:'application/json',referer:'https://www.shixiseng.com/'}});
  const text=await response.text();assertResponse(response,text);
  let data;try{data=JSON.parse(text);}catch{throw stop('实习僧接口未返回有效 JSON；不回退到页面采集');}
  if([101,401,403,429].includes(Number(data.code)))throw stop(`实习僧接口要求登录或验证（code ${data.code}）`, 'verification_required');
  if(Number(data.code)!==100)throw stop(`实习僧接口业务失败（code ${data.code??'missing'}）`, 'api_business_error');
  return data;
}
export async function fetchShixisengList({request,keyword,city='全国',page=1,type='intern'}) {
  requirePage(page);
  const url=new URL(PUBLIC_API_EVIDENCE.shixiseng.list);
  url.search=new URLSearchParams({page:String(page),keyword:String(keyword??''),city:cityName(city),type});
  const raw=await fetchJson(request,url.href), data=raw.msg;
  if(!data||!Array.isArray(data.data)||data.data.some(row=>!row||typeof row!=='object'||!row.uuid))throw stop('实习僧列表字段变化，保存断点后停止');
  const total=Number(data.total),pageSize=Number(data.pageNumber);
  if(!Number.isFinite(total)||total<0||!Number.isFinite(pageSize)||pageSize<1)throw stop('实习僧分页字段变化，保存断点后停止');
  return {records:data.data,data:data.data,total,page,pageSize,pageNumber:pageSize,totalPages:Math.ceil(total/pageSize),transport:'json-api',url:url.href,raw};
}
export async function fetchShixisengDetail({request,uuid}) {
  if(!/^inn_[A-Za-z0-9]+$/.test(String(uuid)))throw new TypeError('Invalid shixiseng uuid');
  const url=new URL(PUBLIC_API_EVIDENCE.shixiseng.detail);url.search=new URLSearchParams({uuid:String(uuid)});
  const raw=await fetchJson(request,url.href),data=raw.msg;
  if(!data||typeof data!=='object'||Array.isArray(data)||!Object.keys(data).length||!(data.iname||data.info||data.job))throw stop('实习僧详情为空或结构变化；保留待续采');
  return {data,transport:'json-api',url:url.href,raw};
}
export function decodeHtmlAttribute(value) {
  const entities={quot:'"',apos:"'",lt:'<',gt:'>',amp:'&',nbsp:' '};
  return String(value).replace(/&(#x[0-9a-f]+|#\d+|quot|apos|lt|gt|amp|nbsp);/gi,(literal,name)=>{
    if(name[0]!=='#')return entities[name.toLowerCase()]??literal;
    const number=name[1].toLowerCase()==='x'?parseInt(name.slice(2),16):Number(name.slice(1));
    return number>=0&&number<=0x10ffff?String.fromCodePoint(number):literal;
  });
}
function inputValues(html) {
  const values=new Map();
  for(const input of html.matchAll(/<input\b[^>]*>/gi)) {
    const attrs={};for(const attr of input[0].matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))attrs[attr[1].toLowerCase()]=decodeHtmlAttribute(attr[2]??attr[3]);
    if(attrs.id)values.set(attrs.id,attrs.value??'');
  }
  return values;
}
export function parseMohrssDataPage(html) {
  const values=inputValues(html);
  if(!values.has('findjoblist'))throw stop('公共招聘网未返回 findjoblist；公开数据边界已变化');
  let records;try{records=JSON.parse(values.get('findjoblist'));}catch{throw stop('公共招聘网 findjoblist 不是有效 JSON');}
  if(!Array.isArray(records)||records.some(row=>!row||typeof row!=='object'||row.acb200==null))throw stop('公共招聘网岗位数据结构变化');
  const numeric=name=>{if(!/^\d+$/.test(values.get(name)||''))throw stop(`公共招聘网缺失分页字段 ${name}`);return Number(values.get(name));};
  const page=numeric('pageNo'),totalPages=numeric('totalpages'),total=numeric('totalcount');
  if(page<1||(totalPages===0&&records.length))throw stop('公共招聘网分页状态异常');
  return {records,total,page,totalPages,transport:'server_data',limitation:PUBLIC_API_EVIDENCE.mohrss.limitation};
}
export async function fetchMohrssList({request,keyword,page=1,city='全国',areaCode=''}) {
  requirePage(page);
  // AREA is the official area selector code. Never guess codes from names.
  // If no code is configured, the caller may apply its existing city filter.
  const params={textfield:String(keyword??''),pageNo:String(page),AREA:String(areaCode),AREA_name:areaCode&&cityName(city)!=='全国'?cityName(city):'',ACA111:'',ACA111_name:'',workType:'',workTypeName:'',acb332:''};
  const url=new URL(PUBLIC_API_EVIDENCE.mohrss.list);url.search=new URLSearchParams(params);
  const response=await request(url.href);const html=await response.text();
  // A valid job description may itself mention verification work. Only treat
  // challenge text as a challenge when the official data input is absent.
  assertResponse(response,html,{hasExpectedData:inputValues(html).has('findjoblist')});
  const data=parseMohrssDataPage(html);
  if(data.page!==page)throw stop('公共招聘网未返回所请求的页码；保存断点后停止，避免重复第一页');
  return {...data,url:url.href};
}
