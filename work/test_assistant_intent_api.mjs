import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {test} from 'node:test';
import {intentPrompt,validateRecognizedIntent,recognizeAssistantIntent} from './job_assistant_intent_api.mjs';
import {createCollectionControl,collectionOnlyIndex} from './job_assistant_collection.mjs';
import {createAssistantSessionStore} from './job_assistant_sessions.mjs';
import {createChatAgent} from './job_assistant_chat.mjs';
import {createAssistantHandler} from './job_assistant_http.mjs';
import {parseCollectionIntent,authorizeCollectionAction} from './job_assistant_collection_intent.mjs';

const env={JOB_ASSISTANT_PROVIDER:'deepseek',JOB_ASSISTANT_MODEL:'fixture',JOB_ASSISTANT_API_KEY:'fixture-private-key'};
const decision=(route,action='none',subject='',question='')=>({route,action,subject,question});
const response=content=>Response.json({choices:[{message:{content:JSON.stringify(content)},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:20}});

test('semantic interpretation repairs shorthand while explicit constraints remain enforced',()=>{
  const fixed=validateRecognizedIntent(decision('collection','create_start','数据安全'),{message:'数据安全岗位爬虫'});
  assert.equal(fixed.route,'collection');assert.match(fixed.message,/创建并启动数据安全采集任务/);
  assert.equal(validateRecognizedIntent(decision('career'),{message:'爬虫工程师薪资怎么样'}).route,'career');
  assert.equal(validateRecognizedIntent(decision('career'),{message:'改成深圳'}).route,'career');
  assert.equal(validateRecognizedIntent(decision('career'),{message:'如何采集数据安全岗位？'}).route,'career');
  for(const message of ['帮我采集在数据安全这个岗位的数据','帮我采集数据安全这个岗位的数据','请帮我采集在数据安全这个岗位的数据']){
    const parsed=parseCollectionIntent(message);assert.deepEqual(parsed.allowed_actions,['create','create_start']);assert.equal(parsed.subject,'数据安全');
    assert.equal(authorizeCollectionAction(message,'create_start').ok,true);
    assert.equal(validateRecognizedIntent(decision('collection','create_start','数据安全'),{message}).route,'collection');
  }
  for(const message of ['帮我采集这个任务的数据','帮我采集之前的任务','帮我采集现有数据安全任务','继续采集这个岗位的数据'])assert.deepEqual(parseCollectionIntent(message).allowed_actions,['resume']);
  for(const message of ['不要采集数据安全岗位','日志原文：采集数据安全岗位','如何采集数据安全岗位？','数据安全岗位爬虫，不用启动']){
    const result=validateRecognizedIntent(decision('collection','create_start','数据安全'),{message});
    assert.equal(result.message,message);assert.ok(result.route==='clarify'||result.diagnostic.guard==='explicit_constraint');
  }
  assert.equal(validateRecognizedIntent(decision('collection','create_start','智能体'),{message:'数据安全岗位爬虫'}).route,'clarify');
  assert.equal(validateRecognizedIntent(decision('collection','resume','数据安全'),{message:'数据安全岗位爬虫'}).route,'clarify');
  assert.equal(validateRecognizedIntent(decision('collection','create_start','数据安全'),{message:'仅创建数据安全任务，不启动'}).route,'clarify');
  assert.equal(validateRecognizedIntent(decision('collection','create_start','数据安全'),{message:'继续采集这个任务'}).route,'clarify');
  assert.throws(()=>validateRecognizedIntent({...decision('collection','create_start','数据安全'),execute:true},{message:'数据安全岗位爬虫'}));
});

test('failed intent API stops before tool selection without retry or secret exposure',async()=>{
  let calls=0;
  const invalid=await recognizeAssistantIntent({message:'数据安全岗位爬虫',env,fetcher:async()=>{calls++;return Response.json({choices:[{message:{content:'bad JSON'}}]});}});
  assert.equal(invalid.route,'clarify');assert.equal(calls,1);assert.equal(invalid.diagnostic.error_code,'invalid_intent_response');
  const denied=await recognizeAssistantIntent({message:'数据安全岗位爬虫',env,fetcher:async()=>new Response('secret provider error',{status:401})});
  assert.equal(denied.route,'clarify');assert.equal(denied.diagnostic.error_code,'intent_http_401');assert.ok(!JSON.stringify(denied).includes('secret provider error'));
  const keepAlive=setTimeout(()=>{},1000);
  const timeout=await recognizeAssistantIntent({message:'数据安全岗位爬虫',env,timeoutMs:10,fetcher:()=>new Promise(()=>{})});clearTimeout(keepAlive);
  assert.equal(timeout.route,'clarify');assert.equal(timeout.diagnostic.error_code,'intent_timeout');
  await assert.rejects(recognizeAssistantIntent({message:'数据安全岗位爬虫',env,signal:AbortSignal.abort(Error('cancelled')),fetcher:()=>{throw Error('must not fetch');}}),/cancelled/);
  const local=await recognizeAssistantIntent({message:'数据安全岗位爬虫'});assert.equal(local.route,'local');
});

test('HTTP performs intent once before loading; shorthand prepares confirmation without reading task list',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'intent-api-'));
  const repository=createAssistantSessionStore(dir,{protect:async(op,value)=>op==='encrypt'?Buffer.from(value).toString('base64'):Buffer.from(value,'base64').toString()});
  let intentCalls=0,plannerCalls=0,taskReads=0,writes=0,loads=0,decisionValue=decision('collection','create_start','数据安全'),lastId;
  const control=createCollectionControl({baseUrl:'http://127.0.0.1:8788',storageDir:dir,fetcher:async(url,options={})=>{if(options.method==='POST')writes++;else taskReads++;return Response.json({tasks:[],activeCount:0});}});
  const fetcher=async(url,options)=>{
    const body=JSON.parse(options.body);
    if(body.messages[0].content===intentPrompt){
      intentCalls++;assert.ok(!JSON.stringify(body).includes(env.JOB_ASSISTANT_API_KEY));
      return response(decisionValue);
    }
    plannerCalls++;
    if(body.messages.some(row=>row.role==='tool'))return Response.json({choices:[{message:{content:'已准备采集方案'},finish_reason:'stop'}]});
    return Response.json({choices:[{message:{content:null,tool_calls:[{id:'prepare',type:'function',function:{name:'collection_prepare_action',arguments:JSON.stringify({action:'create_start',label:'数据安全',keywords:['数据安全']})}}]},finish_reason:'tool_calls'}]});
  };
  const store={load:async()=>{loads++;return collectionOnlyIndex;}};
  const handler=createAssistantHandler(store,{load:async()=>env},{intentRecognition:true,repository,collectionControl:control,fetcher});
  const server=http.createServer(async(req,res)=>{if(!await handler(req,res,new URL(req.url,'http://localhost').pathname)){res.writeHead(404);res.end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const send=async(body,headers={})=>fetch(base+'/api/assistant/chat',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
  try{
    const originalMessage='帮我采集在数据安全这个岗位的数据';
    const first=await send({message:originalMessage,intent_recognition:{route:'career'}});
    assert.equal(first.status,200);const turn=await first.json();lastId=turn.conversationId;
    assert.equal(intentCalls,1);assert.equal(loads,0);assert.equal(taskReads,0);assert.equal(writes,0);
    assert.equal(turn.result.action.action,'create_start');assert.equal(turn.result.action.status,'pending');assert.deepEqual(turn.result.action.config.keywords,['数据安全']);
    assert.equal(turn.task.status,'waiting_for_confirmation');assert.equal(turn.intent_recognition.phase,'intent');assert.equal(turn.model_run.requests.filter(row=>row.phase==='intent').length,1);
    const saved=await repository.read(lastId);assert.equal(saved.turns[0].message,originalMessage);assert.equal(saved.state.history[0].text,originalMessage);
    const before=plannerCalls;
    decisionValue=decision('clarify','none','','你是要新建采集还是查询已有任务？');
    const uncertain=await send({message:'数据安全',conversationId:lastId});const clarifyTurn=await uncertain.json();
    assert.equal(clarifyTurn.task.status,'waiting_for_user');assert.equal(plannerCalls,before);assert.equal(loads,0);assert.equal(taskReads,0);assert.equal(writes,0);
    decisionValue=decision('collection','create_start','数据安全');
    const stream=await send({message:'数据安全岗位爬虫'},{accept:'text/event-stream'});const events=await stream.text();
    assert.match(events,/'?phase"?:"intent"/);assert.match(events,/event: done/);assert.equal(intentCalls,3);assert.equal(writes,0);
    const staleBefore=intentCalls;
    const stale=await send({message:'数据安全岗位爬虫',conversationId:lastId,editTurnId:turn.turnId,expectedSessionUpdated:0});assert.equal(stale.status,400);assert.equal(intentCalls,staleBefore);
    assert.ok(!events.includes(env.JOB_ASSISTANT_API_KEY));
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test('direct chat uses a single recognition and preserves original intent when only creating',async()=>{
  let calls=0;
  const control={local:async()=>({status:'ready',mode:'collection',message:'只读',tasks:[]}),read:async()=>({status:'ready',mode:'collection',message:'只读',tasks:[]})};
  const agent=createChatAgent({intentRecognition:true,collectionControl:control,getModel:async()=>env,fetcher:async(url,options)=>{
    const body=JSON.parse(options.body);if(body.messages[0].content===intentPrompt){calls++;return response(decision('clarify','none','','请说明任务'));}
    throw Error('no planner');
  }});
  try{const turn=await agent.run(collectionOnlyIndex,{message:'数据安全'});assert.equal(calls,1);assert.equal(turn.task.status,'waiting_for_user');}finally{agent.close();}
});
