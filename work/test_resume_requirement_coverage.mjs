import test from 'node:test';
import assert from 'node:assert/strict';
import {coverageVersion,requirementCoverage,coverageRankedJobs,validateRequirements,validateJudgments,assessRequirementJobs,requirementPrompt} from './resume_requirement_coverage.mjs';
const resume='使用Python开发检索系统，负责接口实现与性能优化。';
const requirements=Array.from({length:12},(_,i)=>({id:'r'+(i+1),requirement:'能力'+(i+1),kind:'skill',optional:i>=10,jd_evidence:'岗位明确要求'+(i+1)}));
const assessment={version:coverageVersion,complete:true,summary:'示例',items:requirements.map((r,i)=>({...r,status:i<8||i>=10?'met':i===8?'partial':'not_evidenced',resume_evidence:i===9?'':'使用Python',reason:'证据核对'}))};
test('8 fully met of 10 main requirements is exactly 80%, partial and optional do not inflate it',()=>{
  assert.deepEqual(requirementCoverage(assessment),{total:10,matched:8,partial:1,notEvidenced:1,optional:2,percentage:80});
  assert.equal(requirementCoverage({...assessment,complete:false}),null);
  assert.equal(requirementCoverage({...assessment,items:[]}).percentage,null);
  assert.equal(requirementCoverage({items:assessment.items}),null);
  assert.equal(requirementCoverage({...assessment,items:assessment.items.map(r=>({...r,resume_evidence:''}))}),null);
});
test('coverage order is independent of original logits and other candidates',()=>{
  const jobs=[{key:'a',rank:1,rerank_score:10},{key:'b',rank:2,rerank_score:-5},{key:'c',rank:3,rerank_score:3}];
  const full={...assessment,items:assessment.items.filter(r=>r.status==='met')};
  const cache={a:assessment,b:full};assert.deepEqual(coverageRankedJobs(jobs,cache).map(j=>j.key),['b','a','c']);
  assert.equal(requirementCoverage(full).percentage,100);assert.equal(requirementCoverage(cache.a).percentage,80);assert.equal(requirementCoverage(cache.c),null);assert.deepEqual(jobs.map(j=>j.key),['a','b','c']);
});
test('requirements cannot duplicate or invent JD evidence; judgments cannot change the denominator',()=>{
  const jd='熟悉Python或Java，具备接口开发能力。',jobs=[{key:'a',jd}],r={id:'r1',requirement:'Python或Java至少一种',kind:'skill',optional:false,jd_evidence:'熟悉Python或Java'};
  const extracted=validateRequirements({jobs:[{key:'a',requirements:[r]}]},jobs);assert.equal(extracted.a.length,1);
  assert.throws(()=>validateRequirements({jobs:[{key:'a',requirements:[r,{...r,id:'r2'}]}]},jobs),/重复/);
  assert.throws(()=>validateRequirements({jobs:[{key:'a',requirements:[{...r,jd_evidence:'精通Rust'}]}]},jobs),/原文/);
  const inputs=[{key:'a',requirements:extracted.a}],item={id:'r1',status:'met',resume_evidence:'使用Python',reason:'满足任选项Python'};
  assert.equal(requirementCoverage(validateJudgments({jobs:[{key:'a',summary:'符合',items:[item]}]},inputs,resume).a).percentage,100);
  assert.throws(()=>validateJudgments({jobs:[{key:'a',summary:'符合',items:[]}]},inputs,resume));
  assert.throws(()=>validateJudgments({jobs:[{key:'a',summary:'符合',items:[{...item,resume_evidence:'精通Java'}]}]},inputs,resume),/真实简历证据/);
});
test('extracts requirements without resume, checkpoints before judging, and reuses valid paid work',async()=>{
  let extractions=0,judgments=0,fail=true,saves=0;const cache={},jobs=[{key:'a',title:'研发',jd:'熟悉Python。'}];
  const model={async request(prompt,data){if(prompt===requirementPrompt){extractions++;assert.equal(data.resume,undefined);return {jobs:[{key:'a',requirements:[{id:'r1',requirement:'熟悉Python',kind:'skill',optional:false,jd_evidence:'熟悉Python'}]}]};}
    judgments++;if(fail){fail=false;throw Error('模拟中断');}return {jobs:[{key:'a',summary:'符合',items:[{id:'r1',status:'met',resume_evidence:'使用Python',reason:'有开发实践'}]}]};}};
  const params={jobs,resume,model,budget:{limit:.5,spent:0},cache,onSave:async()=>{saves++;}};
  await assert.rejects(assessRequirementJobs(params),/模拟中断/);assert.equal(cache.a.requirements.length,1);assert.equal(requirementCoverage(cache.a),null);
  await assessRequirementJobs(params);assert.equal(extractions,1);assert.equal(judgments,2);assert.equal(saves,2);assert.equal(requirementCoverage(cache.a).percentage,100);
  await assessRequirementJobs(params);assert.equal(extractions,1);assert.equal(judgments,2);
});
