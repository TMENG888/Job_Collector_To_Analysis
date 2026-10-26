import assert from 'node:assert/strict';
import {parseOriginalSalary,buildSalaryBenchmark} from './job_salary_benchmark.mjs';
import {updateCareerGoal,applyCareerGoal,jobCareerStage} from './job_assistant_goal.mjs';
import {answerSalaryBenchmark,createAssistantIndex} from './job_decision_assistant.mjs';
import {createChatAgent} from './job_assistant_chat.mjs';

for(const [raw,period,min,max,pay] of [
  ['150-200元/天','day',150,200,null],['80元/小时','hour',80,80,null],
  ['15-25K·14薪','month',15000,25000,14],['1.5万-2万/月·14薪','month',15000,20000,14],
  ['20-30万元/年','year',200000,300000,null],['10000-15000元/月','month',10000,15000,null],
  ['15-20K·13-16薪','month',15000,20000,13],
]){const s=parseOriginalSalary(raw);assert.equal(s.period,period,raw);assert.equal(s.min,min,raw);assert.equal(s.max,max,raw);assert.equal(s.pay_months?.min??null,pay,raw);}
for(const raw of ['35万','面议','13薪',''])assert.equal(parseOriginalSalary(raw),null,raw);
assert.equal(parseOriginalSalary('15-25K').annual_nominal,null);
let goal=updateCareerGoal('只找实习日薪');
goal=updateCareerGoal('一天大概多少钱？我要找秋招岗位',goal,{employment_preference:'实习'});
assert.equal(goal.stage,'campus');assert.equal(goal.salary_period,'month');assert.equal(goal.unit_conflict,true);
assert.equal(updateCareerGoal('秋招，不是实习',{}).stage,'campus');
assert.equal(updateCareerGoal('不找实习，改社招',{}).stage,'social');
assert.equal(updateCareerGoal('继续',updateCareerGoal('改全职',{stage:'internship'}),{employment_preference:'实习'}).stage,undefined);
assert.equal(updateCareerGoal('继续',updateCareerGoal('届次不限',{}),{graduation_year:2027}).graduation_year,undefined);
assert.equal(applyCareerGoal({employment_type:'实习'},goal).employment_type,'全职');
const released=updateCareerGoal('不用局限在实习计算',{stage:'internship',graduation_year:2027});
assert.equal(released.stage,'all');assert.equal(released.analysis_mode,'market');
assert.equal(applyCareerGoal({employment_type:'实习',graduation_year:2027},released).employment_type,undefined);
assert.equal(applyCareerGoal({graduation_year:2027},released).graduation_year,undefined);
assert.equal(updateCareerGoal('继续看看薪资分布',released).stage,'all');
assert.equal(updateCareerGoal('校招和社招都看',released).stage,'formal');
assert.equal(jobCareerStage({job_name:'2027届Agent开发',employment_type:'未明确'}),'campus');
const base={job_name:'2027届智能体工程师（校招）',city:'北京',experience:'应届生',education:'本科',employment_type:'全职',skills:['Python','RAG','LLM'],role_families:['智能体/大模型应用'],description:'任职要求：本科及以上，熟悉Python、RAG开发与LLM应用。'};
const rows=[...Array.from({length:12},(_,i)=>({...base,job_id:String(i),salary:`${10+i}-${12+i}K${i%2?'·14薪':''}`})),
  {...base,job_id:'day',salary:'200-300元/天'}, {...base,job_id:'year',salary:'20-30万元/年'},
  {...base,job_id:'unknown',job_name:'智能体校招',salary:'80-90K'},
  {...base,job_id:'wrong',job_name:'2026届智能体校招',salary:'80-90K'},
  {...base,job_id:'intern',job_name:'智能体实习生',employment_type:'实习',salary:'150-200元/天'},
  {...base,job_id:'degree',education:'硕士',salary:'80-90K'},
  {...base,job_id:'city',city:'上海',salary:'80-90K'}].map((j,i)=>({...j,row_no:i+2,salary_midpoint_k:20}));
const index=createAssistantIndex({role:'智能体/大模型应用',generated_at:'test',cohort_observations:rows},rows.map(j=>({...j,job_description:j.description})));
index.jobs=index.jobs.map(j=>({...j,role_families:base.role_families}));
goal={stage:'campus',stage_source:'user',graduation_year:2027,education:'本科',city:'北京',roles:base.role_families,salary_period:'month'};
const filters=applyCareerGoal({city:'北京',roles:base.role_families},goal);
const benchmark=answerSalaryBenchmark(index,{goal,filters,resume:'求职意向：智能体实习生\n2027届本科在校生\nPython RAG LLM。'});
assert.equal(benchmark.salary_benchmark.groups.month.count,12); // Not just the 8 displayed jobs.
assert.equal(benchmark.salary_benchmark.groups.day.count,1);assert.equal(benchmark.salary_benchmark.groups.year.count,1);
assert.equal(benchmark.salary_benchmark.unknown_cohort_rows,1);
assert.equal(benchmark.salary_benchmark.suggestion.opening,16500);
assert.deepEqual(benchmark.salary_benchmark.groups.month.pay_months_distribution,{'未公开':6,'14薪':6});
assert.match(benchmark.message,/谈判建议/);assert.ok(benchmark.sources.every(s=>!['intern','wrong','degree','city','unknown'].includes(s.job_id)));
assert.equal(buildSalaryBenchmark(index.jobs.slice(0,2),{goal}).suggestion,null);
assert.equal(buildSalaryBenchmark(index.jobs.slice(0,12),{goal:{}}).suggestion,null);

