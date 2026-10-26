// Derive a small, credential-free view model from task-owned snapshots only.
// An overall running task does not prove that every channel is still running.
const runningStages = new Set(['collection','public','zhaopin','yupao','boss']);
const policies = {
  cookie_expired: ['manual','Cookie 已失效','请在官网更新会话后再续采'],
  session_expired: ['manual','会话已过期','请在官网更新会话后再续采'],
  auth_required: ['manual','需要认证','接口返回未认证，请在官网核对登录状态'],
  login_required: ['manual','需要登录','请在官网完成登录'],
  rate_limited: ['paused','触发限流','渠道已暂停，请等待冷却后人工续采'],
  dependency_missing: ['failed','缺少运行依赖','请修复本机运行依赖后再续采'],
  verification_required: ['manual','待人工验证','请在官网核对会话或验证状态'],
  session_required: ['manual','待更新会话','请在官网完成登录并保存有效会话'],
  navigation_error: ['manual','待检查官网','官网页面未返回可核验搜索响应'],
  origin_cooldown: ['paused','渠道冷却中','请稍后人工检查登录、验证或限流状态'],
  access_blocked: ['manual','访问受限','已停止请求，请人工核对'],
  api_schema_changed: ['failed','接口结构变化','需要更新适配器；已停止该渠道，不把异常当作空结果'],
  invalid_response: ['failed','响应校验失败','接口未返回可核验数据；请检查接口或官网状态'],
  invalid_config: ['failed','配置有误','请检查该渠道关键词、城市及采集配置'],
  http_error: ['failed','接口请求失败','接口返回异常 HTTP 状态；请检查渠道服务'],
  api_business_error: ['failed','接口业务异常','接口业务状态异常；不据此断言 Cookie 失效'],
  network_timeout: ['failed','请求超时','未在限定时间内收到响应；请检查网络或渠道服务'],
  network_error: ['failed','网络连接异常','连接失败、断开或域名解析异常；请检查网络后再续采'],
  request_cancelled: ['paused','请求已取消','请求被取消；保留已保存数据与断点'],
  response_too_large: ['paused','响应超出保护上限','为保护内存已停止该渠道；请检查响应体或调整配置'],
  pagination_stalled: ['paused','分页停滞','检测到分页重复；保留断点，不认定来源已采完'],
  empty_unverified: ['manual','空结果待核实','页面没有岗位，但缺少已核验的分页证据；请在官网核对'],
  legacy_pagination_unverified: ['paused','完成标记待核验','旧分页完成标记缺少证据；保留断点'],
  layout_changed: ['failed','页面结构变化','现有适配器无法识别岗位；需要更新适配器'],
  DIRECT_HTTP_REQUIRED: ['paused','渠道适配待更新','当前没有可用的已核验接口；不自动切换到模拟浏览器'],
  disk_full: ['paused','磁盘空间不足','写入已受阻；请释放输出盘空间后再续采'],
  output_locked: ['paused','数据写入受阻','输出文件被占用或受保护；请检查权限及文件占用'],
  output_error: ['failed','数据读写异常','本机文件或数据库读写失败；请检查存储状态'],
  request_budget: ['paused','已达本轮上限','保留断点；调整本轮上限后可继续'],
  RESOURCE_PRESSURE: ['paused','资源保护暂停','保留数据与断点'],
  TASK_OUTPUT_OWNERSHIP: ['failed','数据归属不符','输出或断点不属于当前任务；已拒绝混入数据'],
  collection_error: ['failed','采集异常','原因尚未确定；请查看本机执行日志，不自动重试'],
};
function normalizedErrorCode(error) {
  const message=String(error?.error||error?.message||'');
  const codes=[error?.code,error?.cause?.code,error?.cause?.cause?.code];
  if(codes.includes('ENOSPC'))return 'disk_full';
  if(codes.some(code=>['OUTPUT_LOCKED','EACCES','EPERM','EBUSY','EROFS','SQLITE_BUSY','SQLITE_LOCKED'].includes(code)))return 'output_locked';
  if(codes.some(code=>['EIO','ENOENT','SQLITE_IOERR','SQLITE_CORRUPT'].includes(code)))return 'output_error';
  if(['cookie_expired','invalid_cookie','COOKIE_EXPIRED'].includes(error?.code))return 'cookie_expired';
  if(['session_expired','SESSION_EXPIRED','invalid_session'].includes(error?.code))return 'session_expired';
  if(['client_unavailable','session_missing'].includes(error?.code))return 'session_required';
  if(['unauthorized','auth_expired','AUTH_REQUIRED'].includes(error?.code)||Number(error?.status??error?.statusCode)===401||/\bHTTP[\s:_-]*401\b/i.test(message))return 'auth_required';
  if(['rate_limited','too_many_requests','HTTP_429'].includes(error?.code)||Number(error?.status??error?.statusCode)===429||/\bHTTP[\s:_-]*429\b/i.test(message))return 'rate_limited';
  if(Number(error?.status??error?.statusCode)===403||/\bHTTP[\s:_-]*403\b/i.test(message))return 'access_blocked';
  if(/(?:cookie[^\n]{0,30}(?:expired|invalid|失效|过期)|(?:expired|invalid)[ _-]*cookie)/i.test(message))return 'cookie_expired';
  if(['USER_ACTION_REQUIRED','BOSS_USER_ACTION'].includes(error?.code))return 'verification_required';
  if(['invalid_json','nowcoder_contract'].includes(error?.code))return 'invalid_response';
  if(error?.code==='api_http_error')return 'http_error';
  if(error?.code==='page_business_error')return 'api_business_error';
  if(codes.some(code=>['ETIMEDOUT','ESOCKETTIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT'].includes(code))||error?.name==='TimeoutError'||/\b(?:TimeoutError|ETIMEDOUT|UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT)\b|\btimeout\s+\d+\s*ms\s+exceeded/i.test(message))return 'network_timeout';
  if(codes.some(code=>['ECONNRESET','ECONNREFUSED','ENOTFOUND','EAI_AGAIN','ENETUNREACH','EHOSTUNREACH','EPIPE','UND_ERR_SOCKET','request_failed'].includes(code))||/\bfetch failed\b|\bnet::ERR_(?:CONNECTION|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED)/i.test(message))return 'network_error';
  if(error?.name==='AbortError'||['ABORT_ERR','cancelled'].includes(error?.code))return 'request_cancelled';
  // Older collectors stored import failures as collection_error. Read that
  // evidence internally, but never return any raw message/stack to the page.
  if (['dependency_missing','ERR_MODULE_NOT_FOUND','MODULE_NOT_FOUND'].includes(error?.code)
    || /(?:Cannot find (?:package|module)[\s'"`]+sm-crypto|ERR_MODULE_NOT_FOUND[^\n]*sm-crypto)/i.test(String(error?.error||''))) return 'dependency_missing';
  return Object.hasOwn(policies,error?.code)?error.code:'collection_error';
}
const view = (status,label,reason='',code=null) => ({status,label,reason,code});
export function channelErrorDiagnostic(errors=[]){
  const unresolved=errors.filter(error=>error&&!error.resolved_at);if(!unresolved.length)return null;
  const codes=unresolved.map(normalizedErrorCode);
  const code=['TASK_OUTPUT_OWNERSHIP','disk_full','output_locked','output_error','RESOURCE_PRESSURE','dependency_missing','cookie_expired','session_expired','auth_required','login_required','verification_required','session_required','access_blocked','rate_limited'].find(c=>codes.includes(c))||codes[0];
  const [status,label,reason]=policies[code];return {...view(status,label,reason,code),errorCount:unresolved.length};
}
export function deriveChannelDiagnostics(task, manifest, {liveCollection}={}) {
  const owned = manifest?.task_id===task.id ? manifest : null;
  const details = liveCollection?.task_id===task.id ? liveCollection.details||[] : [];
  return Object.fromEntries((task.platforms||[]).map(platform=>{
    const entry=owned?.platforms?.[platform];
    if (entry && typeof entry==='object') {
      const errors=Array.isArray(entry.errors)?entry.errors.filter(error=>!error.resolved_at):[];
      if (errors.length) {
        return [platform,channelErrorDiagnostic(errors)];
      }
      if (entry.transport_paused===true) return [platform,view('paused','渠道已暂停','保留历史数据与断点','transport_paused')];
      if (entry.status==='running') return [platform,view('running','采集中')];
      const remaining=entry.scheduling?.remaining;
      if (Array.isArray(remaining)&&remaining.length>0) return [platform,view('paused','本轮暂缓','尚有条件待续采','conditions_deferred')];
      const knownRows=typeof entry.rows==='number'&&Number.isFinite(entry.rows)&&entry.rows>=0;
      const completed=entry.completed===true || entry.status==='completed';
      if (completed) return [platform,knownRows&&entry.rows===0?view('empty','当前条件无结果','不代表平台无相关岗位'):view('completed','已结束')];
      if (knownRows&&Array.isArray(entry.errors)) {
        // Historic manifests have no per-channel completion marker. Their rows
        // prove an observed result, not source exhaustion or an active worker.
        return [platform,Number(entry.rows)===0?view('observed','本轮未取得数据'):view('observed','已取得数据')];
      }
    }
    const pendingDetails=details.some(row=>row.platform===platform&&Number(row.discovered)>Number(row.processed));
    if (pendingDetails&&['running','stopping'].includes(task.status)&&runningStages.has(task.currentStage)) return [platform,view('running','详情采集中')];
    if (task.status==='ready') return [platform,view('pending','待执行')];
    return [platform,view('unknown','状态暂未提供')];
  }));
}
