// Incremental SSE framing shared by the browser and provider adapter. A JSON
// payload or a UTF-8 character may span any number of network chunks.
export async function readAssistantEvents(body,onEvent,{signal}={}){
  if(!body?.getReader)throw new Error('服务未返回可读取的数据流');
  const reader=body.getReader(),decoder=new TextDecoder();let buffer='',event='message',data=[];
  const cancel=()=>{void reader.cancel().catch(()=>{});};signal?.addEventListener('abort',cancel,{once:true});
  async function line(value){
    if(!value){if(data.length)await onEvent({event,data:data.join('\n')});event='message';data=[];return;}
    if(value.startsWith(':'))return;
    const colon=value.indexOf(':'),key=colon<0?value:value.slice(0,colon),raw=colon<0?'':value.slice(colon+1),text=raw.startsWith(' ')?raw.slice(1):raw;
    if(key==='event')event=text;else if(key==='data')data.push(text);
    if(data.reduce((n,s)=>n+s.length,0)>2000000)throw new Error('单条流式事件过大');
  }
  async function drain(eof=false){
    let end;while((end=buffer.indexOf('\n'))>=0){const value=buffer.slice(0,end).replace(/\r$/,'');buffer=buffer.slice(end+1);await line(value);}
    if(buffer.length>2000000)throw new Error('流式事件过大');
    if(eof){if(buffer)await line(buffer.replace(/\r$/,''));await line('');}
  }
  try{while(true){if(signal?.aborted)throw new Error('本轮已停止');const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});await drain();}
    if(signal?.aborted)throw new Error('本轮已停止');buffer+=decoder.decode();await drain(true);
  }finally{signal?.removeEventListener('abort',cancel);await reader.cancel().catch(()=>{});reader.releaseLock();}
}

export async function requestAssistantStream(url,body,onEvent,{fetcher=fetch,signal,timeoutMs=240000}={}){
  const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted)controller.abort();
  const timer=setTimeout(abort,timeoutMs);let turn=null;
  try{
    const response=await fetcher(url,{method:'POST',headers:{'content-type':'application/json',accept:'text/event-stream'},body:JSON.stringify(body),signal:controller.signal});
    if(!response.ok){const data=await response.json().catch(()=>({}));throw Object.assign(new Error(data.error||`请求失败（${response.status}）`),{status:response.status});}
    // Old services can answer JSON on the same request. Never resend a POST just
    // because streaming is unsupported: that could prepare a second task card.
    if(!response.headers.get('content-type')?.includes('text/event-stream'))return await response.json();
    await readAssistantEvents(response.body,async({event,data})=>{
      let value;try{value=JSON.parse(data);}catch{throw new Error('流式响应格式异常，请核对会话记录');}
      if(event==='error')throw new Error(value.message||'本轮未完成');
      if(event==='done'){if(turn)throw new Error('收到重复完成事件');turn=value.turn;}
      else if(turn)throw new Error('完成事件后收到异常数据');
      await onEvent({type:event,...value});
    },{signal:controller.signal});
    if(!turn)throw new Error('连接在完成前中断；请核对会话记录，不要重复执行操作');
    return turn;
  }catch(error){if(controller.signal.aborted)throw new Error(signal?.aborted?'本轮已停止':'流式请求超时，请核对会话记录');throw error;}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
