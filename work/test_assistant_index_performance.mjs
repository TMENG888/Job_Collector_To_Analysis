import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {EventEmitter} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {createKnowledgeStore} from './job_knowledge_store.mjs';
import {createKnowledgeAssistantStore,createAssistantIndex} from './job_decision_assistant.mjs';
import {createBackgroundAssistantStore} from './assistant_index_loader.mjs';
import {assistantClassificationVersion} from './assistant_classification_cache.mjs';
import {createAssistantHandler} from './job_assistant_http.mjs';
import {requestAssistantStream} from '../job_collector_ui/public/assistant-event-stream.js';
import {readAssistantIndexSnapshot} from './assistant_index_snapshot.mjs';
import {createChatAgent} from './job_assistant_chat.mjs';

const dir=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-index-test-'));
const cacheDir=path.join(dir,'derived-cache'),store=createKnowledgeStore(dir);
await store.sync({tasks:[],refresh:false});
const body='岗位职责：负责构建智能体与RAG知识库，开发多智能体编排服务；搭建检索增强生成系统，开发工具调用接口和多轮对话流程，将大模型能力集成到业务应用中，负责应用部署及效果评估。任职要求：本科，Python LangChain LLM。支持自研插件协议。';
const hash=text=>createHash('sha256').update(text).digest('hex');
function update(fn){const db=new DatabaseSync(store.filename);try{db.exec('BEGIN');fn(db);db.exec("UPDATE metadata SET value=CAST(value AS INTEGER)+1 WHERE key='revision'; COMMIT");}finally{db.close();}}
update(db=>{
  db.prepare('INSERT INTO tasks VALUES(?,?,?,?)').run('fixture','隔离岗位',0,dir);
  for(let i=0;i<20;i++){
    const raw=JSON.stringify({platform:'zhaopin',job_id:String(i),job_name:'智能体开发工程师',job_description:body,salary:'20-30K',city:'广州',education:'本科'}),key=`K${String(i).padStart(24,'0')}`;
    db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?)').run(key,'zhaopin',String(i),hash(raw),raw,'{}',new Date().toISOString());
    db.prepare('INSERT INTO memberships VALUES(?,?,?)').run('fixture',key,'fixture');
  }
});
const direct=await createKnowledgeAssistantStore(dir,{readOnly:true,background:false}).load();
let threaded=createKnowledgeAssistantStore(dir,{readOnly:true,cacheDir});
const progress=[],first=await threaded.load({onProgress:p=>progress.push(p)});
assert.deepEqual(first.jobs,direct.jobs);assert.deepEqual(first.frequencies,direct.frequencies);assert.deepEqual(first.tokenSets,direct.tokenSets);
assert.deepEqual(first.indexBuild,{reused:0,classified:20,total:20});
assert.ok(progress.some(p=>p.phase==='index_classifying'&&p.completed===20));
assert.strictEqual(await threaded.load(),first,'unchanged memory index must be reused');threaded.close();
threaded=createKnowledgeAssistantStore(dir,{readOnly:true,cacheDir});
const restarted=await threaded.load();assert.deepEqual(restarted.indexBuild,{reused:20,classified:0,total:20});assert.equal(restarted.indexCache,'disk');
assert.equal(await readAssistantIndexSnapshot(cacheDir,restarted.report.revision,'other-knowledge-database'),null,'snapshot cannot cross database scopes');
update(db=>{const row=db.prepare('SELECT job_key,raw FROM jobs ORDER BY job_key LIMIT 1').get(),raw=JSON.stringify({...JSON.parse(row.raw),company_name:'已更新公司'});db.prepare('UPDATE jobs SET raw=?,content_hash=? WHERE job_key=?').run(raw,hash(raw),row.job_key);});
assert.deepEqual((await threaded.load()).indexBuild,{reused:19,classified:1,total:20},'only changed content is classified');
// Approved labels are deliberately outside the raw-classification cache.
const firstKey='K'+'0'.repeat(24);
update(db=>{const row=db.prepare('SELECT content_hash FROM jobs WHERE job_key=?').get(firstKey);db.prepare('INSERT INTO labels VALUES(?,?,?,?,?)').run('test-label',firstKey,row.content_hash,'approved',JSON.stringify({skills:['自研插件协议'],evidence_json:[{label_type:'skill',label:'自研插件协议',quote:'支持自研插件协议'}]}));});
let index=await threaded.load();assert.equal(index.indexBuild.classified,0);assert.ok(index.jobs.find(j=>j.key===firstKey).skills.includes('自研插件协议'));
update(db=>db.prepare("UPDATE labels SET state='withdrawn' WHERE label_id='test-label'").run());
index=await threaded.load();assert.equal(index.indexBuild.classified,0);assert.ok(!index.jobs.find(j=>j.key===firstKey).skills.includes('自研插件协议'));
threaded.close();
// A corrupted entry or a different classifier/implementation contract is a miss.
let cache=new DatabaseSync(path.join(cacheDir,'classifications.sqlite'));
cache.prepare('UPDATE observations SET observation=? WHERE job_key=?').run('{}',firstKey);cache.close();
update(()=>{});
threaded=createKnowledgeAssistantStore(dir,{readOnly:true,cacheDir});assert.equal((await threaded.load()).indexBuild.classified,1);threaded.close();
cache=new DatabaseSync(path.join(cacheDir,'classifications.sqlite'));cache.prepare('UPDATE observations SET pipeline=? WHERE job_key=?').run('old-model-contract',firstKey);cache.close();
update(()=>{});
threaded=createKnowledgeAssistantStore(dir,{readOnly:true,cacheDir});assert.equal((await threaded.load()).indexBuild.classified,1);threaded.close();
assert.match(assistantClassificationVersion(),/^[a-f0-9]{64}$/);
update(db=>db.prepare("UPDATE tasks SET archived=1 WHERE task_id='fixture'").run());
threaded=createKnowledgeAssistantStore(dir,{readOnly:true,cacheDir});assert.equal((await threaded.load()).jobs.length,0);threaded.close();

