// Explicit read-only audit: no collection, raw mutation or persistent chats.
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {createKnowledgeAssistantStore} from './job_decision_assistant.mjs';
import {createChatAgent} from './job_assistant_chat.mjs';
import {createAssistantCredentialStore} from './job_assistant_credentials.mjs';
if(!process.argv.includes('--read-only'))throw new Error('必须显式传入 --read-only');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),dataDir=path.join(root,'ui_data');
const db=new DatabaseSync(path.join(dataDir,'knowledge','岗位知识库.sqlite'),{readOnly:true});
db.exec('PRAGMA busy_timeout=10000');
const fingerprint=()=>{const h=createHash('sha256');for(const r of db.prepare('SELECT job_key,content_hash,raw,observation FROM jobs ORDER BY job_key').iterate())h.update(JSON.stringify(r));return h.digest('hex');};
const before=fingerprint(),old=db.prepare('SELECT job_key,observation FROM jobs').all();
const start=Date.now(),index=await createKnowledgeAssistantStore(dataDir,{readOnly:true}).load();
const oldByKey=new Map(old.map(r=>[r.job_key,JSON.parse(r.observation)]));
const salaryCorrected=index.jobs.filter(j=>oldByKey.get(j.key)?.salary_midpoint_k!==j.salary_midpoint_k).length;
const removedAgent=index.jobs.filter(j=>oldByKey.get(j.key)?.role_families?.includes('智能体/大模型应用')&&!j.role_families.includes('智能体/大模型应用')).length;
const agent=createChatAgent({getModel:()=>createAssistantCredentialStore(path.join(dataDir,'assistant_private','model.json')).load()});
try{
  let turn=await agent.run(index,{message:'智能体秋招一天报价多少？',useModel:false});
  turn=await agent.run(index,{conversationId:turn.conversationId,message:'广州深圳，仲恺农业工程学院，27届毕业',useModel:false});
  assert.deepEqual(turn.goal.cities,['广州','深圳']);assert.equal(turn.goal.graduation_year,2027);assert.equal(turn.goal.education,undefined);assert.equal(turn.task.status,'waiting_for_user');
  turn=await agent.run(index,{conversationId:turn.conversationId,message:'本科',useModel:process.argv.includes('--model')});
  if(process.argv.includes('--model'))assert.equal(turn.execution,'model','live benchmark model must not silently fall back');
  assert.equal(turn.result.salary_benchmark.segments.length,2);
  assert.ok(turn.result.sources.every(s=>s.education!=='博士'&&s.education!=='硕士'));
  assert.ok(!turn.result.sources.some(s=>s.key==='K0547a4ed72b4bd5c733180fe'));
  assert.equal(fingerprint(),before,'source records and stored observations must remain byte-identical');
  console.log(JSON.stringify({revision:index.report.revision,cache_key:index.cacheKey,indexed_jobs:index.jobs.length,load_ms:Date.now()-start,
    data_quality:index.report.data_quality,derived_salary_changed_rows:salaryCorrected,derived_agent_role_removed_rows:removedAgent,
    raw_and_stored_observations_unchanged:true,goal:turn.goal,task:turn.task,execution:turn.execution,model_requests:turn.model_run?.requests,error:turn.model_run?.error_code,
    segments:turn.result.salary_benchmark.segments.map(s=>({city:s.city,role:s.role,matched_jobs:s.matched_jobs,benchmark_jobs:s.benchmark_jobs,excluded:s.excluded,groups:s.groups,suggestion:s.suggestion})),
    trace:turn.trace.map(t=>({tool:t.tool,origin:t.origin,rows:t.rows})),answer:turn.answer},null,2));
  if(process.argv.includes('--tool-loop')){
    const follow=await agent.run(index,{message:'请按顺序使用工具：先查看数据准入报告，再分别检索广州和深圳的2027届本科智能体秋招岗位，补查合格岗位的JD，然后根据工具结果回答两个城市各有什么合格岗位及待确认项。不要使用实习岗位或硕博门槛岗位填充结果。'});
    console.log(JSON.stringify({live_tool_loop:{execution:follow.execution,requests:follow.model_run?.requests,error:follow.model_run?.error_code,trace:follow.trace.map(t=>({tool:t.tool,status:t.status,origin:t.origin})),answer:follow.answer}},null,2));
    assert.equal(follow.execution,'model');assert.ok(follow.trace.filter(t=>t.origin==='model'&&t.status==='ready').length>=2,'must execute multiple real model-selected tools');
  }
}finally{agent.close();db.close();}
