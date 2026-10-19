import assert from 'node:assert/strict';
import {extractResumeProfile,assessResumeJobFit,hasReactSkill} from './resume_job_fit.mjs';
import {extractResumeSkills,createAssistantIndex,answerJobDecision} from './job_decision_assistant.mjs';
import {createChatAgent} from './job_assistant_chat.mjs';

// Entirely synthetic; never copy a real resume into fixtures.
const resume='求职意向：智能体开发实习生\n2028届本科在校生\n教育背景：2024.09 - 2028.06（预计）\n专业技能：Python、ReAct、RAG、LLM、RESTful API，了解LangGraph。\n项目经历：private-fixture-marker\n实习经历：北京和上海，共两段Python开发实习。';
const p=extractResumeProfile(resume);
assert.equal(p.education,'本科');assert.equal(p.student,true);assert.equal(p.graduation_year,2028);assert.equal(p.employment_preference,'实习');assert.deepEqual(p.target_roles,['智能体/大模型应用']);
assert.ok(!JSON.stringify(p).includes('北京'));assert.ok(!JSON.stringify(p).includes('private-fixture-marker'));
assert.equal(hasReactSkill('ReAct'),false);assert.equal(hasReactSkill('ReAct / React'),true);assert.equal(hasReactSkill('react.js'),true);
const skills=extractResumeSkills(resume,['React','Python','RAG','LLM','REST API']);
assert.ok(skills.includes('ReAct'));assert.ok(skills.includes('LangGraph'));assert.ok(skills.includes('REST API'));assert.ok(!skills.includes('React'));
assert.ok(!extractResumeSkills('不会React；计划学习LangGraph',['React']).includes('LangGraph'));
const base={job_name:'Agent开发实习生',experience:'经验不限',education:'本科',employment_type:'实习',skills:['Python','RAG'],role_families:['智能体/大模型应用'],description:'使用Python构建Agent和RAG应用，任职要求本科及以上在校生。'};
assert.equal(assessResumeJobFit(base,p).tier,0);
assert.equal(assessResumeJobFit({...base,education:'硕士'},p).eligible,false);
assert.equal(assessResumeJobFit({...base,education:'本科',description:'任职要求：硕士研究生及以上学历。'},p).eligible,false);
assert.equal(assessResumeJobFit({...base,description:'任职要求：本科及以上，硕士优先。'},p).eligible,true);
assert.equal(assessResumeJobFit({...base,job_name:'Agent开发实习生（27届）'},p).eligible,false);
assert.equal(assessResumeJobFit({...base,job_name:'2028届AI应用开发工程师',employment_type:'全职',experience:'应届生'},p).tier,1);
assert.equal(assessResumeJobFit({...base,job_name:'AI开发工程师',employment_type:'全职',experience:'3-5年'},p).eligible,false);
assert.equal(assessResumeJobFit({...base,job_name:'AI开发工程师',employment_type:'全职',experience:'经验不限'},p).tier,2);
assert.equal(assessResumeJobFit({...base,job_name:'实习及全职开发',employment_type:'全职'},p).checks.length,3); // Includes unknown-cohort warning.
const rows=[{...base,job_id:'intern',salary_midpoint_k:4,salary_basis:'日/时薪折算（比较默认排除）'},
  {...base,job_id:'senior',job_name:'高级Agent开发',experience:'5-10年',employment_type:'全职',skills:['Python','RAG','LLM'],salary_midpoint_k:40},
  {...base,job_id:'masters',education:'硕士',skills:['Python','RAG','LLM'],salary_midpoint_k:10},
  {...base,job_id:'campus',job_name:'2028届AI开发',employment_type:'全职',experience:'应届生',salary_midpoint_k:15}].map((r,i)=>({...r,row_no:i+2}));
