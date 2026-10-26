import assert from 'node:assert/strict';
import http from 'node:http';
import {readAssistantEvents,requestAssistantStream} from '../job_collector_ui/public/assistant-event-stream.js';
import {readModelReply} from './assistant_model_stream.mjs';
import {createAssistantHandler} from './job_assistant_http.mjs';
import {createAssistantIndex} from './job_decision_assistant.mjs';
import {createChatAgent} from './job_assistant_chat.mjs';

const encoder=new TextEncoder();
function stream(text,size=7){const bytes=encoder.encode(text);return new ReadableStream({start(c){for(let n=0;n<bytes.length;n+=size)c.enqueue(bytes.slice(n,n+size));c.close();}});}
const sse=values=>new Response(stream(values.map(v=>'data: '+(typeof v==='string'?v:JSON.stringify(v))+'\r\n\r\n').join('')),{headers:{'content-type':'text/event-stream'}});
let frames=[];
await readAssistantEvents(stream(': ping\r\nevent: phase\r\ndata: {"message":"正在读取岗位😀"}\r\n\r\nevent: done\ndata: {"turn":{"answer":"完成"}}\n\n',1),event=>frames.push({...event,value:JSON.parse(event.data)}));
assert.equal(frames[0].value.message,'正在读取岗位😀');assert.equal(frames[1].event,'done');
const delta=value=>({choices:[{delta:value}]}),finish=reason=>({choices:[{delta:{},finish_reason:reason}]}),progress=[];
const parsed=await readModelReply(sse([delta({reasoning_content:'PRIVATE_REASONING'}),delta({tool_calls:[{index:0,id:'call1',function:{name:'search_',arguments:'{"query":'}}]}),delta({tool_calls:[{index:0,function:{name:'jobs',arguments:'"Python"}'}}]}),finish('tool_calls'),'[DONE]']),{onProgress:p=>progress.push(p)});
assert.equal(parsed.choices[0].message.tool_calls[0].function.name,'search_jobs');assert.equal(parsed.choices[0].message.tool_calls[0].function.arguments,'{"query":"Python"}');assert.equal(progress.length,0);
await assert.rejects(readModelReply(sse([delta({content:'未结束'})])),/意外中断/);
const report={role:'智能体/大模型应用',generated_at:'fixture',cohort_observations:[{row_no:2,job_id:'1',job_name:'智能体工程师',city:'北京',education:'本科',skills:['Python'],salary_midpoint_k:20}]};
const index=createAssistantIndex(report,[{job_id:'1',job_name:'智能体工程师',job_description:'负责Python智能体与RAG系统开发，完成工具编排和检索服务。'}]);
let releaseLoad,enteredLoad;const loading=new Promise(resolve=>enteredLoad=resolve),loadGate=new Promise(resolve=>releaseLoad=resolve);
let calls=0;
const model={JOB_ASSISTANT_PROVIDER:'deepseek',JOB_ASSISTANT_MODEL:'fixture',JOB_ASSISTANT_API_KEY:'fake-only-private-key'};
const fetcher=async(_url,options)=>{
  const request=JSON.parse(options.body);assert.equal(request.stream,true);calls++;
  if(calls===1)return sse([delta({reasoning_content:'PRIVATE_REASONING'}),delta({tool_calls:[{index:0,id:'search',type:'function',function:{name:'search_jobs',arguments:'{}'}}]}),finish('tool_calls'),'[DONE]']);
  assert.ok(request.messages.some(m=>m.role==='tool'));
  assert.ok(request.messages.some(m=>m.reasoning_content==='PRIVATE_REASONING'));
  return sse([delta({reasoning_content:'PRIVATE_REASONING_2'}),delta({content:'已找到北京的'}),delta({content:'智能体工程师岗位[J2]。'}),finish('stop'),'[DONE]']);
};
const handler=createAssistantHandler({load:async()=>{enteredLoad();await loadGate;return index;}},null,{getModel:async()=>model,fetcher});
const server=http.createServer(async(req,res)=>{if(!await handler(req,res,new URL(req.url,'http://localhost').pathname)){res.writeHead(404);res.end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
try{
  const events=[];let sawLoading;const firstEvent=new Promise(resolve=>sawLoading=resolve);
  const pending=requestAssistantStream(base+'/api/assistant/chat',{message:'找北京岗位'},event=>{events.push(event);if(event.phase==='loading')sawLoading();});
  await loading;await Promise.race([firstEvent,new Promise((_,reject)=>setTimeout(()=>reject(Error('loading event buffered until completion')),2000))]);
  assert.equal(calls,0,'loading must arrive before model/knowledge work finishes');releaseLoad();
  const turn=await pending;
  assert.equal(calls,2);assert.equal(turn.execution,'model');
  assert.ok(events.find(e=>e.type==='tool_start'&&e.tool==='search_jobs'));
  assert.ok(events.find(e=>e.type==='tool_end'&&e.status==='ready'));
  assert.equal(events.filter(e=>e.type==='answer_delta').map(e=>e.text).join(''),turn.answer);
  assert.equal(events.at(-1).type,'done');assert.ok(!JSON.stringify(events).includes('PRIVATE_REASONING'));assert.ok(!JSON.stringify(events).includes('fake-only-private-key'));
  assert.ok(events.findIndex(e=>e.phase==='validation')<events.findIndex(e=>e.type==='answer_delta'));
  let posts=0;
  const old=await requestAssistantStream('http://fixture',{},()=>{}, {fetcher:async()=>{posts++;return Response.json({answer:'旧服务兼容'});}});
  assert.equal(old.answer,'旧服务兼容');assert.equal(posts,1,'JSON compatibility must not replay POST');
  await assert.rejects(requestAssistantStream('http://fixture',{},()=>{}, {fetcher:async()=>new Response(stream('event: phase\ndata: {"message":"处理中"}\n\n'),{headers:{'content-type':'text/event-stream'}})}),/连接在完成前中断/);
  const badAgent=createChatAgent({getModel:async()=>model,fetcher:async()=>sse([delta({content:'REJECTED_DRAFT[J999]'}),finish('stop'),'[DONE]'])});
  const invalidEvents=[];const bad=await badAgent.run(index,{message:'查北京岗位'},undefined,event=>invalidEvents.push(event));badAgent.close();
  assert.equal(bad.execution,'local-fallback');assert.ok(!JSON.stringify(invalidEvents).includes('REJECTED_DRAFT'));assert.ok(!bad.answer.includes('REJECTED_DRAFT'));
  const abort=new AbortController();let aborted=false;
  const abortedClient=requestAssistantStream('http://fixture',{},()=>{}, {signal:abort.signal,fetcher:async(_url,options)=>new Promise((resolve,reject)=>{options.signal.addEventListener('abort',()=>{aborted=true;reject(Error('aborted'));},{once:true});})});
  abort.abort();await assert.rejects(abortedClient,/已停止/);assert.equal(aborted,true);
  const denied=await fetch(base+'/api/assistant/chat',{method:'POST',headers:{'content-type':'application/json',accept:'text/event-stream',origin:'https://evil.example'},body:'{}'});assert.equal(denied.status,403);
  console.log('PASS: early HTTP events, UTF-8/SSE fragmentation, real multi-round streamed tool calls, validated answer chunks, no private reasoning/draft/key exposure, JSON single-request compatibility, interrupted streams, cancellation and origin checks; no paid requests');
}finally{releaseLoad();await new Promise(resolve=>server.close(resolve));}