const agent=createChatAgent();
let turn=await agent.run(index,{message:'找智能体实习岗位',resume:'求职意向：智能体实习生\n2027届本科在校生\nPython RAG LLM',useModel:false});
turn=await agent.run(index,{conversationId:turn.conversationId,message:'一天大概我能报价多少钱？我要找秋招岗位，北京',useModel:false});
assert.equal(turn.goal.stage,'campus');assert.equal(turn.result.mode,'salary_benchmark');assert.equal(turn.result.salary_benchmark.groups.month.count,12);
assert.deepEqual(turn.trace.map(t=>t.tool),['match_resume','salary_benchmark','job_details']);assert.ok(turn.trace.every(t=>t.origin==='preflight'));
assert.match(turn.answer,/原始岗位证据/);assert.ok(!JSON.stringify(turn).includes('150-200元/天'));agent.close();
const switchAgent=createChatAgent();
let switched=await switchAgent.run(index,{message:'找实习',useModel:false});
switched=await switchAgent.run(index,{conversationId:switched.conversationId,message:'改社招，三年经验，20K以上',useModel:false});
assert.equal(switched.filters.years,3);assert.equal(switched.filters.salary_min_k,20);switchAgent.close();
const config={JOB_ASSISTANT_PROVIDER:'deepseek',JOB_ASSISTANT_MODEL:'test',JOB_ASSISTANT_API_KEY:'fake-test-key'};
let modelCalls=0;
const model=createChatAgent({getModel:async()=>config,fetcher:async(_u,opts)=>{
  modelCalls++;const request=JSON.parse(opts.body),facts=JSON.parse(request.messages[1].content).preflight_facts;
  assert.equal(facts[1].salary_benchmark.groups.month.count,12);assert.ok(!opts.body.includes('private-resume-marker'));
  return {ok:true,json:async()=>({choices:[{message:{content:'可用月薪中点对标作为谈判参考，不是个人预测[J2]。'}}]})};
}});
turn=await model.run(index,{message:'2027届本科，北京智能体秋招，薪资报价多少？',resume:'private-resume-marker。Python RAG LLM'});
assert.equal(turn.execution,'model');assert.equal(modelCalls,1);assert.equal(turn.result.mode,'salary_benchmark');model.close();
let repeated=0;
const cached=createChatAgent({getModel:async()=>config,fetcher:async()=>({ok:true,json:async()=>({choices:[{message:++repeated<4?{tool_calls:[{id:'repeat'+repeated,type:'function',function:{name:'search_jobs',arguments:'{}'}}]}:{content:'先核对岗位要求[J2]。'}}]})})});
turn=await cached.run(index,{message:'检索岗位'});assert.equal(turn.execution,'model');assert.equal(turn.trace.length,1);assert.equal(repeated,4);cached.close();
const failed=createChatAgent({getModel:async()=>config,fetcher:async()=>({ok:false,status:401})});
turn=await failed.run(index,{message:'2027届本科北京智能体秋招薪资'});
assert.equal(turn.execution,'local-fallback');assert.match(turn.answer,/谈判建议/);assert.match(turn.answer,/原始岗位证据/);assert.equal(turn.model_run.error_code,'http_401');failed.close();
const clarify=createChatAgent({getModel:async()=>config,fetcher:async()=>({ok:true,json:async()=>({choices:[{message:{content:'你希望找哪个方向的岗位，主要考虑哪个城市？'}}]})})});
turn=await clarify.run(index,{message:'帮我看看机会'});assert.equal(turn.execution,'model');assert.equal(turn.trace.length,0);clarify.close();
let saved=null;
const repository={withLock:async(_id,fn)=>fn(),read:async()=>saved?structuredClone(saved):null,write:async value=>{saved=structuredClone(value);},metadata:r=>({id:r.id})};
let persistent=createChatAgent({repository});
turn=await persistent.run(index,{message:'智能体秋招薪资',useModel:false});const id=turn.conversationId;persistent.close();
persistent=createChatAgent({repository});turn=await persistent.run(index,{conversationId:id,message:'2027届本科，北京',useModel:false});
assert.equal(turn.goal.stage,'campus');assert.equal(turn.result.mode,'salary_benchmark');assert.ok(turn.result.salary_benchmark.suggestion);assert.equal(saved.state.resume,undefined);persistent.close();
console.log('PASS: raw salary units/payment counts; independent career goals; explicit campus overrides resume internship; cohort/degree/city gates; full-corpus benchmark; preflight/model/no-tool clarification/fallback; encrypted-state restart contract; no collection');
