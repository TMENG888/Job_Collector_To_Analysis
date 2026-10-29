import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {writeNativeChannelRows} from './collector_native_sink.mjs';
import {taskJobStatistics} from './task_job_statistics.mjs';
import {collectionCounts} from './collection_counts.mjs';
import {collectionProgress,collectionStatusLabel,collectionTaskSummary} from '../job_collector_ui/public/collection-progress.js';
import {renderCollectionDashboard} from '../job_collector_ui/public/collection-dashboard.js';
import {renderInterviewPanel} from '../job_collector_ui/public/interview-tools.js';
import {formatCollectionFlowLog} from '../job_collector_ui/public/collection-flow-log.js';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'job-statistics-')),id='statistics-test';
const format={number:n=>Number(n).toLocaleString('en-US'),escapeHtml:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;')};
const row=(platform,job_id)=>({platform,job_id,job_name:'测试工程师',company_name:'测试公司',city:'北京',job_url:'https://example.com/jobs/'+job_id,job_description:'负责测试工程平台建设及自动化质量保障，维护测试用例。'});
try{
 const flow=formatCollectionFlowLog('[目标执行结束] search_queue_exhausted；有效去重3582条，候选入库3858条。\n[目标续轮] 第1轮；有效去重3582条；接口可访问范围采集\n[错误] job51 返回验证页面');
 assert.doesNotMatch(flow,/3582|3858/);assert.match(flow,/search_queue_exhausted/);assert.match(flow,/接口可访问范围采集/);assert.match(flow,/job51 返回验证页面/);
 assert.equal(await taskJobStatistics(dir,id),null);
 await fs.writeFile(path.join(dir,'任务归属.json'),JSON.stringify({task_id:id}));
 await writeNativeChannelRows(dir,id,[row('国聘','1'),row('nowcoder','2'),{...row('猎聘','3'),job_description:''}]);
 // Independent article store must not affect any job statistic.
 const articles=new DatabaseSync(path.join(dir,'interviews.sqlite'));articles.exec('CREATE TABLE posts(id INTEGER PRIMARY KEY); INSERT INTO posts VALUES(1),(2),(3)');articles.close();
 let stats=await taskJobStatistics(dir,id);assert.equal(stats.rows,3);assert.equal(stats.completeRows,2);assert.equal(stats.incompleteRows,1);
 assert.equal(stats.channels.reduce((n,c)=>n+c.rows,0),stats.rows);assert.equal(stats.channels.reduce((n,c)=>n+c.completeRows,0),stats.completeRows);
 assert.equal(stats.channels.find(c=>c.key==='nowcoder').rows,1);
 // SQLite may initialise empty WAL sidecars on its first read; allow that
 // revision to settle, then verify repeated reads share the snapshot.
 stats=await taskJobStatistics(dir,id);
 assert.equal(await taskJobStatistics(dir,id),stats,'unchanged revision reuses cache');
 await assert.rejects(taskJobStatistics(dir,'foreign'),/归属/);
 const task={id,status:'partial',currentStage:'',collectUntilExhausted:true,targetRows:null,platforms:['iguopin','liepin'],message:'旧统计候选9999，有效7777',interviews:{enabled:true,status:'completed',candidates:862,details:860},metrics:{knowledgeRows:3,validRows:7777,candidates:9999,publicRows:9999,jobStats:stats,liveCollection:{platformCounts:{iguopin:9999,nowcoder:1}},channelVerification:{},channelDiagnostics:{}}};
 let html=renderCollectionDashboard(task,format);assert.match(html,/牛客岗位/);assert.match(html,/资料完整/);assert.match(html,/待补全/);assert.doesNotMatch(html,/9999|7777|862|860|公开渠道|最终交付|去重入库|候选岗位|多平台采集/);
 assert.equal(collectionProgress(task).count,3);assert.equal(collectionProgress(task).percent,null);assert.equal(collectionStatusLabel(task),'本轮已结束');assert.doesNotMatch(collectionTaskSummary(task),/9999|7777/);
 assert.match(html,/data-statistics-scope="jobs"/);assert.match(html,/<td>牛客岗位<\/td><td>1 条<\/td><td>1<\/td>/);
 assert.match(html,/<th scope="row">合计<\/th><td>3 条<\/td><td>2<\/td>/);
 const interviewHtml=renderInterviewPanel(task,format);assert.match(interviewHtml,/data-statistics-scope="interviews"/);assert.match(interviewHtml,/862/);assert.match(interviewHtml,/860/);assert.match(interviewHtml,/待补正文/);assert.doesNotMatch(interviewHtml,/9,999|7,777|时效半衰期|采集目标/);
 assert.equal(collectionCounts({native:{platformCounts:{iguopin:1,liepin:1,nowcoder:1}}}).candidates,3);
 // Writes after the task finished must invalidate the snapshot, even though
 // task.validRows and task.message remain unchanged.
 await writeNativeChannelRows(dir,id,[row('猎聘','3'),row('智联招聘','4')]);
 stats=await taskJobStatistics(dir,id);assert.equal(stats.rows,4);assert.equal(stats.completeRows,4);assert.equal(stats.incompleteRows,0);
 html=renderCollectionDashboard({...task,metrics:{...task.metrics,jobStats:stats}},format);assert.match(html,/<th scope="row">合计<\/th><td>4 条<\/td><td>4<\/td>/);
 const empty={...task,metrics:{knowledgeRows:0,jobStats:null,jobStatsError:'blocked'}};html=renderCollectionDashboard(empty,format);assert.match(html,/统计暂不可用/);assert.match(html,/—/);assert.doesNotMatch(html,/7777|9,999/);
 console.log('PASS job statistics: authoritative live SQLite, revision cache, post-finish updates, task isolation, channel totals, hidden Nowcoder jobs, independent article store/UI, stale snapshot rejection, unavailable state.');
}finally{assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));await fs.rm(dir,{recursive:true,force:true});}
