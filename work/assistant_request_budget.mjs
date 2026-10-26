// Bound the entire request, including index loading and session I/O, not just
// provider fetches. Never retry an aborted operation or a collection write.
export function abortReason(signal){return signal?.reason instanceof Error?signal.reason:new Error('本轮已停止');}
export function waitForRequest(operation,signal){
  if(signal?.aborted)return Promise.reject(abortReason(signal));
  return new Promise((resolve,reject)=>{
    const abort=()=>{cleanup();reject(abortReason(signal));};
    const cleanup=()=>signal?.removeEventListener('abort',abort);
    signal?.addEventListener('abort',abort,{once:true});
    Promise.resolve().then(()=>{if(signal?.aborted)throw abortReason(signal);return typeof operation==='function'?operation():operation;}).then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
  });
}
export function requestBudget(res,timeoutMs=180000){
  const controller=new AbortController();
  const cancel=()=>controller.abort(new Error('本轮已停止'));
  const timer=setTimeout(()=>controller.abort(Object.assign(new Error(`本轮请求超过 ${Math.ceil(timeoutMs/1000)} 秒，已停止等待；请核对会话记录，不会自动重试。`),{code:'ASSISTANT_REQUEST_TIMEOUT'})),timeoutMs);
  timer.unref?.();res.once('close',cancel);
  return {signal:controller.signal,wait:operation=>waitForRequest(operation,controller.signal),dispose(){clearTimeout(timer);res.off('close',cancel);}};
}
