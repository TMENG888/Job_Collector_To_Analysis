import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createResumeMatching,matchingComputeProgress} from './resume_matching.mjs';
import {matchingScore,matchingPercentage,filterMatchingJobs,matchingJobCard,matchingConversationHtml} from '../job_collector_ui/public/resume-matching.js';
import {profileUpdatePrompt,redactProfileMessage,profileEvidenceText,validateProfileUpdate} from './resume_matching_memory.mjs';
import {coverageVersion,requirementCoverage,requirementPrompt} from './resume_requirement_coverage.mjs';
import {redactMatchingResume,validateMatchingReviews} from './resume_matching_contract.mjs';
const base='E:/Codex/temp/20261112-resume-matching-app/tests';
await fs.mkdir(base,{recursive:true});
const resume='姓名：张三\n电话：13800138000\n邮箱：test@example.com\n使用Python开发检索系统，负责接口实现与性能优化，设计数据库表并部署应用。';
const jobs=[{key:'j1',job_name:'Python开发',company:'甲',city:'北京',description:'使用Python开发检索系统',education:'本科',experience:'3–5年'},
  {key:'j2',job_name:'AI实习生',company:'乙',city:'上海',description:'使用Python开发检索系统',education:'大专',experience:'应届生'},
  {key:'j3',job_name:'AI研发',company:'丙',city:'上海',description:'使用Python开发检索系统',education:'未注明',experience:''}];
