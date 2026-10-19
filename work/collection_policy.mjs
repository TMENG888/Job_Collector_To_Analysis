// Exit codes distinguish a blocked channel from unsafe global continuation.
export const CHANNEL_PARTIAL = 44;
export function collectionExitCode(error) {
  if (error?.code === 'RESOURCE_PRESSURE') return 43;
  if (['OUTPUT_LOCKED', 'EACCES', 'EPERM', 'ENOSPC', 'EIO', 'ENOENT', 'EBUSY', 'EROFS'].includes(error?.code)) return 42;
  return CHANNEL_PARTIAL;
}
export function stageDisposition(code, pipeline) {
  if (code === CHANNEL_PARTIAL) return pipeline ? 'continue_partial' : 'pause';
  if (code === 0) return 'complete';
  if ([42, 43].includes(code)) return 'pause';
  return 'fail';
}
export async function checkedJsonResponse(response, channel='渠道') {
  const status = typeof response.status === 'function' ? response.status() : response.status;
  const fail = (message, code) => Object.assign(new Error(`${channel}：${message}`), {code, stopChannel:true});
  if ([401, 403, 429].includes(status)) throw fail(`HTTP ${status}，停止该渠道；请人工检查登录、访问限制或限流状态`, 'access_blocked');
  if (status < 200 || status >= 300) throw fail(`HTTP ${status}`, 'http_error');
  const text = await response.text();
  if (/^\s*</.test(text)) {
    const verification = /aliyun_waf|captcha|访问验证|安全验证|人机验证|<textarea|请先登录/i.test(text);
    throw fail(verification ? '返回登录/安全验证页面而非岗位 JSON，请在平台入口人工处理；已保留断点' : '返回 HTML 而非岗位 JSON，请检查页面或接口结构', verification ? 'verification_required' : 'invalid_response');
  }
  try { return JSON.parse(text); }
  catch { throw fail('岗位响应不是有效 JSON，停止该渠道并保留断点', 'invalid_response'); }
}
export async function boundedFetch(url, options={}, {attempts=4, fetchImpl=fetch, wait=ms=>new Promise(r=>setTimeout(r,ms)), before=async()=>{}, timeoutMs=30000,isValidatedData=()=>false}={}) {
  const limit=Math.max(1,Math.min(4,Number(attempts)||1));
  for(let attempt=1;attempt<=limit;attempt++) {
    await before();
    try {
      const response=await fetchImpl(url,{...options,signal:options.signal||AbortSignal.timeout(timeoutMs)});
      if([401,403,429].includes(response.status))throw Object.assign(Error(`HTTP ${response.status}，该渠道已停止，不自动重试登录/验证/限流`),{code:'access_blocked',stopChannel:true});
      if(!response.ok)throw Object.assign(Error(`HTTP ${response.status}`),{code:'http_error',retryable:response.status>=500});
      const body=await response.clone().text();
      if(!isValidatedData(response)&&/^\s*</.test(body)&&(/aliyun_waf|<textarea[^>]*\bid=["']?(?:renderData|styleData)/i.test(body)||body.length<10000&&/访问验证|请按住滑块|人机验证/i.test(body)))
        throw Object.assign(Error('返回安全验证页面，请在平台登录入口人工处理，已停止该渠道'),{code:'verification_required',stopChannel:true});
      return response;
    }catch(error){
      const transient=!error.code&&!error.stopChannel || error.retryable===true;
      if(!transient||attempt===limit)throw error;
      await wait(600*2**(attempt-1));
    }
  }
}
