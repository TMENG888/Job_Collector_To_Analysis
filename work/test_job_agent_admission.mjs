import assert from 'node:assert/strict';
import {classifyKnowledgeRow} from './job_knowledge_store.mjs';
import {normalizeSalary} from './job_knowledge_schema.mjs';
import {admitKnowledgeJobs,admissionSummary,educationAdmits} from './job_data_admission.mjs';
import {scopedFilters} from './job_agent_task.mjs';
import {createAssistantIndex,filterAssistantJobs,answerSalaryBenchmark} from './job_decision_assistant.mjs';
import {conversationConditions,createChatAgent} from './job_assistant_chat.mjs';
import {updateCareerGoal,hiringCohorts,cohortNeedsReview,matchesCareerGoal} from './job_assistant_goal.mjs';

assert.equal(normalizeSalary('7千-1.4万').midpoint,10500);
assert.equal(normalizeSalary('9.9-9.9千').midpoint,9900);
assert.equal(normalizeSalary('200元/天'),null);assert.equal(normalizeSalary('35万元/年'),null);
assert.equal(updateCareerGoal('找2027届秋招，不要使用实习岗位填充').stage,'campus');
assert.equal(updateCareerGoal('找秋招，不要用实习岗位填充').stage,'campus');
assert.deepEqual(hiringCohorts({job_name:'AI算法工程师【2026年应届毕业生】'}),[2026]);
assert.equal(matchesCareerGoal({job_name:'AI算法工程师【2026年应届毕业生】'},{graduation_year:2027}),false);
assert.ok(cohortNeedsReview({job_name:'AI应用（27届校招）',description:'非27届应届毕业生***！！'}));
assert.ok(!cohortNeedsReview({job_name:'AI应用（27届校招）',description:'非27届请勿投递'}));
const security={job_name:'信息安全工程师（2027届校招）',job_description:'岗位职责：负责渗透测试、漏洞验证及安全工具开发。任职要求：本科以上；熟悉Agent框架（如LangChain）或有AI应用开发经验优先。'};
assert.deepEqual(classifyKnowledgeRow(security).role_families,['网络安全']);
assert.ok(!classifyKnowledgeRow({job_name:'人力资源岗（2027校招，AI应用方向）',job_description:'岗位职责：利用AI优化人力资源事务性工作，搭建HR知识库，提高行政工作效率。任职要求：本科，熟练使用AI工具。'}).role_families.includes('智能体/大模型应用'));
assert.ok(!classifyKnowledgeRow({job_name:'售后支持岗（AI应用方向）',job_description:'岗位职责：处理售后退款投诉工单，维护话术库。任职要求：熟悉AI工具，能搭建智能体优先。'}).role_families.includes('智能体/大模型应用'));
const underspecified=classifyKnowledgeRow({...security,job_name:'后端工程师',job_description:'岗位职责：负责构建智能体与RAG知识库，开发多智能体编排服务。任职要求：本科，Python。'});
assert.equal(underspecified.role_evidence.supervised['智能体/大模型应用'].decision,'review','short JDs no longer bypass supervised input scope');
assert.ok(classifyKnowledgeRow({...security,job_name:'后端工程师',job_description:'岗位职责：负责构建智能体与RAG知识库，开发多智能体编排服务；搭建检索增强生成系统，开发工具调用接口和多轮对话流程，将大模型能力集成到业务应用中，负责应用部署及效果评估。任职要求：本科，Python。'}).role_families.includes('智能体/大模型应用'));
assert.ok(educationAdmits({education:'本科及以上'},'硕士'));assert.ok(!educationAdmits({education:'博士'},'本科'));assert.ok(!educationAdmits({education:'1'},'本科',{strict:true}));
const roles=['智能体/大模型应用','嵌入式开发'];
const rows=['广州','深圳'].flatMap(city=>roles.flatMap((role,r)=>Array.from({length:8},(_,i)=>({job_id:`${city}-${r}-${i}`,job_name:`2027届${role}校招`,city,education:'本科',experience:'应届生',employment_type:'全职',role_families:[role],skills:['Python'],salary:`${10+r*5+i}-${12+r*5+i}K`,job_description:'岗位职责：开发业务应用，维护服务及接口。任职要求：本科及以上学历，应届生，熟悉Python。',row_no:2+i}))));
rows.forEach((j,i)=>{j.row_no=i+2;});
const index=createAssistantIndex({role:'全岗位知识库',knowledge:true,roles,revision:1,cohort_observations:rows},rows);
for(const [i,j] of index.jobs.entries()){const old=j.key;j.key='K'+i.toString(16).padStart(24,'0');index.tokenSets.set(j.key,index.tokenSets.get(old));index.tokenSets.delete(old);}
assert.deepEqual(conversationConditions(index,'广州和深圳都可以').cities,['广州','深圳']);
assert.deepEqual(conversationConditions(index,'从广州换成深圳').cities,['深圳']);
assert.equal(filterAssistantJobs(index.jobs,{cities:['广州','深圳']}).length,32);
assert.equal(filterAssistantJobs(index.jobs,{cities:['广州','深圳'],exclude_cities:['深圳']}).length,16);
assert.throws(()=>scopedFilters({cities:['广州']},{cities:['深圳']},index),/不能自动放宽/);
const common={stage:'campus',education:'本科',graduation_year:2027,cities:['广州','深圳'],roles,salary_period:'month'};
const grouped=answerSalaryBenchmark(index,{goal:common,filters:{cities:common.cities,roles}});
assert.equal(grouped.salary_benchmark.segments.length,4);assert.equal(grouped.salary_benchmark.suggestion,null);
assert.ok(grouped.salary_benchmark.segments.every(s=>s.groups.month.count===8&&s.suggestion));assert.equal(grouped.salary_benchmark.groups.month.count,0);
const suspicious=admitKnowledgeJobs(Array.from({length:6},(_,i)=>({decision:'include',platform:'前程无忧',salary_raw:'9.9-9.9千',education:'本科',key:String(i)})));
assert.ok(suspicious.every(j=>j.admission.retrieval&&!j.admission.salary));assert.equal(admissionSummary(suspicious).reasons.repeated_9_9k_pending_verification,6);
assert.equal(admitKnowledgeJobs([{decision:'include',platform:'x',salary_raw:'9.9-9.9千',education:'本科'}])[0].admission.salary,true,'isolated amount not presumed anomalous');

