import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {collect51Records} from './job51/collector.mjs';
import {collectZhaopinSession} from './direct_zhaopin_session.mjs';
import {hasVerifiedSessionCompletion,sessionCompletionNeedsAudit} from './session_pagination_health.mjs';
import {zhaopinSessionCheckpointState} from './zhaopin_session_checkpoint.mjs';
import {checkpointSearchState,readCollectionSearchQueue} from './collection_search_queue.mjs';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'session-pagination-'));
const city={name:'北京',code:'530'},keyword='test',checks=[];
const row51=n=>({jobId:String(n),jobName:'fixture'}),rowZp=n=>({number:String(n),name:'fixture'});
const range=(a,b,fn)=>Array.from({length:b-a},(_,i)=>fn(a+i));
async function job51(name,handler,{saved,maxPages=100,maxRows=Infinity}={}){
  const file=path.join(dir,name+'.json');if(saved)await fs.writeFile(file,JSON.stringify(saved));
  const page=new EventEmitter();let url='about:blank';const requested=[];
  page.url=()=>url;page.goto=async value=>{url=value};page.close=async()=>{};page.screenshot=async()=>{};
  page.locator=()=>({filter(){return this},allInnerTexts:async()=>[],innerText:async()=>''});
  page.evaluate=async(_fn,args)=>{
    if(args.operation==='session_client_ready')return true;
    requested.push(args.pageNo);
    queueMicrotask(()=>page.emit('response',{url:()=>`https://we.51job.com/api/job/search-pc?pageNum=${args.pageNo}`,status:()=>200,text:async()=>{
      const result=await handler(args.pageNo);return typeof result==='string'?result:JSON.stringify({status:'1',resultbody:{job:result}});
    }}));return {ok:true};
  };
  let result,error;
  try{result=await collect51Records(keyword,city,{checkpointPath:file,maxPages,maxRows,contextFactory:async()=>({newPage:async()=>page,close:async()=>{}}),wait:async()=>{}});}catch(e){error=e;}
  return {file,requested,result,error,saved:JSON.parse(await fs.readFile(file,'utf8').catch(()=>JSON.stringify(saved||{})))};
}
let r=await job51('short-pages',p=>({totalCount:100,items:range((p-1)*5,p*5,row51)}));
assert.equal(r.requested.length,20);assert.equal(r.saved.records.length,100);assert.equal(hasVerifiedSessionCompletion(r.saved,'job51'),true);checks.push('100条每页5条持续20页，不再第一页完成');
r=await job51('contradictory-empty',p=>({totalCount:100,items:p===1?range(0,5,row51):[]}));
assert.equal(r.error.code,'pagination_stalled');assert.equal(r.saved.completed,false);assert.equal(r.saved.nextPageNo,2);assert.equal(r.saved.records.length,5);checks.push('正总数提前空页保留当前页和5条数据');
r=await job51('repeated',()=>({totalCount:100,items:range(0,5,row51)}));
assert.equal(r.error.code,'pagination_stalled');assert.deepEqual(r.requested,[1,2]);assert.equal(r.saved.nextPageNo,2);checks.push('重复页不采完且有界停止');
r=await job51('valid-empty',()=>({totalCount:0,items:[]}));assert.equal(hasVerifiedSessionCompletion(r.saved,'job51'),true);checks.push('经新响应确认的零结果正常完成');
r=await job51('legacy-short',p=>({totalCount:10,items:p===1?range(0,5,row51):range(5,10,row51)}),{saved:{completed:true,records:range(0,5,row51),total:10,nextPageNo:2,lastCompletedPage:1}});
assert.deepEqual(r.requested,[1,2]);assert.equal(r.saved.records.length,10);assert.equal(hasVerifiedSessionCompletion(r.saved,'job51'),true);checks.push('仅复核旧短页完成条件，旧记录无损');
r=await job51('legacy-covered',()=>{throw Error('不得联网');},{saved:{completed:true,records:range(0,10,row51),total:10}});assert.equal(r.requested.length,0);checks.push('正总数已由稳定ID覆盖的旧完成断点不重放');
r=await job51('page-budget',p=>({totalCount:100,items:range((p-1)*5,p*5,row51)}),{maxPages:2});assert.equal(r.saved.completed,false);assert.equal(r.saved.nextPageNo,3);assert.equal(checkpointSearchState('job51',r.saved,{maxPages:2}),'page_limit');checks.push('分页保护不是采集完成');
const cap=await job51('row-budget',()=>({totalCount:5,items:range(0,5,row51)}),{maxRows:2});assert.equal(cap.saved.nextPageNo,1);assert.equal(cap.saved.nextCardIndex,2);assert.equal(cap.saved.completed,false);
r=await job51('row-resume',()=>({totalCount:5,items:range(0,5,row51)}),{saved:cap.saved});assert.equal(r.saved.records.length,5);assert.equal(r.saved.completed,true);checks.push('单页中途限额与卡片偏移恢复无丢失');
r=await job51('verification',()=>'<html>安全验证</html>');assert.equal(r.error.code,'verification_required');assert.equal(r.saved.completed,false);assert.equal(r.saved.nextPageNo,1);checks.push('验证仍停止，不将验证视为空结果');
r=await job51('duplicates',p=>({totalCount:6,items:p===1?range(0,3,row51):[row51(2),row51(3),row51(4)]}));assert.equal(r.saved.records.length,5);assert.equal(r.saved.pagination.reason,'observed_total_reached');assert.equal(hasVerifiedSessionCompletion(r.saved,'job51'),true);checks.push('连续页原始条数证据区分真实重复和漏采');
r=await job51('normal-resume',p=>({totalCount:4,items:range(2,4,row51)}),{saved:{records:range(0,2,row51),total:4,completed:false,nextPageNo:2,lastCompletedPage:1}});assert.deepEqual(r.requested,[2]);assert.equal(r.saved.completed,true);checks.push('已中断但未完成的条件保留原页码');
let calls=[];const progress=[];
const request=handler=>async(_url,init)=>{const p=JSON.parse(new TextDecoder().decode(init.body)).pageIndex;calls.push(p);return new Response(JSON.stringify(await handler(p)));};
const zpBody=(list,total,end)=>({code:200,data:{statusCode:200,count:total,list,isEndPage:end?1:0}});
const options={session:{cookie:'fixture'},maxPages:5,onProgress:async p=>progress.push(p)};
let z=await collectZhaopinSession(keyword,city,{...options,request:request(p=>zpBody(p===1?range(0,2,rowZp):range(2,4,rowZp),20,p===2))});
let cp={keyword,city,completed:z.endReached,total:z.total,rows:z.rows,pagination:z.pagination};assert.equal(hasVerifiedSessionCompletion(cp,'zhaopin'),true);assert.equal(z.pagination.reason,'server_end');assert.equal(progress.at(-1).completed,true);assert.equal(progress.at(-1).nextPage,null);checks.push('智联服务端末页标志逐页持久化，可解释小于总数的末页');
const corrupt={...cp,pagination:{...cp.pagination,cityCode:'999'}};assert.equal(hasVerifiedSessionCompletion(corrupt,'zhaopin'),false);checks.push('末页证据必须绑定原查询条件');
assert.equal(sessionCompletionNeedsAudit({completed:true,total:20,rows:[{job_id:'1'}]},'zhaopin'),true);assert.equal(zhaopinSessionCheckpointState({completed:true,total:20,rows:[{job_id:'1'}]},{}),'pending');checks.push('旧智联不足总数的完成断点不再永久跳过');
calls=[];z=await collectZhaopinSession(keyword,city,{...options,maxRows:2,request:request(()=>zpBody(range(0,5,rowZp),5,true))});assert.equal(z.nextPage,1);assert.equal(z.endReached,false);assert.equal(z.pagination.consumedAll,false);assert.equal(progress.at(-1).nextPage,1);checks.push('智联末页只消费一部分时不能标记完成或跳下一页');
calls=[];z=await collectZhaopinSession(keyword,city,{...options,seenIds:z.rows.map(r=>r.job_id),request:request(()=>zpBody(range(0,5,rowZp),5,true))});assert.equal(z.rows.length,3);assert.equal(z.endReached,true);checks.push('智联部分页恢复跳过已保存ID，补齐剩余3条');
calls=[];await assert.rejects(collectZhaopinSession(keyword,city,{...options,request:request(()=>zpBody(range(0,2,rowZp),100,false))}),{code:'pagination_stalled'});assert.deepEqual(calls,[1,2]);checks.push('智联重复分页停止而不伪报耗尽');
calls=[];let savedBeforeVerification;
await assert.rejects(collectZhaopinSession(keyword,city,{...options,onProgress:async p=>{savedBeforeVerification=p},request:request(p=>p===1?zpBody(range(0,2,rowZp),100,false):{code:200,data:{isVerification:1}})}),{code:'verification_required'});assert.equal(savedBeforeVerification.nextPage,2);assert.equal(savedBeforeVerification.completed,false);checks.push('智联验证中断保留成功页与下一页');
calls=[];z=await collectZhaopinSession(keyword,city,{...options,startPage:4,seenIds:['a'],maxPages:4,request:request(()=>zpBody([rowZp(7)],100,false))});assert.deepEqual(calls,[4]);assert.equal(z.nextPage,5);assert.equal(z.pageLimitReached,true);checks.push('智联正常断点第4页续采不回退到第1页');
// Real scheduler integration: preserve task and query ownership, and leave
// suspect checkpoints behind the source cooldown rather than requesting them.
const task={id:'owned',outputDir:dir,publicConfigPath:path.join(dir,'public.json'),platforms:['zhaopin'],primaryKeyword:keyword,keywords:[keyword],cities:[city.name]};
await fs.writeFile(task.publicConfigPath,JSON.stringify({task_id:task.id,platforms:{zhaopin:{enabled:true,cities:[city],maxPages:60}}}));
await fs.mkdir(path.join(dir,'断点数据'),{recursive:true});
const suspect={task_id:task.id,keyword,city,total:20,completed:true,nextPage:null,rows:[{job_id:'1'}],acquisition_mode:'session_json_api'};
await fs.writeFile(path.join(dir,'断点数据',`zhaopin_session_${keyword}_${city.name}.json`),JSON.stringify(suspect));
let queue=await readCollectionSearchQueue(task,{rateStateDir:null,channelAvailable:()=>true});assert.equal(queue[0].state,'pending');assert.equal(queue[0].auditRequired,true);checks.push('调度器实际读取旧智联断点并标记仅本条件需复核');
const {createHash}=await import('node:crypto');const rates=path.join(dir,'rates');await fs.mkdir(rates);
await fs.writeFile(path.join(rates,createHash('sha256').update('https://fe-api.zhaopin.com').digest('hex').slice(0,24)+'.json'),JSON.stringify({cooldownUntil:Date.now()+600000}));
queue=await readCollectionSearchQueue(task,{rateStateDir:rates,channelAvailable:()=>true});assert.equal(queue[0].state,'origin_cooldown');assert.equal(queue[0].auditRequired,true);checks.push('需要复核的旧断点仍服从共享冷却');
const foreign=await job51('foreign-query',()=>{throw Error('不应调用');},{saved:{keyword:'other',city,completed:true,total:1,records:[row51(1)]}});assert.equal(foreign.error.code,'TASK_OUTPUT_OWNERSHIP');assert.equal(foreign.requested.length,0);checks.push('前程无忧错查询断点拒绝加载');
const report={result:'PASS',count:checks.length,checks,directory:dir};
console.log(JSON.stringify(report,null,2));
if(process.env.PAGINATION_TEST_REPORT)await fs.writeFile(process.env.PAGINATION_TEST_REPORT,JSON.stringify(report,null,2));
