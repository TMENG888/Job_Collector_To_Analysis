import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createResumeMatching} from './resume_matching.mjs';
import {matchingScore,matchingPercentage,filterMatchingJobs,matchingJobCard} from '../job_collector_ui/public/resume-matching.js';
import {coverageVersion,requirementCoverage,requirementPrompt} from './resume_requirement_coverage.mjs';
import {redactMatchingResume,validateMatchingReviews} from './resume_matching_contract.mjs';
const base='E:/Codex/temp/20261112-resume-matching-app/tests';
await fs.mkdir(base,{recursive:true});
const resume='姓名：张三\n电话：13800138000\n邮箱：test@example.com\n使用Python开发检索系统，负责接口实现与性能优化，设计数据库表并部署应用。';
const jobs=[{key:'j1',job_name:'Python开发',company:'甲',city:'北京',description:'使用Python开发检索系统',education:'本科',experience:'3–5年'},
  {key:'j2',job_name:'AI实习生',company:'乙',city:'上海',description:'使用Python开发检索系统',education:'大专',experience:'应届生'},
  {key:'j3',job_name:'AI研发',company:'丙',city:'上海',description:'使用Python开发检索系统',education:'未注明',experience:''}];
async function setup({failCompute=false,reviewFail=false}={}){
  const directory=await fs.mkdtemp(path.join(base,'run-'));let requests=0,computations=0,unknown=false;
  const index={roleSnapshots:{研发:{jobs:jobs.map(({key})=>({key}))}},jobs,report:{revision:'test'}};
  const model={status:async()=>({configured:true,model:'mock',usage:{estimate:requests*.01,unknown,inFlight:false}}),cancel(){},
    async request(prompt,body){requests++;if(body.target_role)return {summary:'检索系统开发',skills:[{name:'Python',evidence:'使用Python开发检索系统'}],projects:[],query_facets:['Python','检索','接口','系统'],matching_query:'Python检索系统开发'};
      if(reviewFail)throw Error('预算不足');if(prompt===requirementPrompt){assert.equal(body.resume,undefined);return {jobs:body.jobs.map(j=>({key:j.key,requirements:[{id:'r1',requirement:'Python检索开发',kind:'task',optional:false,jd_evidence:'使用Python开发检索系统'}]}))};}return {jobs:body.jobs.map(j=>({key:j.key,summary:'职责贴合',items:j.requirements.map(r=>({id:r.id,status:'met',resume_evidence:'使用Python开发检索系统',reason:'有直接实践'}))}))};}};
  const service=createResumeMatching({directory,dataDir:directory,modelFactory:()=>model,catalog:async()=>({roles:[{role:'研发',status:'ready'}]}),store:{load:async()=>index},
    compute:async({folder,onProgress})=>{computations++;await onProgress({stage:'testing',done:3,total:3});if(failCompute){failCompute=false;throw Error('模拟中断');}await fs.writeFile(path.join(folder,'ranked.json'),JSON.stringify(jobs.map((j,i)=>({...j,rank:i+1,rerank_score:7.68-i}))));await fs.writeFile(path.join(folder,'performance.json'),'{}');}});
  const body={role:'研发',resume,filename:'张三_简历.pdf',budget:.5,shareConfirmed:true,requestId:randomUUID()};
  const settle=async()=>{for(let i=0;i<300&&service.busy;i++)await new Promise(r=>setTimeout(r,10));assert.equal(service.busy,false);};
  return {service,body,directory,index,settle,stats:()=>({requests,computations}),setUnknown:v=>{unknown=v;}};
}
test('score remains a raw number and post-ranking filters preserve rank',()=>{
  assert.equal(matchingScore(7.676), '7.68');assert.equal(matchingScore(NaN),'—');
  const ranked=jobs.map((j,i)=>({...j,rank:i+1,rerank_score:7.68-i}));
  assert.deepEqual(filterMatchingJobs(ranked,{education:'3',experience:'0',keepUnknown:false}).map(j=>j.rank),[2]);
  assert.deepEqual(filterMatchingJobs(ranked,{experience:'0',keepUnknown:true}).map(j=>j.rank),[2,3]);
  const html=matchingJobCard({...ranked[0],company:'<script>'});assert.match(html,/待评估/);assert.ok(!html.includes('<script>'));assert.match(html,/初筛相关分 7.68/);assert.ok(!html.includes('99.9%'));assert.ok(!html.includes('7.68%'));
});
test('redacts contacts and refuses invented evidence',()=>{
  const value=redactMatchingResume(resume,'张三_简历.pdf');for(const secret of ['张三','13800138000','test@example.com'])assert.ok(!value.includes(secret));
  assert.throws(()=>validateMatchingReviews({reviews:[{key:'j1',verdict:'职责贴合',summary:'x',matches:[{reason:'x',jd_evidence:'虚构',resume_evidence:'使用Python'}],gaps:[],conditions_note:''}]},[{key:'j1',jd:jobs[0].description}],value));
});
test('free end-to-end run persists results, preserves snapshot and replays one request',async()=>{
  const x=await setup();const first=await x.service.start(x.body);const replay=await x.service.start(x.body);assert.equal(first.id,replay.id);await x.settle();
  const result=await x.service.result(first.id);assert.equal(result.jobs.length,3);assert.equal(Object.values(result.coverage).filter(c=>requirementCoverage(c)?.percentage===100).length,3);assert.equal(result.run.status,'completed');assert.equal(x.index.roleSnapshots.研发.jobs.length,3);assert.deepEqual(x.stats(),{requests:5,computations:1});
  assert.equal((await x.service.start(x.body)).id,first.id);assert.deepEqual(x.stats(),{requests:5,computations:1});
  await assert.rejects(x.service.start({...x.body,budget:.4}),/同一请求/);
  const redacted=await fs.readFile(path.join(x.directory,'runs',first.id,'resume-redacted.txt'),'utf8');assert.ok(!redacted.includes('13800138000'));assert.ok(!JSON.stringify(result).includes('test@example.com'));
});
test('resume reuses paid profile and stops if prior billing is unknown',async()=>{
  const x=await setup({failCompute:true});const first=await x.service.start(x.body);await x.settle();assert.equal((await x.service.status()).runs[0].status,'failed');assert.equal(x.stats().requests,1);
  x.setUnknown(true);await assert.rejects(x.service.resume({id:first.id,shareConfirmed:true}),/用量未知/);assert.equal(x.stats().requests,1);x.setUnknown(false);
  await x.service.resume({id:first.id,shareConfirmed:true});await x.settle();assert.equal((await x.service.result(first.id)).run.status,'completed');assert.deepEqual(x.stats(),{requests:5,computations:2});
});
test('review budget exhaustion retains complete ranking; invalid starts never dispatch',async()=>{
  const x=await setup({reviewFail:true});for(const patch of [{shareConfirmed:false},{budget:.51},{role:'未训练'}])await assert.rejects(x.service.start({...x.body,...patch,requestId:randomUUID()}));assert.equal(x.stats().requests,0);
  const first=await x.service.start(x.body);await x.settle();const result=await x.service.result(first.id);assert.equal(result.jobs.length,3);assert.equal(result.reviewCount,0);assert.match(result.run.warning,/预算不足/);
});
test('legacy records retain already spent budget and assessment submissions replay without paying twice',async()=>{
  const x=await setup(),id=randomUUID(),dir=path.join(x.directory,'runs',id);await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(path.join(dir,'resume-redacted.txt'),redactMatchingResume(resume));
  await fs.writeFile(path.join(dir,'state.json'),JSON.stringify({id,role:'研发',status:'completed',phase:'completed',imported:true,budget:.5,estimate:.12,resultAvailable:true}));
  await fs.writeFile(path.join(dir,'result.json'),JSON.stringify({jobs:jobs.map((j,i)=>({...j,rank:i+1})),usage:{estimate:.12}}));
  await fs.writeFile(path.join(x.directory,'index.json'),JSON.stringify([id]));
  const body={id,keys:['j1','j2'],shareConfirmed:true,requestId:randomUUID()};await x.service.assess(body);await x.settle();
  const result=await x.service.result(id);assert.equal(result.run.status,'completed');assert.ok(Math.abs(result.run.estimate-.14)<1e-9);assert.equal(requirementCoverage(result.coverage.j1).percentage,100);assert.equal(result.jobs.length,3);
  assert.deepEqual(x.stats(),{requests:2,computations:0});await x.service.assess(body);await x.settle();assert.deepEqual(x.stats(),{requests:2,computations:0});
  await assert.rejects(x.service.assess({...body,keys:['j3']}),/同一请求/);
  x.setUnknown(true);await assert.rejects(x.service.assess({...body,keys:['j3'],requestId:randomUUID()}),/用量未知/);assert.equal(x.stats().requests,2);
});