test('vector progress distinguishes reused text from the incremental encoding workload',()=>{
  const p=matchingComputeProgress({stage:'embedding_progress',chunks:1000,unique_chunks:900,reused_chunks:880,pending_chunks:20,encoded_chunks:4,done:4,total:20});
  assert.equal(p.total,20);assert.equal(p.done,4);assert.equal(p.reused_chunks,880);
  assert.match(p.message,/复用 880 个文本片段，本轮计算 20 个/);
  assert.match(matchingComputeProgress({stage:'embedding_cache_reused',reused_chunks:900,pending_chunks:0,done:0,total:0}).message,/已复用岗位向量/);
});
async function setup({failCompute=false,reviewFail=false}={}){
  const directory=await fs.mkdtemp(path.join(base,'run-'));let requests=0,computations=0,unknown=false;
  const index={roleSnapshots:{研发:{jobs:jobs.map(({key})=>({key}))}},jobs,report:{revision:'test'}};
  const inputs=[];
  const model={status:async()=>({configured:true,model:'mock',usage:{input:requests*100,output:requests*20,estimate:requests*.01,unknown,inFlight:false}}),cancel(){},
    async request(prompt,body){requests++;inputs.push({prompt,body});
      if(prompt===profileUpdatePrompt){
        const skills=body.current_profile.skills.filter(s=>!body.message.includes('删除'+s.name));
        for(const name of ['Docker','Rust'])if(body.documents.some(d=>d.text.includes('使用'+name))&&!skills.some(s=>s.name===name))skills.push({name,evidence:'使用'+name+'部署服务'});
        return {...body.current_profile,skills,summary:skills.map(s=>s.name).join('、'),query_facets:['能力','职责','项目','业务'],matching_query:skills.map(s=>s.name).join(' '),reply:'已按本轮资料更新画像。'};
      }
      if(body.target_role)return {summary:'检索系统开发',skills:[{name:'Python',evidence:'使用Python开发检索系统'}],projects:[],query_facets:['Python','检索','接口','系统'],matching_query:'Python检索系统开发'};
      if(reviewFail)throw Error('模拟响应格式异常');if(prompt===requirementPrompt){assert.equal(body.resume,undefined);return {jobs:body.jobs.map(j=>({key:j.key,requirements:[{id:'r1',requirement:'Python检索开发',kind:'task',optional:false,jd_evidence:'使用Python开发检索系统'}]}))};}return {jobs:body.jobs.map(j=>({key:j.key,summary:'按证据核验',items:j.requirements.map(r=>({id:r.id,status:body.resume.includes('使用Python开发检索系统')?'met':'not_evidenced',resume_evidence:body.resume.includes('使用Python开发检索系统')?'使用Python开发检索系统':'',reason:'按当前画像事实核对'}))}))};}};
  const createService=()=>createResumeMatching({directory,dataDir:directory,modelFactory:()=>model,catalog:async()=>({roles:[{role:'研发',status:'ready'}]}),store:{load:async()=>index},
    compute:async({folder,onProgress})=>{computations++;await onProgress({stage:'testing',done:3,total:3});if(failCompute){failCompute=false;throw Error('模拟中断');}await fs.writeFile(path.join(folder,'ranked.json'),JSON.stringify(jobs.map((j,i)=>({...j,rank:i+1,rerank_score:7.68-i}))));await fs.writeFile(path.join(folder,'performance.json'),'{}');}});
  const service=createService();
  const body={role:'研发',resume,filename:'张三_简历.pdf',budget:.5,shareConfirmed:true,requestId:randomUUID()};
  const settle=async()=>{for(let i=0;i<300&&service.busy;i++)await new Promise(r=>setTimeout(r,10));assert.equal(service.busy,false);};
  return {service,body,directory,index,settle,createService,inputs,stats:()=>({requests,computations}),setUnknown:v=>{unknown=v;}};
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
  assert.equal((await x.service.start({...x.body,budget:.0001})).id,first.id);
  await assert.rejects(x.service.start({...x.body,resume:x.body.resume+'改变'}),/同一请求/);
  const redacted=await fs.readFile(path.join(x.directory,'runs',first.id,'resume-redacted.txt'),'utf8');assert.ok(!redacted.includes('13800138000'));assert.ok(!JSON.stringify(result).includes('test@example.com'));
});
test('resume reuses paid profile and stops if prior billing is unknown',async()=>{
  const x=await setup({failCompute:true});const first=await x.service.start(x.body);await x.settle();assert.equal((await x.service.status()).runs[0].status,'failed');assert.equal(x.stats().requests,1);
  x.setUnknown(true);await assert.rejects(x.service.resume({id:first.id,shareConfirmed:true}),/用量未知/);assert.equal(x.stats().requests,1);x.setUnknown(false);
  await x.service.resume({id:first.id,shareConfirmed:true});await x.settle();assert.equal((await x.service.result(first.id)).run.status,'completed');assert.deepEqual(x.stats(),{requests:5,computations:2});
});
test('review failure retains complete ranking; invalid starts never dispatch',async()=>{
  const x=await setup({reviewFail:true});for(const patch of [{shareConfirmed:false},{role:'未训练'}])await assert.rejects(x.service.start({...x.body,...patch,requestId:randomUUID()}));assert.equal(x.stats().requests,0);
  const first=await x.service.start(x.body);await x.settle();const result=await x.service.result(first.id);assert.equal(result.jobs.length,3);assert.equal(result.reviewCount,0);assert.match(result.run.warning,/响应格式异常/);
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

test('conversation adds document skills, deletes prior claims and reruns scores without changing prior revisions',async()=>{
  const x=await setup(),root=await x.service.start(x.body);await x.settle();
  const old=await x.service.result(root.id);
  const body={id:root.id,message:'删除Python，补充附件中的部署经验。电话：13800138000',documents:[{name:'补充项目.docx',text:'使用Docker部署服务。负责容器镜像管理、服务配置和故障排查，并维护自动化发布流程。'.repeat(2)}],budget:.5,shareConfirmed:true,requestId:randomUUID()};
  const next=await x.service.message(body),replay=await x.service.message(body);assert.equal(next.id,replay.id);await x.settle();
  assert.equal(next.sessionId,root.id);assert.equal(next.revision,2);
  const value=await x.service.result(next.id);assert.deepEqual(value.profile.skills.map(s=>s.name),['Docker']);
  const facts=await fs.readFile(path.join(x.directory,'runs',next.id,'resume-redacted.txt'),'utf8');
  assert.ok(!facts.includes('Python'));assert.match(facts,/Docker/);
  assert.equal(requirementCoverage(value.coverage.j1).percentage,0);
  assert.equal(requirementCoverage((await x.service.result(root.id)).coverage.j1).percentage,100);
  assert.deepEqual((await x.service.result(root.id)).profile,old.profile);
  const memory=await x.service.conversation(next.id);assert.equal(memory.messages.length,4);assert.deepEqual(memory.messages[2].attachments,['补充项目.docx']);
  assert.ok(!JSON.stringify(memory).includes('13800138000'));
  const update=x.inputs.find(i=>i.prompt===profileUpdatePrompt);assert.match(update.body.current_profile.skills[0].name,/Python/);assert.ok(!JSON.stringify(update).includes('13800138000'));
  assert.equal((await x.service.status()).runs.length,1);
  await x.service.close();
  const restarted=x.createService();assert.equal((await restarted.conversation(next.id)).messages.length,4);
  const third=await restarted.message({...body,id:next.id,message:'保留现在的能力，突出实际职责',documents:[],requestId:randomUUID()});
  for(let i=0;i<300&&restarted.busy;i++)await new Promise(r=>setTimeout(r,10));
  assert.equal((await restarted.result(third.id)).run.status,'completed');
  const last=x.inputs.filter(i=>i.prompt===profileUpdatePrompt).at(-1);
  assert.ok(!last.body.evidence_pool.includes('Python'),'removed facts must not return as evidence in later rounds');
  await restarted.close();
});

test('conversation rejects stale branches, invalid evidence and parameter replays',async()=>{
  const x=await setup(),root=await x.service.start(x.body);await x.settle();
  const body={id:root.id,message:'补充说明：我的Python项目由我负责接口设计与联调。',documents:[],budget:.5,shareConfirmed:true,requestId:randomUUID()};
  const next=await x.service.message(body);await x.settle();const paid=x.stats().requests;
  await assert.rejects(x.service.message({...body,message:'另一个问题'}),/同一请求/);
  await assert.rejects(x.service.message({...body,requestId:randomUUID()}),/更新版本/);
  await assert.rejects(x.service.message({...body,id:next.id,message:'',requestId:randomUUID()}),/填写修改/);
  assert.equal(x.stats().requests,paid);
  assert.equal(redactProfileMessage('我会Docker'),'我会Docker');
  assert.throws(()=>validateProfileUpdate({skills:[{name:'Rust',evidence:'虚构证据'}],projects:[],query_facets:['a','b','c','d'],summary:'a',reply:'已更新'},'真实内容'),/原文/);
  assert.ok(!profileEvidenceText({skills:[],projects:[],business_experience:[],summary:'虚构Rust'}).includes('Rust'));
  const html=matchingConversationHtml({messages:[{role:'user',text:'<script>alert(1)</script>',attachments:['<img>.pdf'],revision:2}]});
  assert.doesNotMatch(html,/<script>|<img>/);assert.match(html,/v2/);
});


test('imported result-only profile can start a new conversation revision without the original CV',async()=>{
  const x=await setup(),root=await x.service.start({...x.body,budget:0});await x.settle();
  const dir=path.join(x.directory,'runs',root.id);
  for(const name of ['profile.json','resume-redacted.txt','input.json'])await fs.unlink(path.join(dir,name));
  const current=await x.service.conversation(root.id);assert.equal(current.profile.source,'saved-profile-evidence');assert.equal(current.messages.length,2);
  const next=await x.service.message({id:root.id,message:'突出我的接口开发能力',documents:[],shareConfirmed:true,requestId:randomUUID()});await x.settle();
  const result=await x.service.result(next.id);assert.equal(result.run.status,'completed');assert.equal(result.run.revision,2);assert.ok(result.run.estimate>0);assert.equal(result.run.usage.input,1000);
});
