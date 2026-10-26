import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {createKnowledgeHandler} from './job_knowledge_http.mjs';
import {knowledgeStore} from './job_knowledge_store.mjs';
import {writeNativeChannelRows} from './collector_native_sink.mjs';

const dir=await fs.mkdtemp(path.join(os.tmpdir(),'skill-term-http-')),out=path.join(dir,'task');await fs.mkdir(out);
const task={id:'http-fixture',label:'智能体开发',outputDir:out};
await fs.writeFile(path.join(out,'任务归属.json'),JSON.stringify({task_id:task.id}));await fs.writeFile(path.join(dir,'tasks.json'),JSON.stringify([task]));
const text='岗位职责：使用Neo4j完成智能体图检索。任职要求：熟悉Python开发与LangChain工具编排。';
await writeNativeChannelRows(out,task.id,[{platform:'智联招聘',job_id:'one',job_name:'智能体开发工程师',job_description:text}]);
const store=knowledgeStore(dir);await store.sync({refresh:false});const [job]=await store.termReview.batch({limit:1});
await store.termReview.record(job,[{text:'Neo4j',start:text.indexOf('Neo4j'),end:text.indexOf('Neo4j')+5,score:.9}]);
const handle=createKnowledgeHandler(dir);const server=http.createServer(async(req,res)=>{if(!await handle(req,res,new URL(req.url,'http://localhost').pathname)){res.writeHead(404);res.end();}});
server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
async function request(route,body,headers={}){const response=await fetch(base+route,{...(body===undefined?{}:{method:'POST',body:JSON.stringify(body),headers:{'content-type':'application/json',...headers}}),...(body===undefined?{headers}:{}),signal:AbortSignal.timeout(15000)});return {code:response.status,body:await response.json()};}
const endpoint='/api/knowledge/skill-terms';
try{
  let response=await request(endpoint);assert.equal(response.code,200);assert.equal(response.body.counts.pending,1);const candidate=response.body.items[0];
  assert.equal((await request(endpoint+'/status')).body.model.local_only,true);
  assert.equal((await request(endpoint,undefined,{origin:'https://evil.example'})).code,400);
  assert.equal((await request(endpoint+'/review',{id:candidate.id,decision:'approved'},{origin:'http://127.0.0.1:1'})).code,400,'origin port must match');
  assert.equal((await request(endpoint+'/review',{id:candidate.id,decision:'approved'},{'content-type':'text/plain'})).code,400);
  assert.equal((await request(endpoint+'/review',{id:candidate.id,decision:'approved'},{'sec-fetch-site':'cross-site'})).code,400);
  assert.equal((await request(endpoint+'/review',{id:candidate.id,decision:'approved'},{origin:base})).code,200);
  assert.equal((await request(endpoint+'?state=approved')).body.items.length,1);
  assert.equal((await request(endpoint+'/review',{id:'f'.repeat(64),decision:'approved'})).code,400);
  assert.equal((await request(endpoint+'/scan',{modelPath:'C:/malicious',limit:1})).code,400);
  assert.equal((await request(endpoint+'/scan',{limit:999})).code,400);
  assert.equal((await request(endpoint+'?state=invalid')).code,400);
  assert.equal((await request(endpoint+'?offset=-1')).code,400);
  assert.equal((await request(endpoint+'/review',{id:candidate.id,decision:'pending'})).code,200);
  assert.equal((await store.read()).rows[0].knowledge_approved_skills.length,0);
  const html=await fs.readFile(new URL('../job_collector_ui/public/index.html',import.meta.url),'utf8');assert.match(html,/id="skillTermReview"/);
  const app=await fs.readFile(new URL('../job_collector_ui/public/app.js',import.meta.url),'utf8');assert.match(app,/installSkillTermReview\(\{api,toast\}\)/);
  console.log('PASS: live loopback term API status/list/review/revoke, exact-origin and JSON CSRF guards, input bounds, unknown ID, model-path injection rejection, panel installation');
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
