import assert from 'node:assert/strict';
import http from 'node:http';
import {createChatAgent} from './job_assistant_chat.mjs';
import {createAssistantHandler} from './job_assistant_http.mjs';
import {createAssistantIndex} from './job_decision_assistant.mjs';
import {isCareerConsultation,validateConsultationPlan,validateConsultationText,runCareerConsultation} from './job_assistant_consultation.mjs';

const question='新媒体运营大概需要什么能力呢？实习工具的能力与薪资和正式职位有什么区别吗';
const env={JOB_ASSISTANT_PROVIDER:'deepseek',JOB_ASSISTANT_MODEL:'deepseek-flash',JOB_ASSISTANT_API_KEY:'test-only-key'};
const empty={report:{knowledge:true,roles:['数据分析'],role:'全岗位知识库'},cacheKey:'test',jobs:[],skills:[]};
const reply=value=>({ok:true,status:200,json:async()=>({choices:[{message:{content:JSON.stringify(value)},finish_reason:'stop'}]})});
const general={text:'新媒体运营涉及内容策划、文案与视频制作、平台运营和数据复盘。实习生侧重执行与学习，正式岗位更强调独立负责内容策略、增长目标及协作。工具只是手段，应结合具体职责选择。',citations:[]};
const plan={parts:[{kind:'general',question:'能力、工具及实习和正式职责差异'},{kind:'salary',question:'比较实习日薪与正式月薪'}]};
assert.equal(isCareerConsultation(question),true);
assert.equal(isCareerConsultation('目前爬虫岗位大概率会做什么样的业务去赚钱呢'),true);
assert.equal(isCareerConsultation('数据采集工程师需要什么能力'),true);
for(const text of ['按我的简历匹配岗位','帮我采集新媒体运营','对比前两个岗位','有哪些面试高频题','加入销售工程师','我想找正式岗位','还有什么技能没有提及？'])assert.equal(isCareerConsultation(text),false,text);
assert.throws(()=>validateConsultationPlan({parts:[{kind:'execute',question:'启动'}]},question));
assert.throws(()=>validateConsultationPlan({parts:[{kind:'salary',question:'统计'}]},question));
assert.throws(()=>validateConsultationPlan({parts:[{kind:'general',question:'介绍'}],filters:{roles:['数据分析']}},question));
assert.throws(()=>validateConsultationText({text:'本库显示工资8000元',citations:[]},{kind:'general'}));
assert.throws(()=>validateConsultationText({text:'引用[J999]',citations:['J999']},{kind:'general'}));
assert.throws(()=>validateConsultationText({text:'多数岗位要求精通剪辑',citations:[]},{kind:'general'}));
assert.equal(validateConsultationText(general,{kind:'general'}),general.text);

let calls=[];
const agent=createChatAgent({getModel:async()=>env,fetcher:async(url,opt)=>{
  const request=JSON.parse(opt.body);calls.push(request);
  assert.equal(request.tools,undefined);assert.equal(request.messages[0].role,'system');
  return reply(calls.length===1?plan:general);
}});
let turn=await agent.run(empty,{message:question});
assert.equal(turn.execution,'model');assert.equal(calls.length,3);assert.equal(turn.trace.length,0);
assert.equal(turn.model_run.requests.at(-1).phase,'quality');
assert.equal(turn.result.answer_quality.status,'not_evaluated'); // Mock has no semantic labels: never invent a score.
assert.match(turn.answer,/内容策划/);assert.match(turn.answer,/尚未覆盖/);assert.equal(turn.task.completion,'partial');
assert.equal(turn.filters.employment_type,undefined);assert.equal(turn.goal,undefined);
assert.equal(turn.response_plan.stage_comparison,true);assert.equal(turn.result.sections.length,2);
assert.ok(!JSON.stringify(turn).includes('test-only-key'));agent.close();

// Explicit local mode cannot call a model or pretend to know market salaries.
const offline=createChatAgent({getModel:async()=>{throw Error('must not run');},fetcher:async()=>{throw Error('network prohibited');}});
turn=await offline.run(empty,{message:question,useModel:false});assert.equal(turn.execution,'local');assert.equal(turn.model_run,null);assert.match(turn.answer,/通用职业/);offline.close();

// Two valid groups use separate pay units, not an inferred personal internship.
const obs=Array.from({length:12},(_,i)=>({row_no:i+2,job_id:String(i),job_name:i<6?'数据分析实习生':'数据分析师',city:'广州',employment_type:i<6?'实习':'全职',experience:i<6?'经验不限':'1-3年',education:'本科',skills:['SQL'],salary_midpoint_k:i<6?3:10,salary_raw:i<6?'150-200元/天':'8-12K'}));
const index=createAssistantIndex({role:'数据分析',generated_at:'fixture',cohort_observations:obs},obs.map(j=>({job_id:j.job_id,job_name:j.job_name,job_description:'负责数据清洗与SQL查询，分析用户增长并输出业务报告。',salary:j.salary_raw})));
index.report.knowledge=true;index.report.roles=['数据分析'];
index.jobs.forEach((j,i)=>{j.role_families=['数据分析'];j.salary_raw=obs[i].salary_raw;j.employment_type=obs[i].employment_type;j.admission={retrieval:true,salary:true};});
calls=[];
const comparison=createChatAgent({getModel:async()=>env,fetcher:async(_url,opt)=>{
  const req=JSON.parse(opt.body);calls.push(req);return reply(calls.length===1?plan:general);
}});
turn=await comparison.run(index,{message:'数据分析实习与正式岗位需要什么能力，薪资有什么区别？'});
assert.equal(turn.trace.length,2);assert.equal(turn.result.sections[1].segments.length,2);
assert.equal(turn.result.sections[1].segments[0].salary_benchmark.groups.day.count,6);
assert.equal(turn.result.sections[1].segments[1].salary_benchmark.groups.month.count,6);
assert.equal(turn.filters.career_stage,undefined);assert.equal(turn.result.sections[1].status,'ready');
const discussionId=turn.conversationId;
turn=await comparison.run(index,{conversationId:discussionId,message:'那广州的薪资呢',useModel:false});
assert.equal(turn.response_plan.stage_comparison,true);assert.equal(turn.trace.length,2);
assert.equal(turn.result.sections[0].segments[0].salary_benchmark.groups.day.count,6);
assert.deepEqual(turn.filters,{});assert.deepEqual(turn.discussion_context.roles,['数据分析']);
comparison.close();

