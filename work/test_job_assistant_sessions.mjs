import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createAssistantSessionStore} from './job_assistant_sessions.mjs';
import {createChatAgent} from './job_assistant_chat.mjs';
import {createAssistantIndex} from './job_decision_assistant.mjs';
import {createAssistantHandler} from './job_assistant_http.mjs';
import http from 'node:http';

const directory=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-sessions-test-'));
const protect=async(operation,value)=>operation==='encrypt'?Buffer.from(value).toString('base64'):Buffer.from(value,'base64').toString();
const observations=Array.from({length:6},(_,i)=>({row_no:i+2,job_id:String(i),job_name:'智能体工程师',city:i<3?'北京':'上海',experience:'1-3年',education:'本科',skills:['Python','RAG'],salary_midpoint_k:20+i}));
const index=createAssistantIndex({role:'智能体/大模型应用',generated_at:'test',cohort_observations:observations},observations.map(j=>({...j,job_description:'使用Python开发RAG智能体应用'})));
const repo=createAssistantSessionStore(directory,{protect}),agent=createChatAgent({repository:repo});
let second,server;
try{
  const first=await agent.run(index,{message:'北京、三年经验、本科的岗位有哪些？',useModel:false});
  const other=await agent.run(index,{message:'上海岗位有哪些？',useModel:false});
  assert.notEqual(first.conversationId,other.conversationId);assert.equal((await agent.list()).length,2);
  assert.equal((await agent.view(first.conversationId)).turns.length,1);
  await agent.rename(first.conversationId,'北京智能体岗位');assert.equal((await agent.view(first.conversationId)).title,'北京智能体岗位');
  await agent.run(index,{conversationId:first.conversationId,message:'简历：Python。private-resume-marker',useModel:false});
  const record=await repo.read(first.conversationId);assert.ok(!JSON.stringify(record).includes('private-resume-marker'));assert.equal(record.state.resume,undefined);
  const file=await fs.readFile(path.join(directory,first.conversationId+'.json'),'utf8');assert.ok(!file.includes('北京'));assert.ok(!file.includes('Python'));assert.ok(!file.includes('private-resume-marker'));
  agent.close();
  const secondRepo=createAssistantSessionStore(directory,{protect});second=createChatAgent({repository:secondRepo});
  const follow=await second.run(index,{conversationId:first.conversationId,message:'继续看岗位',useModel:false});
  assert.equal(follow.filters.city,'北京');assert.equal(follow.filters.candidate_education,'本科');assert.equal(follow.filters.years,3);assert.equal(follow.has_resume,false);
  const alternate=await second.run(index,{conversationId:other.conversationId,message:'继续看岗位',useModel:false});assert.equal(alternate.filters.city,'上海');assert.equal(alternate.filters.candidate_education,undefined);
  assert.equal((await second.view(first.conversationId)).turns.length,3);
  await secondRepo.withLock(first.conversationId,async()=>{await assert.rejects(repo.withLock(first.conversationId,()=>Promise.resolve()),/正在处理/);});
  await assert.rejects(repo.read('../model'),/编号无效/);await assert.rejects(second.rename(first.conversationId,''),/1–80/);
  await second.remove(other.conversationId);assert.equal((await second.list()).length,1);await assert.rejects(second.view(other.conversationId),/不存在/);
  await assert.rejects(second.run(index,{conversationId:other.conversationId,message:'继续',useModel:false}),/删除/);
  await second.restore(other.conversationId);assert.equal((await second.list()).length,2);assert.equal((await second.view(other.conversationId)).turns.length,2);
  const handler=createAssistantHandler({load:async()=>index},null,{repository:repo});server=http.createServer(async(req,res)=>{if(!await handler(req,res,new URL(req.url,'http://localhost').pathname)){res.writeHead(404);res.end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  const post=body=>fetch(base+'/api/assistant/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  let response=await fetch(base+'/api/assistant/sessions');assert.equal(response.status,200);assert.equal((await response.json()).persistent,true);
  response=await post({action:'read',id:first.conversationId});assert.equal(response.status,200);assert.equal((await response.json()).title,'北京智能体岗位');
  response=await fetch(base+'/api/assistant/sessions',{headers:{origin:'https://evil.example'}});assert.equal(response.status,403);
  response=await post({action:'read',id:'../../model'});assert.equal(response.status,400);
  response=await post({action:'rename',id:first.conversationId,title:'新的名称'});assert.equal(response.status,200);
  response=await post({action:'delete',id:other.conversationId});assert.equal(response.status,200);response=await post({action:'restore',id:other.conversationId});assert.equal(response.status,200);
  const tampered=JSON.parse(file);tampered.data=tampered.data.slice(0,-4)+'AAAA';await fs.writeFile(path.join(directory,first.conversationId+'.json'),JSON.stringify(tampered));
  await assert.rejects(repo.read(first.conversationId),/解密或校验失败/);
  console.log('PASS: encrypted transcripts, resume exclusion, restart continuation, independent filters, shared-service lease, rename, recoverable deletion, session APIs, origin/path validation and tamper detection');
}finally{
  agent.close();second?.close();if(server)await new Promise(resolve=>server.close(resolve));
  // Only the exact mkdtemp-created fixture is removed, never application data.
  assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(directory).startsWith('assistant-sessions-test-'));
  await fs.rm(directory,{recursive:true,force:true});
}
