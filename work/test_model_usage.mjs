import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRecruiterModel} from './job-recruiter-model.mjs';
import {assistantUsage} from './model_usage.mjs';

test('legacy zero cost cap cannot block requests; valid and invalid outputs both retain billed usage',async()=>{
  const base='E:/Codex/temp/20261118-unlimited-usage';await fs.mkdir(base,{recursive:true});
  const runtimeDir=await fs.mkdtemp(path.join(base,'model-'));let calls=0;
  const model=createRecruiterModel({runtimeDir,dataDir:runtimeDir,credentials:{status:async()=>({configured:true,provider_id:'deepseek'}),load:async()=>({JOB_ASSISTANT_PROVIDER:'deepseek',JOB_ASSISTANT_MODEL:'deepseek-flash',JOB_ASSISTANT_API_KEY:'test-key'})},
    fetcher:async()=>{calls++;return Response.json({model:'mock',usage:{prompt_tokens:1000,completion_tokens:200},choices:[{finish_reason:'stop',message:{content:calls===1?'{}':'invalid JSON'}}]});}});
  const account={limit:0,spent:0};
  const value=await model.request('fixture',{}, {budget:account});assert.equal(value._usage.input,1000);assert.equal(value._usage.output,200);assert.ok(account.spent>account.limit);
  await assert.rejects(model.request('fixture',{}, {budget:account}),/非JSON/);
  const usage=(await model.status()).usage;assert.equal(calls,2);assert.equal(usage.input,2000);assert.equal(usage.output,400);assert.ok(Math.abs(usage.estimate-.0112)<1e-12);assert.equal(usage.unknown,0);
});

test('assistant aggregates intent and answer requests and does not report missing usage as zero',()=>{
  const usage=assistantUsage({provider:'deepseek',model:'deepseek-flash',requests:[{phase:'intent',prompt_tokens:100,completion_tokens:20},{prompt_tokens:1000,completion_tokens:200},{error_code:'timeout'}]});
  assert.equal(usage.input,1100);assert.equal(usage.output,220);assert.equal(usage.unknown,1);assert.ok(Math.abs(usage.estimate-.00616)<1e-12);
  const qwen=assistantUsage({provider:'qwen',model:'qwen3.8-flash',requests:[{prompt_tokens:1000,completion_tokens:1000}]});assert.ok(Math.abs(qwen.estimate-.0035)<1e-12);
  assert.equal(assistantUsage({provider:'qwen',model:'unknown-model',requests:[{prompt_tokens:1,completion_tokens:1}]}).estimate,null);
});
