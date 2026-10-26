import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createPoliteHttpClient,validateDirectHttpEndpoint} from './polite_http_client.mjs';
const url='https://www.shixiseng.com/app/interns/search/v2';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'polite-http-'));
const json=(status=200,headers={})=>new Response('{"code":100,"data":[]}',{status,headers:{'content-type':'application/json',...headers}});
let checks=0,t=100000,active=0,peak=0;
const starts=[],options=[];
const common={stateDir:dir,now:()=>t,wait:async ms=>{t+=ms;},random:()=>0,minimumIntervalMs:1};
const fake=async(u,init)=>{starts.push(t);options.push(init);peak=Math.max(peak,++active);await new Promise(r=>setTimeout(r,5));active--;return json();};
const a=createPoliteHttpClient({...common,fetchImpl:fake}),b=createPoliteHttpClient({...common,fetchImpl:fake});
await Promise.all([a(url),b(url),a(url)]);
assert.equal(peak,1);checks++;
assert.ok(starts.slice(1).every((v,i)=>v-starts[i]>=2500));checks++;
assert.ok(options.every(o=>o.redirect==='manual'));checks++;
for(const bad of ['http://www.shixiseng.com/app/interns/search/v2','https://example.com/','https://a:b@www.shixiseng.com/app/interns/search/v2','https://www.shixiseng.com/other']){assert.throws(()=>validateDirectHttpEndpoint(bad));checks++;}
for(const status of [401,403,429]){
  let calls=0;const client=createPoliteHttpClient({...common,stateDir:path.join(dir,String(status)),attempts:9,fetchImpl:async()=>{calls++;return json(status,{'retry-after':'1800'});}});
  await assert.rejects(client(url),{code:'access_blocked'});await assert.rejects(client(url),{code:'origin_cooldown'});assert.equal(calls,1);checks++;
}
let calls=0;const retry=createPoliteHttpClient({...common,stateDir:path.join(dir,'retry'),attempts:99,fetchImpl:async()=>{calls++;return json(503);}});
await assert.rejects(retry(url));assert.equal(calls,2);checks++;
let brokenCalls=0;const brokenAccess=createPoliteHttpClient({...common,stateDir:path.join(dir,'broken-access'),attempts:2,fetchImpl:async()=>{brokenCalls++;return new Response(new ReadableStream({start(c){c.error(Error('fixture stream failed'));}}),{status:429});}});
await assert.rejects(brokenAccess(url),{code:'access_blocked'});await assert.rejects(brokenAccess(url),{code:'origin_cooldown'});assert.equal(brokenCalls,1);checks++;
for(const [name,response]of [['html',()=>new Response('<html>verify</html>',{headers:{'content-type':'text/html'}})],['invalid',()=>new Response('{broken',{headers:{'content-type':'application/json'}})],['business',()=>new Response('{"code":403}',{headers:{'content-type':'application/json'}})]]){
  let calls=0;const client=createPoliteHttpClient({...common,stateDir:path.join(dir,name),fetchImpl:async()=>{calls++;return response();}});
  await assert.rejects(client(url));
  if(name==='invalid'){
    // 纯解析失败：只短退避，不写跨任务长冷却；同轮允许有界重试。
    await assert.rejects(client(url),{code:'invalid_response'});
    assert.ok(calls>=1);
  }else{
    await assert.rejects(client(url),{code:'origin_cooldown'});
    assert.equal(calls,1);
  }
  checks++;
}
const oversized=createPoliteHttpClient({...common,stateDir:path.join(dir,'large'),maxResponseBytes:4,fetchImpl:async()=>json()});
await assert.rejects(oversized(url),{code:'response_too_large'});checks++;
for(const type of ['text/plain','text/html','application/octet-stream']){
  const client=createPoliteHttpClient({...common,stateDir:path.join(dir,'mime-'+type.replaceAll('/','-')),fetchImpl:async()=>new Response('{"code":100,"msg":{"data":[]}}',{headers:{'content-type':type}})});
  assert.equal((await (await client(url)).json()).code,100);checks++;
}
const ssrUrl='http://job.mohrss.gov.cn/cjobs/jobinfolist/listJobinfolist';
const html='<input id="findjoblist" value="[{&quot;acb200&quot;:&quot;1&quot;,&quot;acb22a&quot;:&quot;负责访问验证和人机验证产品的开发测试&quot;}]"><input id="pageNo" value="1"><input id="totalpages" value="1"><input id="totalcount" value="1">';
const ssr=createPoliteHttpClient({...common,stateDir:path.join(dir,'ssr'),fetchImpl:async()=>new Response(html,{headers:{'content-type':'text/html'}})});
assert.equal(await (await ssr(ssrUrl)).text(),html);checks++;
await assert.rejects(ssr(ssrUrl,{headers:{cookie:'fixture'}}),{code:'DIRECT_HTTP_REQUIRED'});checks++;
assert.throws(()=>validateDirectHttpEndpoint('http://job.mohrss.gov.cn/other'));checks++;
let badSsrCalls=0;const badSsr=createPoliteHttpClient({...common,stateDir:path.join(dir,'bad-ssr'),fetchImpl:async()=>{badSsrCalls++;return new Response('<html>missing expected data</html>');}});
await assert.rejects(badSsr(ssrUrl));await assert.rejects(badSsr(ssrUrl),{code:'origin_cooldown'});assert.equal(badSsrCalls,1);checks++;
const zhaopin=createPoliteHttpClient({...common,stateDir:path.join(dir,'zp-verification'),fetchImpl:async()=>new Response('{"code":200,"data":{"isVerification":1,"list":[]}}',{headers:{'content-type':'application/json'}})});
await assert.rejects(zhaopin('https://fe-api.zhaopin.com/c/i/search/positions'),{code:'verification_required'});await assert.rejects(zhaopin('https://fe-api.zhaopin.com/c/i/search/positions'),{code:'origin_cooldown'});checks++;
let redirects=0;const redirect=createPoliteHttpClient({...common,stateDir:path.join(dir,'redirect'),fetchImpl:async()=>{redirects++;return new Response(null,{status:302,headers:{location:'https://example.com'}});}});
await assert.rejects(redirect(url));assert.equal(redirects,1);checks++;
// Independent OS processes share the same per-origin lock and request clock.
const moduleUrl=new URL('./polite_http_client.mjs',import.meta.url).href,events=path.join(dir,'events.jsonl'),processState=path.join(dir,'process');
const script=`import fs from 'node:fs/promises';import {createPoliteHttpClient} from ${JSON.stringify(moduleUrl)};await createPoliteHttpClient({stateDir:${JSON.stringify(processState)},jitterMs:0,fetchImpl:async()=>{await fs.appendFile(${JSON.stringify(events)},JSON.stringify({at:Date.now(),pid:process.pid})+'\\n');return new Response('{}',{headers:{'content-type':'application/json'}});}})(${JSON.stringify(url)});`;
await Promise.all([1,2].map(()=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--input-type=module','-e',script],{windowsHide:true,stdio:['ignore','ignore','pipe']});let err='';child.stderr.on('data',x=>err+=x);child.on('error',reject);child.on('close',code=>code?reject(Error(err)):resolve());})));
const eventsRead=(await fs.readFile(events,'utf8')).trim().split('\n').map(JSON.parse);
assert.equal(new Set(eventsRead.map(e=>e.pid)).size,2);assert.ok(eventsRead[1].at-eventsRead[0].at>=2450);checks++;
const persisted=await fs.readFile(path.join(dir,(await fs.readdir(dir)).find(n=>n.endsWith('.json'))),'utf8');assert.ok(!/authorization|cookie|body|keyword/i.test(persisted));checks++;
console.log(`PASS polite HTTP: ${checks} checks; single-origin serialization across tasks/processes, >=2.5s, bounded retries/body, cooldown and no browser/redirect fallback. Fixtures only.`);
