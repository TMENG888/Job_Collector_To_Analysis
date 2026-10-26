// Accept only a successful search performed by the real website. Never invent
// ckId, solve verification, copy unrelated browser profiles or log credentials.
export const LIEPIN_SEARCH_ENDPOINT='https://api-c.liepin.com/api/com.liepin.searchfront4c.pc-search-job';
export const LIEPIN_SESSION_HEADERS=['accept','accept-language','content-type','origin','referer','user-agent','cookie','x-client-type','x-fscp-version','x-fscp-fe-version','x-fscp-std-info','x-fscp-bi-stat','x-requested-with','x-xsrf-token'];
const reject=message=>Object.assign(Error('猎聘：'+message),{code:'session_required',stopChannel:true});
export function createObservedLiepinTemplate({url,status,requestBody,headers,response,now=Date.now()}){
  if(url!==LIEPIN_SEARCH_ENDPOINT||status!==200||Number(response?.flag)!==1||!Array.isArray(response?.data?.data?.jobCardList))throw reject('只接受官网成功搜索的会话，不保存失败或验证请求');
  const body=typeof requestBody==='string'?JSON.parse(requestBody):structuredClone(requestBody);
  if(JSON.stringify(body).length>32768)throw reject('搜索请求模板过大');
  const form=body?.data?.mainSearchPcConditionForm,pass=body?.data?.passThroughForm;
  if(!form||typeof form.key!=='string'||!Number.isSafeInteger(form.currentPage)||!pass||typeof pass.ckId!=='string'||!pass.ckId.trim())throw reject('官网搜索模板不完整，请重新进行一次正常搜索');
  const captured={};for(const name of LIEPIN_SESSION_HEADERS){const value=headers?.[name];if(typeof value==='string'&&value&&!/[\r\n]/.test(value))captured[name]=value;}
  if(!captured.cookie||!captured['user-agent'])throw reject('成功请求未包含完整会话信息');
  return {version:2,validated:true,saved_at:new Date(now).toISOString(),expires_at:Math.floor(now/1000)+1800,cookie:captured.cookie,xsrf:captured['x-xsrf-token']||'',ckId:pass.ckId,headers:captured,request_body:body,captured_request:{url:LIEPIN_SEARCH_ENDPOINT,successful:true}};
}
