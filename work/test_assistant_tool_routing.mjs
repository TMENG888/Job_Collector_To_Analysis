import assert from 'node:assert/strict';
import http from 'node:http';
import {parseCollectionIntent,authorizeCollectionAction} from './job_assistant_collection_intent.mjs';
import {routeCollectionRequest} from './job_assistant_collection_draft.mjs';
import {collectionOnlyIndex} from './job_assistant_collection.mjs';
import {createChatAgent} from './job_assistant_chat.mjs';
import {createAssistantIndex} from './job_decision_assistant.mjs';
import {createAssistantHandler} from './job_assistant_http.mjs';
import {publicToolFailure,toolError} from './job_agent_task.mjs';

// Entirely simulated models, knowledge, collection controller and localhost HTTP.
// No credentials, production data, collector endpoints or external APIs are used.
// Explicit KB query exercises the evidence-tool loop. General career questions
// now use the subquestion planner (covered by test_assistant_consultation).
const question='请检索爬虫工程师岗位并分析当前库的业务证据';
const careerQuestions=[question,'爬虫工程师通常做哪些业务？','爬虫工程师是做什么的','爬虫岗位都有什么日常工作','数据采集工程师主要交付什么','网页采集岗位的业务方向是什么','网络爬虫工程师能去哪些公司','目前爬虫岗位薪资行情怎么样','请解释爬虫工程师的商业模式','爬虫岗位技能要求是什么？','帮我看看爬虫岗位如何盈利','爬虫工程师的职业前景如何','爬虫工程师怎么开始找工作','数据采集岗位的项目经历怎么写'];
for(const message of careerQuestions){assert.equal(parseCollectionIntent(message).domain,false,message);assert.equal(routeCollectionRequest(message),false,message);assert.equal(authorizeCollectionAction(message,'create_start').ok,false,message);}
const managementQuestions=['查看采集任务列表','查询爬虫采集任务最新进度','查询爬虫岗位任务进度','查询爬虫工程师任务最新状态','爬虫工程师采集任务的日志','爬虫工程师采集任务最新进度','帮我采集爬虫工程师岗位','创建爬虫工程师采集任务','启动爬虫任务','暂停这个采集任务','查看爬虫任务日志','导出最新采集数据','确认','重新准备采集方案'];
for(const message of managementQuestions)assert.equal(routeCollectionRequest(message),true,message);
for(const message of ['不要采集爬虫岗位','查询采集任务进度，不启动','爬虫工程师怎么开始找工作'])assert.equal(authorizeCollectionAction(message,'create_start').ok,false,message);