// Discussion must preserve confirmed personal conditions, including persistence.
const recordMap=new Map();
const repo={withLock:async(_id,fn)=>fn(),read:async id=>recordMap.get(id),write:async r=>recordMap.set(r.id,r),metadata:r=>({id:r.id}),list:async()=>[]};
let round=0;
const memory=createChatAgent({repository:repo,getModel:async()=>env,fetcher:async()=>reply(++round%2?plan:general)});
let seeded=await memory.run(index,{message:'我想找广州正式岗位，本科学历',useModel:false});
const before=structuredClone(seeded.filters),beforeGoal=structuredClone(seeded.goal);
turn=await memory.run(index,{conversationId:seeded.conversationId,message:'数据分析实习与正式岗位需要什么能力，薪资有什么区别？'});
assert.deepEqual(turn.filters,before);assert.deepEqual(turn.goal,beforeGoal);
assert.deepEqual(recordMap.get(seeded.conversationId).state.filters,before);
assert.equal(recordMap.get(seeded.conversationId).turns.at(-1).turn.response_plan.version,1);memory.close();

// Provider failure is not retried and local statistics remain usable.
let failedCalls=0;
const unavailable=createChatAgent({getModel:async()=>env,fetcher:async()=>{failedCalls++;return {ok:false,status:401};}});
turn=await unavailable.run(index,{message:'数据分析实习与正式岗位需要什么能力，薪资有什么区别？'});
assert.equal(failedCalls,1);assert.equal(turn.trace.length,2);assert.match(turn.answer,/原始报价/);assert.equal(turn.task.completion,'partial');unavailable.close();

// One bad general answer is repaired once; rejected text never reaches output.
let invalidCalls=0;
const invalid=createChatAgent({getModel:async()=>env,fetcher:async()=>reply(++invalidCalls===1?plan:{text:'工资99999元，保证录用[J999]',citations:['J999']})});
turn=await invalid.run(empty,{message:question});assert.equal(invalidCalls,4);assert.ok(!turn.answer.includes('99999'));assert.equal(turn.result.sections[0].status,'failed');invalid.close();

// No tool failure erases a completed general section.
const broken={...index,tokenSets:{get(){throw Error('fixture tool error');}}};
let brokenCalls=0;
turn=await runCareerConsultation({index:broken,message:'数据分析需要什么能力？请根据JD补充说明',state:{filters:{},history:[]},getModel:async()=>env,fetcher:async()=>reply(++brokenCalls===1?{parts:[{kind:'general',question:'通用能力介绍'},{kind:'job_evidence',question:'JD证据'}]}:general)});
assert.match(turn.answer,/内容策划/);assert.equal(turn.trace[0].status,'failed');assert.equal(turn.task.completion,'partial');

const controller=new AbortController();controller.abort();
await assert.rejects(runCareerConsultation({index:empty,message:question,state:{filters:{},history:[]},getModel:async()=>env,fetcher:async()=>{throw Error('must not run');},signal:controller.signal}));
// Cancellation must bound even a provider mock that ignores its AbortSignal.
const delayed=new AbortController();
const pending=runCareerConsultation({index:empty,message:question,state:{filters:{},history:[]},getModel:()=>new Promise(()=>{}),signal:delayed.signal});
setTimeout(()=>delayed.abort(Error('cancel-test')),5);
await assert.rejects(pending,/cancel-test/);

// The real local HTTP/SSE adapter emits only validated sections, never drafts.
let externalRequests=0;
const handler=createAssistantHandler({load:async()=>empty},null,{getModel:async()=>env,fetcher:async(_url,opt)=>{
  externalRequests++;
  const req=JSON.parse(opt.body);
  return reply(req.messages[0].content.includes('任务规划器')?plan:general);
}});
const server=http.createServer(async(req,res)=>{if(!await handler(req,res,new URL(req.url,'http://localhost').pathname)){res.writeHead(404);res.end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
try{
  const base=`http://127.0.0.1:${server.address().port}`;
  for(const accept of ['application/json','text/event-stream']){
    const response=await fetch(base+'/api/assistant/chat',{method:'POST',headers:{'content-type':'application/json',accept},body:JSON.stringify({message:question})});
    assert.equal(response.status,200);
    if(accept==='application/json'){
      const value=await response.json();assert.equal(value.assistant_flow_version,7);assert.equal(value.result.sections.length,2);assert.match(value.answer,/内容策划/);
    }else{
      const text=await response.text();assert.match(text,/event: plan/);assert.match(text,/event: answer_delta/);assert.match(text,/event: done/);assert.ok(!text.includes('test-only-key'));
    }
  }
  assert.equal(externalRequests,6);
  const context=await fetch(base+'/api/assistant/context');assert.equal(context.headers.get('x-job-assistant-consultation'),'1');
}finally{await new Promise(resolve=>server.close(resolve));}
console.log('PASS consultation: structured planning, mixed questions, scoped failure, separate salary units, no state pollution, persistence, local override, bounded repair, no write tools, cancellation');
