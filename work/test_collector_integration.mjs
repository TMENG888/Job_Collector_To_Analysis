import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {EventEmitter} from 'node:events';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {collectZhaopinSession} from './direct_zhaopin_session.mjs';
import {hasVerifiedSessionCompletion,sessionAuditStartPage} from './session_pagination_health.mjs';
import {collectionRequestProfile} from './collection_channel_profiles.mjs';
import {createCollectorProgressSink} from './collector_progress_sink.mjs';
import {writeNativeChannelRows,nativeTaskCounts} from './collector_native_sink.mjs';
import {liveCollectionMetrics} from './live_collection_metrics.mjs';
import {collectionCounts} from './collection_counts.mjs';
import {collect51Records} from './job51/collector.mjs';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'collector-integration-')),checks=[];
const city={name:'北京',code:'530'},keyword='fixture';
const root=path.resolve(import.meta.dirname,'..');
const source=execFileSync('git',['show','a4513be:work/direct_zhaopin_session.mjs'],{cwd:root,encoding:'utf8'})
 .replaceAll('import.meta.dirname',JSON.stringify(import.meta.dirname))
 .replace(/from '(\.\/[^']+)'/g,(_m,p)=>`from '${pathToFileURL(path.join(import.meta.dirname,p)).href}'`);