const observation={row_no:2,job_id:'fixture-crawler',job_name:'爬虫工程师',city:'广州',education:'本科',skills:['Python'],salary_midpoint_k:15};
const index=createAssistantIndex({role:'爬虫/数据采集',generated_at:'routing-test',cohort_observations:[observation]},[{job_id:observation.job_id,job_name:observation.job_name,job_description:'负责公开商品数据采集与清洗，开发Python采集程序，为电商价格分析业务提供数据，维护采集服务。'}]);
const env={JOB_ASSISTANT_PROVIDER:'deepseek',JOB_ASSISTANT_MODEL:'fixture',JOB_ASSISTANT_API_KEY:'not-a-real-key'};
let collectionReads=0,preparations=0,locals=0;
const control={
 async read(){collectionReads++;return {status:'ready',mode:'collection',message:'模拟任务列表，未执行任何采集。',tasks:[],sources:[]};},
 async prepare(){preparations++;throw Error('Unexpected preparation: no write permission');},
 async local(){locals++;return {status:'ready',mode:'collection',message:'模拟任务列表。',tasks:[],sources:[]};},
};
const call=(names)=>Response.json({choices:[{finish_reason:'tool_calls',message:{tool_calls:names.map((name,i)=>({id:name+'-'+i,type:'function',function:{name,arguments:'{}'}}))}}]});
const reply=content=>Response.json({choices:[{finish_reason:'stop',message:{content}}]});
const names=['knowledge_catalog','market_statistics','search_jobs','data_quality_report','task_status'];
let calls=0,offers=[],outputs=[];
const fetcher=async(_url,opts)=>{
 const r=JSON.parse(opts.body);calls++;offers.push(r.tools.map(t=>t.function.name));
 assert.ok(r.tools.every(t=>!t.function.name.startsWith('collection_')));
 assert.ok(!r.messages[0].content.includes('采集管理Agent'));
 for(const m of r.messages.filter(m=>m.role==='tool'))outputs.push(JSON.parse(m.content));
 return calls===1?call(names.slice(0,3)):calls===2?call(names.slice(3)):reply('本次岗位样本描述了公开商品数据采集与清洗，为电商价格分析提供数据；不能据此推断全行业业务占比[J2]。');
};
const agent=createChatAgent({collectionControl:control,getModel:async()=>env,fetcher});
try{
 const turn=await agent.run(index,{message:question});
 assert.equal(turn.execution,'model');assert.equal(turn.task.intent,'job_exploration');
 assert.deepEqual(turn.trace.map(t=>t.tool),names);assert.ok(turn.trace.every(t=>t.status==='ready'));
 assert.ok(!turn.answer.includes('采集工具未成功'));assert.ok(turn.answer.includes('[J2]'));
 assert.equal(collectionReads+preparations+locals,0);assert.ok(outputs.some(r=>r.mode==='search'&&r.sources.length));
 const local=await agent.run(index,{message:question,useModel:false});assert.ok(local.trace.some(t=>t.tool==='search_jobs'&&t.status==='ready'));
 // Returning from collector management to career questions must not stick to the old mode.
 const management=await agent.run(collectionOnlyIndex,{message:'查看采集任务列表',useModel:false});
 const switched=await agent.run(index,{message:question,conversationId:management.conversationId,useModel:false});
 assert.equal(switched.task.intent,'job_exploration');assert.ok(switched.trace.some(t=>t.tool==='search_jobs'&&t.status==='ready'));
}finally{agent.close();}

// Exercise the unified KB's role filtering and K citations, not only old reports.
const kb=createAssistantIndex({...index.report,knowledge:true,roles:['爬虫/数据采集'],revision:1},[{job_id:observation.job_id,job_name:observation.job_name,job_description:index.jobs[0].description}]);
const citation='K'+('1'.repeat(24)),oldKey=kb.jobs[0].key;
kb.jobs[0].key=citation;kb.jobs[0].role_families=['爬虫/数据采集'];kb.tokenSets.set(citation,kb.tokenSets.get(oldKey));kb.tokenSets.delete(oldKey);
let kbCalls=0;
const kbAgent=createChatAgent({collectionControl:control,getModel:async()=>env,fetcher:async(_url,opts)=>{
 const request=JSON.parse(opts.body);kbCalls++;
 if(kbCalls===1){assert.deepEqual(JSON.parse(request.messages[1].content).filters.roles,['爬虫/数据采集']);return call(names.slice(0,3));}
 if(kbCalls===2)return call(names.slice(3));
 return reply('岗位证据描述的是商品采集与电商价格分析['+citation+']。');
}});
try{const t=await kbAgent.run(kb,{message:question});assert.equal(t.execution,'model');assert.equal(t.trace.length,5);assert.ok(t.trace.every(x=>x.status==='ready'));assert.ok(t.answer.includes(citation));}finally{kbAgent.close();}

