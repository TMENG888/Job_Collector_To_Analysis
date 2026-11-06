import assert from 'node:assert/strict';
import http from 'node:http';
import {createAssistantIndex} from './job_decision_assistant.mjs';
import {runCareerConsultation,validateConsultationPlan,isCareerConsultation} from './job_assistant_consultation.mjs';
import {createChatAgent} from './job_assistant_chat.mjs';
import {createAssistantHandler} from './job_assistant_http.mjs';
import {salaryComparisonSummary} from './assistant_consultation_comparison.mjs';

const question='那深圳的呢？还有就是对比其他数据库当中的岗位薪资';
const roles=['数据分析','前端开发','智能体/大模型应用'];
const obs=roles.flatMap((role,r)=>['深圳','广州'].flatMap((city,c)=>Array.from({length:6},(_,i)=>({row_no:2+r*12+c*6+i,job_id:`${r}-${c}-${i}`,job_name:role+'工程师',city,employment_type:'全职',education:'本科',experience:'1-3年',skills:['Python'],salary_midpoint_k:8+r*4+c*20,salary_raw:`${8+r*4+c*20}-${10+r*4+c*20}K`,role_families:[role]}))));
const index=createAssistantIndex({role:'全岗位知识库',knowledge:true,roles,revision:'comparison-fixture',cohort_observations:obs},obs.map(j=>({job_id:j.job_id,job_name:j.job_name,job_description:'负责分析业务数据和开发工程系统，完成技术实现、测试验证和数据质量保障。',salary:j.salary_raw})));
index.jobs.forEach((job,i)=>{const oldKey=job.key;Object.assign(job,{key:'K'+i.toString(16).padStart(24,'0'),role_families:obs[i].role_families,salary_raw:obs[i].salary_raw,employment_type:'全职',admission:{retrieval:true,salary:true}});index.tokenSets.set(job.key,index.tokenSets.get(oldKey));});
const state={filters:{roles:['智能体/大模型应用'],city:'广州',cities:['广州'],candidate_education:'本科',graduation_year:2027},history:[],discussion:{roles:['数据分析'],cities:['广州'],topic:'数据分析的工作和薪资'}};
const stateBefore=structuredClone(state);
const repaired=validateConsultationPlan({parts:[{kind:'salary',question:'深圳薪资'}]},question,state.discussion);
assert.deepEqual(repaired.parts.map(p=>p.kind),['salary','salary_comparison']);
assert.equal(isCareerConsultation('数据分析薪资比起其他岗位怎么样'),true);
assert.equal(isCareerConsultation('我的简历适合什么岗位，薪资对比其他岗位呢'),false);
let loads=0;
let turn=await runCareerConsultation({index,message:question,state,useModel:false,loadComparisonIndex:async()=>{loads++;return index;}});
assert.equal(loads,1);
assert.equal(turn.task.completion,'complete');
assert.equal(turn.result.sections.length,2);
const section=turn.result.sections[1];
assert.deepEqual(section.roles,roles);
assert.equal(section.segments[0].salary_benchmark.segments.length,3);
assert.ok(section.segments[0].salary_benchmark.segments.every(group=>group.city==='深圳'&&group.groups.month.count===6));
assert.match(section.text,/前端开发的报价中点中位数比数据分析高 4,000/);
assert.match(section.text,/智能体\/大模型应用的报价中点中位数比数据分析高 8,000/);
assert.deepEqual(turn.trace.filter(t=>t.tool==='salary_benchmark').map(t=>t.query_scope.roles),[['数据分析'],roles]);
assert.deepEqual(state,stateBefore);

turn=await runCareerConsultation({index,message:question,state,useModel:false,loadComparisonIndex:async()=>{throw Error('fixture-failure');}});
assert.equal(turn.task.completion,'partial');
assert.equal(turn.task.status,'partial');
assert.equal(turn.task.pending_questions.length,1);
assert.match(turn.answer,/比较尚未完成/);
assert.ok(turn.trace.some(t=>t.tool==='knowledge_catalog'&&t.status==='failed'));
assert.equal(turn.result.sections[0].status,'ready');

const response=value=>Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]});
let phases=[];
const env={JOB_ASSISTANT_PROVIDER:'deepseek',JOB_ASSISTANT_MODEL:'mock',JOB_ASSISTANT_API_KEY:'fixture-only'};
turn=await runCareerConsultation({index,message:question,state,getModel:async()=>env,loadComparisonIndex:async()=>index,fetcher:async(_url,options)=>{
  const request=JSON.parse(options.body),payload=JSON.parse(request.messages[1].content);
  if(request.messages[0].content.includes('任务规划器')){phases.push('planning');return response({parts:[{kind:'salary',question:'深圳本岗位薪资'}]});}
  if(request.messages[0].content.includes('综合说明')){phases.push('synthesis');const citation=payload.sources[0].citation;return response({text:`不同方向的职责不同，应结合工程开发与数据分析要求判断[${citation}]。`,citations:[citation]});}
  phases.push('quality');return response({});
}});
assert.deepEqual(phases,['planning','synthesis','quality']);
assert.match(turn.answer,/不同方向的职责不同/);
assert.equal(turn.task.completion,'complete');
assert.ok(turn.model_run.requests.length<=6);

const agent=createChatAgent({loadComparisonIndex:async()=>index});
try{
  const first=await agent.run(index,{message:'数据分析是做什么的？',useModel:false});
  const followup=await agent.run(index,{conversationId:first.conversationId,message:question,useModel:false});
  assert.equal(followup.result.sections.at(-1).kind,'salary_comparison');
  assert.equal(followup.task.completion,'complete');
  assert.deepEqual(followup.filters,first.filters);
}finally{agent.close();}

let fullLoads=0;
const handler=createAssistantHandler({load:async()=>{fullLoads++;return index;},consultationIndex:async()=>index},null,{getModel:async()=>({})});
const server=http.createServer(async(req,res)=>{if(!await handler(req,res,new URL(req.url,'http://localhost').pathname)){res.writeHead(404);res.end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
try{
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/assistant/chat`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:'深圳数据分析薪资相比其他岗位怎么样？',useModel:false})});
  const result=await response.json();
  assert.equal(response.status,200);
  assert.equal(result.task.completion,'complete');
  assert.equal(fullLoads,1);
}finally{await new Promise(resolve=>server.close(resolve));}

assert.ok(!salaryComparisonSummary([{stage:'formal',salary_benchmark:{segments:[{role:'A',city:'深圳',groups:{month:{count:2,published:false,median:5000}}},{role:'B',city:'深圳',groups:{day:{count:6,published:true,median:200}}}]}}],['A']).includes('比A高'));
console.log('PASS: omitted comparison restored, per-role queries, same city/unit/stage, independent personal scope, deterministic deltas, bounded AI synthesis, partial failures, chat and real HTTP; paid requests=0');