const old=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
async function run(collect,options={}){
 const pages=[];const result=await collect(keyword,city,{session:{cookie:'fixture'},maxPages:3,
 request:async(_url,init)=>{const p=JSON.parse(typeof init.body==='string'?init.body:new TextDecoder().decode(init.body)).pageIndex;pages.push(p);
  const list=Array.from({length:p===1?20:10},(_,i)=>({number:String((p-1)*20+i),name:'fixture'}));
  return new Response(JSON.stringify({code:200,data:{statusCode:200,count:20,list,isEndPage:p===1?0:1}}));},...options});
 return {pages,result};
}
const historical=await run(old.collectZhaopinSession),current=await run(collectZhaopinSession);
assert.equal(historical.result.rows.length,30);assert.equal(current.result.rows.length,30);assert.deepEqual(current.pages,[1,2]);
checks.push('同一响应重放：新版恢复旧版30条，不在估算总数20处截断');
const cap=await run(collectZhaopinSession,{maxPages:1});assert.equal(cap.result.endReached,false);assert.equal(cap.result.nextPage,2);checks.push('达到估算总数但未见末页时仍保留下一页');
const rows=current.result.rows;
const terminal={keyword,city,total:20,rows,completed:true,pagination:current.result.pagination};assert.equal(hasVerifiedSessionCompletion(terminal,'zhaopin'),true);
const countOnly={...terminal,pagination:{...terminal.pagination,page:1,reason:'total_reached',serverEnd:false}};
assert.equal(hasVerifiedSessionCompletion(countOnly,'zhaopin'),false);assert.equal(sessionAuditStartPage(countOnly,'zhaopin'),2);checks.push('旧count终点从已保存页的下一页复核，不重放前缀');
assert.equal(sessionAuditStartPage({...countOnly,pagination:{...countOnly.pagination,rows:999}},'zhaopin'),1,'mismatched count-only cursor must be audited from page 1');
assert.equal(hasVerifiedSessionCompletion({...terminal,pagination:null},'zhaopin'),false);checks.push('旧裸完成标记即使覆盖估算总数也不能证明穷尽');
const pacing=collectionRequestProfile('zhaopin',{minimumIntervalMs:3000,jitterMs:700},{});
assert.equal(pacing.minimumIntervalMs,3000);assert.equal(pacing.burstSize,0);assert.equal(pacing.burstRecoveryMs,0);assert.equal(pacing.attempts,1);checks.push('恢复配置节奏，无默认15分钟强制休息且验证不自动重试');
assert.equal(collectionRequestProfile('zhaopin',{}, {JOB_ZHAOPIN_INTERVAL_MS:'1'}).minimumIntervalMs,2500);
assert.equal(collectionRequestProfile('zhaopin',{}, {JOB_HTTP_BURST_SIZE:'15'}).burstSize,0);
assert.equal(collectionRequestProfile('zhaopin',{}, {JOB_HTTP_BURST_SIZE:'15',JOB_HTTP_BURST_RECOVERY_MS:'900000'}).burstRecoveryMs,900000);checks.push('最小限速保护及显式突发配置保留');
let clock=0,writes=[];const sink=createCollectorProgressSink({enabled:true,now:()=>clock,write:async batch=>writes.push(batch),intervalMs:15000,maxRows:3});
const item=n=>({platform:'智联招聘',job_id:String(n),job_name:'fixture'});
await sink.append([item(1)]);assert.equal(writes.length,1);await sink.append([item(2),item(2)]);assert.equal(sink.pending,1);
clock=15000;await sink.append([item(3)]);assert.equal(writes.length,2);assert.equal(writes[1].length,2);checks.push('增量入库按间隔去重批量提交，避免逐卡备份整库');
await sink.append([item(4)]);await sink.flush();assert.equal(sink.pending,0);checks.push('结束或异常路径可强制提交最后一批');
const failure=createCollectorProgressSink({enabled:true,write:async()=>{throw Error('output blocked')}});await assert.rejects(failure.append([item(9)]),/output blocked/);assert.equal(failure.pending,1);checks.push('入库失败不吞掉未提交批次');
const task={id:'owned',outputDir:dir};await fs.writeFile(path.join(dir,'任务归属.json'),JSON.stringify({task_id:task.id}));
const native=createCollectorProgressSink({enabled:true,write:batch=>writeNativeChannelRows(dir,task.id,batch)});await native.append([item(1),item(2)]);assert.equal((await nativeTaskCounts(dir,task.id)).platformCounts.zhaopin,2);checks.push('真实SQLite批量落盘及时更新渠道入库计数');
await fs.mkdir(path.join(dir,'断点数据'));
await fs.writeFile(path.join(dir,'断点数据/zhaopin_session_fixture_北京.json'),JSON.stringify({task_id:task.id,rows:[item(1),item(2),item(3)]}));
await fs.writeFile(path.join(dir,'断点数据/zhaopin_session_foreign_北京.json'),JSON.stringify({task_id:'other',rows:[item(99)]}));
const live=await liveCollectionMetrics(task);assert.equal(live.platformCounts.zhaopin,3);assert.equal(live.publicRows,0);
assert.equal(collectionCounts({native:await nativeTaskCounts(dir,task.id),live}).candidates,3);checks.push('智联断点实时计数、跨来源去重及任务隔离，不重复加入公开渠道数');
async function job51(name,start=1){
 let currentPage=1;const pages=[],methods=[],page=new EventEmitter();let url='about:blank';
 const emit=p=>{currentPage=p;pages.push(p);queueMicrotask(()=>page.emit('response',{url:()=>`https://we.51job.com/api/job/search-pc?pageNum=${p}`,status:()=>200,text:async()=>JSON.stringify({status:'1',resultbody:{job:{totalCount:20,items:Array.from({length:20},(_,i)=>({jobId:String((p-1)*20+i),jobName:'fixture'}))}}})}));};
 page.url=()=>url;page.goto=async value=>{url=value};page.close=async()=>{};page.screenshot=async()=>{};
 page.locator=selector=>selector==='.btn-next'?{count:async()=>1,isEnabled:async()=>currentPage<(start===1?2:start),click:async()=>{methods.push('next');emit(currentPage+1)}}:{filter(){return this},allInnerTexts:async()=>[],innerText:async()=>''};
 page.evaluate=async(_fn,args)=>{if(args.operation==='session_client_ready')return true;methods.push('client');emit(args.pageNo);return {ok:true};};
 const file=path.join(dir,name+'.json');if(start>1)await fs.writeFile(file,JSON.stringify({records:[],total:100,completed:false,nextPageNo:start,lastCompletedPage:start-1}));
 await collect51Records(keyword,city,{checkpointPath:file,contextFactory:async()=>({newPage:async()=>page,close:async()=>{}}),wait:async()=>{}});
 return {pages,methods,saved:JSON.parse(await fs.readFile(file,'utf8'))};
}
const natural=await job51('next');assert.deepEqual(natural.pages,[1,2]);assert.deepEqual(natural.methods,['client','next']);assert.equal(natural.saved.records.length,40);assert.equal(natural.saved.pagination.reason,'website_end');assert.equal(hasVerifiedSessionCompletion(natural.saved,'job51'),true);checks.push('前程无忧恢复官网连续翻页，下一页可用时不被估算总数截断');
const resumed=await job51('resume',5);assert.deepEqual(resumed.pages,[5]);assert.deepEqual(resumed.methods,['client']);assert.equal(resumed.saved.completed,true);checks.push('前程无忧断点第5页直接定位，不重放前4页');
const report={at:new Date().toISOString(),status:'PASS',checks:checks.length,items:checks,fixtures:dir};console.log(JSON.stringify(report,null,2));
if(process.env.COLLECTOR_INTEGRATION_TEST_REPORT)await fs.writeFile(process.env.COLLECTOR_INTEGRATION_TEST_REPORT,JSON.stringify(report,null,2));
