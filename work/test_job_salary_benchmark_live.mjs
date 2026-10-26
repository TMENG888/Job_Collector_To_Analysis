// Explicit opt-in, read-only production snapshot. No persisted chat or collection calls.
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createKnowledgeAssistantStore} from './job_decision_assistant.mjs';
import {createChatAgent} from './job_assistant_chat.mjs';
import {createAssistantCredentialStore} from './job_assistant_credentials.mjs';
if(!process.argv.includes('--read-only'))throw new Error('需显式传入 --read-only；--model 另行允许少量模型请求');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),dataDir=path.join(root,'ui_data');
const index=await createKnowledgeAssistantStore(dataDir,{readOnly:true}).load();
const agent=createChatAgent({getModel:()=>createAssistantCredentialStore(path.join(dataDir,'assistant_private','model.json')).load()});
try{
  let turn=await agent.run(index,{message:'找智能体实习岗位',resume:'求职意向：智能体实习生\n2027届本科在校生\n专业技能：Python、RAG、LLM。',useModel:false});
  turn=await agent.run(index,{conversationId:turn.conversationId,message:'一天大概我能报价多少钱？我要找秋招岗位，只看北京',useModel:process.argv.includes('--model')});
  assert.equal(turn.goal.stage,'campus');assert.equal(turn.goal.graduation_year,2027);assert.equal(turn.goal.salary_period,'month');
  assert.equal(turn.result.mode,'salary_benchmark');assert.ok(turn.result.sources.every(s=>!/实习/.test(s.title)&&s.employment_type!=='实习'));
  console.log(JSON.stringify({revision:index.report.revision,indexed_jobs:index.jobs.length,goal:turn.goal,execution:turn.execution,
    trace:turn.trace.map(t=>({tool:t.tool,origin:t.origin,rows:t.rows})),model_requests:turn.model_run?.requests,error:turn.model_run?.error_code,
    salary_benchmark:turn.result.salary_benchmark,answer:turn.answer},null,2));
}finally{agent.close();}