const modeFailure=publicToolFailure(toolError('TOOL_MODE_MISMATCH','模式不匹配',{mode:'career',available_tools:['search_jobs']},'routing'));
assert.equal(modeFailure.failure_code,'TOOL_MODE_MISMATCH');assert.equal(modeFailure.recovery.action,'use_available_tools');
assert.equal(publicToolFailure(new Error('private-server-path')).message.includes('private-server-path'),false);
// A hallucinated tool from the other mode is traced but never dispatched.
let recoveryCalls=0;
const recover=createChatAgent({collectionControl:control,getModel:async()=>env,fetcher:async(_url,opts)=>{
 recoveryCalls++;const r=JSON.parse(opts.body);
 if(recoveryCalls===1)return call(['collection_prepare_action']);
 if(recoveryCalls===2){const f=JSON.parse(r.messages.findLast(m=>m.role==='tool').content);assert.equal(f.failure_code,'TOOL_MODE_MISMATCH');assert.ok(f.details.available_tools.includes('search_jobs'));return call(['search_jobs']);}
 return reply('公开商品采集与电商价格分析[J2]。');
}});
try{const turn=await recover.run(index,{message:question});assert.equal(turn.execution,'model');assert.equal(turn.trace[0].failure_code,'TOOL_MODE_MISMATCH');assert.ok(turn.trace[0].resolved);assert.equal(preparations,0);}finally{recover.close();}
// Calls were attempted but all failed: never claim that no tools were used.
let failedCalls=0;
const failed=createChatAgent({collectionControl:control,getModel:async()=>env,fetcher:async(_url,opts)=>{
 const r=JSON.parse(opts.body);failedCalls++;assert.ok(r.tools.every(t=>t.function.name.startsWith('collection_')));
 return failedCalls===1?call(['knowledge_catalog','market_statistics','search_jobs']):reply('工具调用未成功。');
}});
try{const turn=await failed.run(collectionOnlyIndex,{message:'查看采集任务列表'});assert.equal(turn.model_run.error_code,'tool_execution_failed');assert.equal(failedCalls,2);assert.ok(turn.trace.every(t=>t.failure_code==='TOOL_MODE_MISMATCH'));assert.ok(!turn.answer.includes('未使用证据工具'));}finally{failed.close();}
let noToolCalls=0;
const unused=createChatAgent({getModel:async()=>env,fetcher:async()=>{noToolCalls++;return reply('岗位市场整体情况如下。');}});
try{const turn=await unused.run(index,{message:question});assert.equal(turn.model_run.error_code,'no_tool_use');assert.equal(noToolCalls,2);}finally{unused.close();}

// HTTP JSON and SSE routing must load real query index, not collectionOnlyIndex.
let loads=0,httpCalls=0;
const handler=createAssistantHandler({load:async()=>{loads++;return index;}},null,{collectionControl:control,getModel:async()=>env,fetcher:async()=>{httpCalls++;return httpCalls%2?call(['search_jobs']):reply('公开商品数据采集服务于电商价格分析[J2]。');}});
const server=http.createServer(async(req,res)=>{try{if(!await handler(req,res,new URL(req.url,'http://localhost').pathname)){res.writeHead(404);res.end();}}catch(e){res.writeHead(500);res.end(e.message);}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port;
try{
 const post=(body,stream=false)=>fetch(base+'/api/assistant/chat',{method:'POST',headers:{'content-type':'application/json',...(stream?{accept:'text/event-stream'}:{})},body:JSON.stringify(body)});
 const json=await post({message:question});assert.equal(json.status,200);const turn=await json.json();assert.equal(turn.task.intent,'job_exploration');assert.equal(turn.trace[0].status,'ready');assert.equal(loads,1);
 const stream=await post({message:question},true);assert.equal(stream.status,200);const text=await stream.text();assert.ok(text.includes('event: done'));assert.ok(!text.includes('TOOL_EXECUTION_FAILED'));assert.ok(text.includes('J2'));assert.equal(loads,2);
 const management=await post({message:'查看采集任务列表',useModel:false});assert.equal(management.status,200);assert.equal(loads,2);assert.equal((await management.json()).task.intent,'collection_management');
 assert.equal(preparations,0);
}finally{await new Promise(resolve=>server.close(resolve));}
console.log(JSON.stringify({passed:true,careerRoutingCases:careerQuestions.length,managementRoutingCases:managementQuestions.length,originalFiveTools:'all ready',knowledgeRoleScopeAndCitations:true,wrongModeRecovery:true,failedVsUnused:true,httpJson:true,httpSse:true,modeSwitch:true,externalModelRequests:0,collectionWrites:0}));
