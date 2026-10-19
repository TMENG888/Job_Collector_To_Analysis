import {readAssistantEvents} from '../job_collector_ui/public/assistant-event-stream.js';

// Reasoning is kept only in this transient provider continuation, never emitted
// as UI progress, returned diagnostics or persisted conversation history.
export async function readModelReply(response,{signal,onProgress=()=>{}}={}){
  if(!response.headers?.get('content-type')?.includes('text/event-stream'))return response.json();
  const reply={role:'assistant',content:'',reasoning_content:''},calls=new Map();
  let finish=null,usage,ended=false,announced=false,total=0;
  await readAssistantEvents(response.body,async({data})=>{
    if(data==='[DONE]'){ended=true;return;}
    if(ended)throw new Error('模型数据流结束后仍有内容');
    const frame=JSON.parse(data);if(frame.error)throw new Error('模型数据流返回错误');
    usage=frame.usage||usage;const choice=frame.choices?.[0],delta=choice?.delta||{};
    if(choice?.finish_reason)finish=choice.finish_reason;
    if(typeof delta.reasoning_content==='string')reply.reasoning_content+=delta.reasoning_content;
    if(typeof delta.content==='string'){
      reply.content+=delta.content;
      if(!announced&&delta.content){announced=true;onProgress({phase:'draft',message:'正在组织答复，随后核验数据引用'});}
    }
    for(const call of delta.tool_calls||[]){
      const n=call.index??0;if(!Number.isInteger(n)||n<0||n>2)throw new Error('模型请求过多工具');
      const saved=calls.get(n)||{id:'',type:'function',function:{name:'',arguments:''}};
      if(call.id)saved.id+=call.id;
      if(call.function?.name)saved.function.name+=call.function.name;
      if(call.function?.arguments)saved.function.arguments+=call.function.arguments;
      calls.set(n,saved);
    }
    total+=data.length;if(total>2000000)throw new Error('模型数据流过大');
    if(signal?.aborted)throw new Error('本轮已停止');
  },{signal});
  if(!ended&&!finish)throw new Error('模型数据流意外中断');
  if(calls.size)reply.tool_calls=[...calls.entries()].sort((a,b)=>a[0]-b[0]).map(([,call])=>call);
  return {choices:[{message:reply,finish_reason:finish}],usage};
}