const fakeIndex=createAssistantIndex({role:'fixture',generated_at:'fixture',cohort_observations:[]});
const unsupportedAgent=createChatAgent({getModel:async()=>{throw Error('unsupported scope must not call model');}});
const unsupported=await unsupportedAgent.run({...fakeIndex,report:{...fakeIndex.report,knowledge:true,roles:['智能体/大模型应用']}},{message:'目前爬虫岗位大概率会做什么样的业务去赚钱呢'});
assert.match(unsupported.answer,/尚无.*爬虫\/数据采集/);assert.equal(unsupported.task.status,'waiting_for_user');assert.equal(unsupported.trace.length,0);unsupportedAgent.close();
const modelAgent=createChatAgent({getModel:()=>new Promise(()=>{})});
const before=await modelAgent.run(fakeIndex,{message:'查询岗位',useModel:false});
const modelAbort=new AbortController();
const abortingModel=assert.rejects(modelAgent.run(fakeIndex,{message:'继续查询',conversationId:before.conversationId},modelAbort.signal),/本轮已停止/);
await delay(10);modelAbort.abort(new Error('本轮已停止'));await abortingModel;
await modelAgent.run(fakeIndex,{message:'查询岗位',conversationId:before.conversationId,useModel:false});modelAgent.close();
let spawned=0,terminated=0,respond=true;
class FakeWorker extends EventEmitter{
  constructor(){super();spawned++;this.timer=setTimeout(()=>{if(respond)this.emit('message',{type:'result',index:fakeIndex});},100);}
  terminate(){clearTimeout(this.timer);terminated++;return Promise.resolve(0);}
}
const shared=createBackgroundAssistantStore(dir,{cacheDir,WorkerClass:FakeWorker,workerTimeoutMs:1000});
const abort=new AbortController(),one=shared.load({signal:abort.signal}),two=shared.load();
const oneRejected=assert.rejects(one,/已停止|abort/i);await delay(20);abort.abort(new Error('本轮已停止'));
await oneRejected;assert.deepEqual(await two,fakeIndex);assert.equal(spawned,1,'concurrent callers share one build');shared.close();
const single=createBackgroundAssistantStore(dir,{cacheDir,WorkerClass:FakeWorker});const stop=new AbortController();
const cancelled=assert.rejects(single.load({signal:stop.signal}),/本轮已停止/);await delay(20);const prior=terminated;stop.abort(new Error('本轮已停止'));await cancelled;assert.equal(terminated,prior+1,'last cancellation terminates worker');
assert.deepEqual(await single.load(),fakeIndex,'a cancelled build can be retried explicitly');single.close();
respond=false;const bounded=createBackgroundAssistantStore(dir,{cacheDir,WorkerClass:FakeWorker,workerTimeoutMs:40});
await assert.rejects(bounded.load(),/索引构建超时/);bounded.close();respond=true;

// HTTP timeout must cover loading, including implementations ignoring the signal.
let modelRequests=0,loads=0,loadAborts=0;
const neverStore={load:({signal})=>{loads++;signal.addEventListener('abort',()=>loadAborts++,{once:true});return new Promise(()=>{});}};
const handler=createAssistantHandler(neverStore,null,{requestTimeoutMs:150,getModel:async()=>{modelRequests++;return {};}});
const server=http.createServer(async(req,res)=>{if(req.url==='/health'){res.end('ok');return;}await handler(req,res,new URL(req.url,'http://localhost').pathname);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
try{
  let received=false;const events=[];
  const timed=assert.rejects(requestAssistantStream(base+'/api/assistant/chat',{message:'爬虫岗位做什么业务'},event=>{events.push(event);received=true;}),/本轮请求超过/);
  await delay(30);assert.equal(await (await fetch(base+'/health')).text(),'ok');await timed;
  assert.equal(received,true);assert.ok(events.find(e=>e.phase==='routing'));assert.equal(loadAborts,1);assert.equal(modelRequests,0);
  const response=await fetch(base+'/api/assistant/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:'岗位需求'})});assert.equal(response.status,504);
  const client=new AbortController();let loading;
  const entered=new Promise(resolve=>loading=resolve);
  const cancelledHttp=assert.rejects(requestAssistantStream(base+'/api/assistant/chat',{message:'岗位需求'},event=>{if(event.phase==='loading')loading();},{signal:client.signal}),/已停止/);
  await entered;client.abort();await cancelledHttp;await delay(30);assert.equal(loadAborts,3);
  assert.equal(loads,3);assert.equal(modelRequests,0,'no model requests may start after loading timeout/cancellation');
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
console.log(JSON.stringify({passed:true,workerParity:true,restartCache:true,incrementalContent:true,labelApprovalAndWithdrawal:true,corruptCacheMiss:true,contractInvalidation:true,archivedExcluded:true,concurrencyAndCancellation:true,workerTimeout:true,httpWholeRequestTimeout:true,earlyProgress:true,paidModelRequests:0,productionWrites:0}));