const index=createAssistantIndex({role:'智能体/大模型应用',generated_at:'synthetic',cohort_observations:rows},rows.map(j=>({...j,job_description:j.description,salary:j.job_id==='intern'?'180元/天':'15000元/月'})));
let r=answerJobDecision(index,{mode:'match',resume});
assert.deepEqual(r.sources.map(s=>s.job_id),['intern','campus']);assert.equal(r.match_summary.excluded_qualification,2);assert.equal(r.statistics.valid_salary_rows,1);assert.equal(r.statistics.median_salary_k,null);assert.equal(r.sources[0].salary_raw,'180元/天');
assert.ok(!r.plan.some(x=>x.skill==='LangGraph'));assert.ok(!JSON.stringify(r).includes('private-fixture-marker'));
r=answerJobDecision(index,{mode:'search',filters:{experience:'5-10年'},explicitFilters:true});assert.equal(r.sources[0].job_id,'senior');
// A real model can choose a follow-up search; it must not lose the resume gates.
let calls=0;
const agent=createChatAgent({getModel:async()=>({JOB_ASSISTANT_PROVIDER:'deepseek',JOB_ASSISTANT_MODEL:'test',JOB_ASSISTANT_API_KEY:'fake-secret-key'}),fetcher:async(_url,opts)=>{
  const req=JSON.parse(opts.body);assert.ok(!opts.body.includes('private-fixture-marker'));
  assert.equal(JSON.parse(req.messages[1].content).resume_profile.graduation_year,2028);
  if(++calls<=2)return {ok:true,json:async()=>({choices:[{message:{tool_calls:[{id:'c'+calls,type:'function',function:{name:calls===1?'match_resume':'search_jobs',arguments:JSON.stringify(calls===1?{}:{query:'Python'})}}]}}]})};
  const tool=JSON.parse(req.messages.filter(m=>m.role==='tool').at(-1).content);
  assert.ok(tool.sources.every(s=>s.experience!=='5-10年'&&s.education!=='硕士'));
  assert.equal(tool.sources[0].salary_raw,'180元/天');assert.ok(tool.sources[0].requirements_excerpt);
  return {ok:true,json:async()=>({choices:[{message:{content:'请优先核对实习要求[J2]。'}}]})};
}});
const turn=await agent.run(index,{message:'根据我的简历找适合的岗位',resume});
assert.equal(turn.execution,'model');assert.equal(turn.result.mode,'match');assert.ok(!turn.result.resume_skills.includes('React'));
assert.ok(turn.result.sources.every(s=>s.experience!=='5-10年'&&s.education!=='硕士'));agent.close();
assert.equal(answerJobDecision({...index,jobs:index.jobs.map(j=>j.job_id==='intern'?{...j,employment_type:'未明确'}:j)},{mode:'search',filters:{employment_type:'实习'},explicitFilters:true}).sources.length,2);
let orderStep=0;
const orderAgent=createChatAgent({getModel:async()=>({JOB_ASSISTANT_PROVIDER:'deepseek',JOB_ASSISTANT_MODEL:'test',JOB_ASSISTANT_API_KEY:'fake-secret-key'}),fetcher:async()=>++orderStep===1?{ok:true,json:async()=>({choices:[{message:{tool_calls:[{id:'order',type:'function',function:{name:'match_resume',arguments:'{}'}}]}}]})}:{ok:true,json:async()=>({choices:[{message:{content:'1. 校招备选[J5]\n2. 实习岗位[J2]'}}]})}});
const ordered=await orderAgent.run(index,{message:'匹配岗位',resume});
assert.equal(ordered.selection[0].key,'row:5');
const compared=await orderAgent.run(index,{conversationId:ordered.conversationId,message:'对比前两个岗位',useModel:false});
assert.equal(compared.result.sources[0].key,'row:5'); // compare follows the visible pair, not the original ranking
assert.deepEqual(new Set(compared.result.sources.map(s=>s.key)),new Set(['row:5','row:2']));orderAgent.close();
let repairStep=0;
const repairAgent=createChatAgent({getModel:async()=>({JOB_ASSISTANT_PROVIDER:'deepseek',JOB_ASSISTANT_MODEL:'test',JOB_ASSISTANT_API_KEY:'fake-secret-key'}),fetcher:async(_url,opts)=>{
  repairStep++;
  if(repairStep===1)return {ok:true,json:async()=>({choices:[{message:{tool_calls:[{id:'match',type:'function',function:{name:'match_resume',arguments:'{}'}},{id:'catalog',type:'function',function:{name:'knowledge_catalog',arguments:'{}'}}]}}]})};
  if(repairStep===2)return {ok:true,json:async()=>({choices:[{message:{content:'没有引用格式的建议'}}]})};
  assert.match(opts.body,/本机引用校验未通过/);
  return {ok:true,json:async()=>({choices:[{message:{content:'已核对实习岗位[J2]。'}}]})};
}});
const repaired=await repairAgent.run(index,{message:'匹配我的简历',resume});assert.equal(repaired.execution,'model');assert.equal(repaired.model_run.citation_repair_attempted,true);assert.equal(repairStep,3);repairAgent.close();
const knowledgeIndex={...index,report:{...index.report,knowledge:true,roles:['智能体/大模型应用']},jobs:index.jobs.map((j,i)=>({...j,key:'K'+String(i+1).repeat(24)}))};
knowledgeIndex.tokenSets=new Map(knowledgeIndex.jobs.map(j=>[j.key,new Set(['python'])]));
let shortStep=0;
const shortAgent=createChatAgent({getModel:async()=>({JOB_ASSISTANT_PROVIDER:'deepseek',JOB_ASSISTANT_MODEL:'test',JOB_ASSISTANT_API_KEY:'fake-secret-key'}),fetcher:async()=>++shortStep===1?{ok:true,json:async()=>({choices:[{message:{tool_calls:[{id:'short',type:'function',function:{name:'match_resume',arguments:'{}'}}]}}]})}:{ok:true,json:async()=>({choices:[{message:{content:'核对此岗位[K111111...]。'}}]})}});
const shortened=await shortAgent.run(knowledgeIndex,{message:'匹配简历',resume});assert.equal(shortened.execution,'model');assert.match(shortened.answer,/\[K111111111111111111111111\]/);assert.equal(shortened.model_run.requests[1].normalized_citations,1);shortAgent.close();
let failStep=0;
const failedAgent=createChatAgent({getModel:async()=>({JOB_ASSISTANT_PROVIDER:'deepseek',JOB_ASSISTANT_MODEL:'test',JOB_ASSISTANT_API_KEY:'fake-secret-key'}),fetcher:async()=>++failStep===1?{ok:true,json:async()=>({choices:[{message:{tool_calls:[{id:'match',type:'function',function:{name:'match_resume',arguments:'{}'}},{id:'catalog',type:'function',function:{name:'knowledge_catalog',arguments:'{}'}}]}}]})}:{ok:false,status:401}});
const failed=await failedAgent.run(index,{message:'匹配我的简历',resume});assert.equal(failed.execution,'local-fallback');assert.match(failed.answer,/Agent开发实习生/);assert.match(failed.answer,/180元\/天/);failedAgent.close();
// Persistent repositories reload public state each turn. Matching focus must
// survive that reload without persisting resume text.
let saved=null;
const repository={withLock:async(_id,fn)=>fn(),read:async()=>saved?structuredClone(saved):null,write:async value=>{saved=structuredClone(value);},metadata:r=>({id:r.id})};
const persistedAgent=createChatAgent({repository});
const initial=await persistedAgent.run(index,{message:'匹配我的简历',resume,useModel:false});
assert.equal(saved.state.matchingFocus,true);assert.ok(!JSON.stringify(saved).includes('private-fixture-marker'));assert.equal(saved.state.resume,undefined);
const follow=await persistedAgent.run(index,{message:'继续找岗位',conversationId:initial.conversationId,useModel:false});
assert.equal(follow.result.mode,'match');assert.ok(follow.result.sources.every(s=>s.fit.eligible));persistedAgent.close();
console.log('PASS: student/intern profile, identity privacy, ReAct != React, REST alias, degree/cohort/experience gates, raw salary, follow-up model search retains matching');