let saved=null;const repository={withLock:async(_id,fn)=>fn(),read:async()=>saved?structuredClone(saved):null,write:async value=>{saved=structuredClone(value);},metadata:r=>({id:r.id})};
let agent=createChatAgent({repository});
let turn=await agent.run(index,{message:'一天报价多少？我要找智能体秋招',useModel:false});
assert.equal(turn.task.status,'waiting_for_user');assert.equal(turn.result.sources.length,0);
turn=await agent.run(index,{conversationId:turn.conversationId,message:'广州深圳，仲恺农业工程学院，27届毕业',useModel:false});
assert.deepEqual(turn.goal.cities,['广州','深圳']);assert.equal(turn.goal.graduation_year,2027);assert.equal(turn.goal.education,undefined);assert.equal(turn.task.pending_questions.length,1);
const id=turn.conversationId;agent.close();agent=createChatAgent({repository});
turn=await agent.run(index,{conversationId:id,message:'本科',useModel:false});
assert.equal(turn.task.status,'completed');assert.equal(turn.result.salary_benchmark.segments.length,2);assert.ok(turn.result.sources.every(s=>s.education==='本科'));assert.equal(turn.assistant_flow_version,4);
assert.deepEqual(turn.trace.map(t=>t.tool),['search_jobs','salary_benchmark','job_details']);assert.equal(saved.state.resume,undefined);agent.close();

// Five genuine result-dependent model tool rounds, then a grounded answer.
let calls=0;const config={JOB_ASSISTANT_PROVIDER:'deepseek',JOB_ASSISTANT_MODEL:'test',JOB_ASSISTANT_API_KEY:'fake-test-key'};
const model=createChatAgent({getModel:async()=>config,fetcher:async(_url,opts)=>{
  const req=JSON.parse(opts.body);calls++;
  if(calls>1)assert.ok(req.messages.some(m=>m.role==='tool'));
  const steps=[['task_status',{}],['search_jobs',{cities:['广州'],query:'Python'}],['search_jobs',{cities:['深圳']}],['data_quality_report',{}],['market_statistics',{cities:['广州']}]];
  if(calls<=5){const [name,args]=steps[calls-1];return {ok:true,json:async()=>({choices:[{message:{tool_calls:[{id:'call'+calls,type:'function',function:{name,arguments:JSON.stringify(args)}}]}}]})};}
  const out=req.messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content)).find(o=>o.sources?.length),citation=out.sources[0].citation;
  return {ok:true,json:async()=>({choices:[{message:{content:`已分别检索广州和深圳，岗位资格仍需复核[${citation}]。`}}]})};
}});
turn=await model.run(index,{message:'广州和深圳的岗位分步查一下'});
assert.equal(turn.execution,'model');assert.equal(calls,6);assert.equal(turn.trace.length,5);assert.ok(turn.trace.every(t=>t.origin==='model'));model.close();
let repair=0;
const recover=createChatAgent({getModel:async()=>config,fetcher:async(_url,opts)=>{
  const req=JSON.parse(opts.body);repair++;
  if(repair===1)return {ok:true,json:async()=>({choices:[{message:{tool_calls:[{id:'bad',type:'function',function:{name:'search_jobs',arguments:'{"cities":["深圳"]}'}}]}}]})};
  assert.ok(req.messages.some(m=>m.role==='tool'&&m.content.includes('invalid_arguments')));
  return {ok:true,json:async()=>({choices:[{message:{content:'你希望把范围从广州扩展到深圳吗？'}}]})};
}});
turn=await recover.run(index,{message:'只看广州'});assert.equal(turn.execution,'model');assert.equal(turn.trace[0].status,'failed');assert.equal(turn.result,null);recover.close();
console.log('PASS: mixed-unit salary, no silent conversions, main-duty vs preferred skill, minimum degree, quality quarantine, scoped tool security, 2-city × 2-role independent benchmarks, persisted clarification/restart, six model rounds with tool-result continuations, invalid scope repair; no collection');
