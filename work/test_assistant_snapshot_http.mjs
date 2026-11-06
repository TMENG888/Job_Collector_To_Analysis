import assert from 'node:assert/strict';
import http from 'node:http';
const {createAssistantHandler}=await import('./job_assistant_http.mjs');
let refreshed=0;
const status={available:true,status:'ready',baseline_rows:100,current_rows:119,next_trigger_rows:120,threshold_percent:20};
const handler=createAssistantHandler({metadata:async()=>({revision:2,rows:119}),snapshotStatus:async()=>status,refreshSnapshots:async()=>{refreshed++;return {...status,status:'queued'};},load:async()=>{throw Error('status must not build snapshot');}});
const server=http.createServer(async(req,res)=>{await handler(req,res,new URL(req.url,'http://localhost').pathname);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base='http://127.0.0.1:'+server.address().port;
try{
  assert.deepEqual(await(await fetch(base+'/api/assistant/snapshot')).json(),status);
  assert.deepEqual((await(await fetch(base+'/api/assistant/context?summary=1')).json()).snapshot,status);
  const post=(body,origin)=>fetch(base+'/api/assistant/snapshot',{method:'POST',headers:{'content-type':'application/json',...(origin?{origin}:{})},body:JSON.stringify(body)});
  let response=await post({action:'refresh'});assert.equal(response.status,202);assert.equal((await response.json()).status,'queued');assert.equal(refreshed,1);
  response=await post({action:'refresh',threshold_percent:0});assert.equal(response.status,400);assert.equal(refreshed,1);
  response=await post({action:'refresh'},'https://untrusted.invalid');assert.equal(response.status,403);assert.equal(refreshed,1);
  response=await post({action:'delete'});assert.equal(response.status,400);assert.equal(refreshed,1);
  console.log('PASS snapshot HTTP: read-only status, summary status, explicit refresh, fixed threshold, cross-origin guards; no classification or model requests');
}finally{await new Promise(r=>server.close(r));}
