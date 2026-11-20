import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {normalizeJobFields,PROCESSING_HASH} from './job_processing_rules.mjs';
import {queryProcessingRows,queryProcessingDetail,runJobProcessing} from './job_processing.mjs';
import {processingDirectory,readProcessingBatch} from './job_processing_cache.mjs';
import {createKnowledgeStore} from './job_knowledge_store.mjs';
import {createKnowledgeHandler} from './job_knowledge_http.mjs';
import {readClassifierRows} from './insight-supervised.mjs';
import {renderWorkflow,renderProcessingDetail} from '../job_collector_ui/public/source-workflow.js';
import {createInsightSnapshotLoader} from '../job_collector_ui/public/insight-snapshot-client.js';
const root='E:/Codex/temp/20261119-job-processing';await fs.mkdir(root,{recursive:true});
const body='岗位职责：负责Python数据分析与自动化开发，维护SQL报表和数据处理流程，协作完成指标分析与质量核对。';
async function fixture(){
  const base=await fs.mkdtemp(path.join(root,'case-')),tasks=[];
  for(const id of ['a','b']){const outputDir=path.join(base,id);await fs.mkdir(outputDir);await fs.writeFile(path.join(outputDir,'任务归属.json'),JSON.stringify({task_id:id}));
    const db=new DatabaseSync(path.join(outputDir,'统一采集数据.sqlite'));db.exec('CREATE TABLE metadata(task_id TEXT);CREATE TABLE jobs(platform TEXT,job_id TEXT,data TEXT,PRIMARY KEY(platform,job_id));');db.prepare('INSERT INTO metadata VALUES(?)').run(id);
    const rows=[{platform:'智联招聘',job_id:'shared',job_name:'数据分析工程师',job_description:body,company_name:'公司甲',city:'深圳市',education:'本科',experience:'1-3年',salary:'200-300元/天'}];
    if(id==='a')rows.push({platform:'智联招聘',job_id:'negotiable',job_name:'分析100%_指标',job_description:body,city:'广州市',salary:'面议',education:'13',experience:'15'},{platform:'智联招聘',job_id:'missing',job_name:'待补充岗位',job_description:'请先登录后查看岗位详情',city:'未知',salary:'500K/月'});
    for(const row of rows)db.prepare('INSERT INTO jobs VALUES(?,?,?)').run(row.platform,row.job_id,JSON.stringify(row));db.close();tasks.push({id,label:id==='a'?'数据分析':'其他任务',outputDir});}
  await fs.writeFile(path.join(base,'tasks.json'),JSON.stringify(tasks));
  const store=createKnowledgeStore(base);await store.sync({refresh:false});return {base,tasks,store,database:store.filename,cacheFile:path.join(processingDirectory(base),'processing.sqlite')};
}
test('shared cleaning preserves unknowns and salary semantics, and exposes independent usability',()=>{
  const day=normalizeJobFields({platform:'x',job_id:'1',job_name:'岗位',job_description:body,city:'深圳市',education:'13',experience:'15',salary:'200-300元/天'});
  assert.equal(day.fields.salary_min,4350);assert.equal(day.fields.salary_max,6525);assert.equal(day.fields.salary_midpoint_k,5.4375);assert.equal(day.fields.province,'广东');assert.equal(day.fields.education,'未明确');assert.equal(day.fields.experience,'未明确');assert.equal(day.usability.input,true);
  const missing=normalizeJobFields({salary:'面议',city:'未知',job_description:'请先登录后查看岗位详情'});assert.equal(missing.fields.salary_midpoint_k,null);assert.equal(missing.usability.input,false);assert.equal(missing.usability.salary,false);assert.equal(missing.usability.province,false);
  assert.equal(normalizeJobFields({salary:'30万/年'}).salary,null);assert.equal(normalizeJobFields({salary:'500K/月'}).usability.salary,false);
});
test('stage tables share exact identity merging, filters, pagination and complementary body eligibility',async()=>{
  const f=await fixture();const merged=queryProcessingRows(f.database,f.cacheFile,{stage:'merged'});assert.equal(merged.total,3);assert.equal(merged.rows.find(r=>r.jobId==='shared').fields.source_tasks,'数据分析 / 其他任务');
  const cleaned=queryProcessingRows(f.database,f.cacheFile,{stage:'cleaned'});assert.equal(cleaned.total,3);assert.equal(cleaned.rows.find(r=>r.jobId==='shared').fields.province,'广东');
  const ready=queryProcessingRows(f.database,f.cacheFile,{stage:'ready'}),pending=queryProcessingRows(f.database,f.cacheFile,{stage:'issues'});assert.equal(ready.total,2);assert.equal(pending.total,1);assert.equal(ready.total+pending.total,merged.total);
  assert.equal(ready.rows.find(r=>r.jobId==='negotiable').fields.salary_usable,'不参与薪资统计');
  assert.equal(queryProcessingRows(f.database,f.cacheFile,{taskId:'b'}).total,1);assert.equal(queryProcessingRows(f.database,f.cacheFile,{q:'100%_'}).total,1);assert.equal(queryProcessingRows(f.database,f.cacheFile,{q:"' OR 1=1--"}).total,0);
  const pages=[1,2,3].map(page=>queryProcessingRows(f.database,f.cacheFile,{page,pageSize:1}));assert.equal(new Set(pages.flatMap(p=>p.rows.map(r=>r.key))).size,3);
  assert.throws(()=>queryProcessingRows(f.database,f.cacheFile,{stage:'fake'}),/无效/);
});
test('processing saves a versioned batch used by insight readers; repeat reuses results without changing sources',async()=>{
  const f=await fixture();const before=await f.store.read('kb://all',{synchronize:false});
  const run=await runJobProcessing({...f,dataDir:f.base,input:{taskId:'a'},synchronize:false});assert.equal(run.status,'completed');assert.equal(run.completed,3);assert.equal(run.ready,2);assert.equal(run.pending,1);
  const result=queryProcessingRows(f.database,f.cacheFile,{stage:'cleaned'});assert.equal(result.cachedPageRows,3);
  const batch=readProcessingBatch(f.base,run.id);assert.equal(batch.rows.length,2);assert.ok(batch.rows.every(r=>r.knowledge_processing.rulesHash===PROCESSING_HASH));
  const input=`kb://processed/${run.id}`;assert.equal((await readClassifierRows(f.base,input,null)).total,2);assert.equal((await f.store.read(input,{synchronize:false})).rows.length,2);
  assert.deepEqual((await f.store.read('kb://all',{synchronize:false})).rows.map(({knowledge_processing,...r})=>r),before.rows);
  const again=await runJobProcessing({...f,dataDir:f.base,input:{taskId:'b'},synchronize:false});assert.equal(again.reused,1);assert.equal(readProcessingBatch(f.base,again.id).rows.length,1);
  const row=result.rows.find(r=>r.jobId==='shared');const detail=queryProcessingDetail(f.database,f.cacheFile,{stage:'cleaned',key:row.key,contentHash:row.contentHash});assert.equal(detail.raw.salary,'200-300元/天');assert.equal(detail.changes[0].field,'薪资');
  assert.throws(()=>queryProcessingDetail(f.database,f.cacheFile,{taskId:'b',key:result.rows.find(r=>r.jobId==='missing').key}),/没有这条/);assert.throws(()=>queryProcessingDetail(f.database,f.cacheFile,{key:row.key,contentHash:'stale'}),/已更新/);
  // Later source updates cannot silently change a handed-off cleaning batch.
  const db=new DatabaseSync(f.database);const original=JSON.parse(db.prepare('SELECT raw FROM jobs WHERE job_id=?').get('shared').raw);db.prepare('UPDATE jobs SET raw=?,content_hash=? WHERE job_id=?').run(JSON.stringify({...original,salary:'50K/月'}),'new-hash','shared');db.close();
  assert.equal(readProcessingBatch(f.base,run.id).rows.find(r=>r.job_id==='shared').salary,'200-300元/天');
  assert.throws(()=>readProcessingBatch(f.base,randomUUID()),/尚未完成/);
});
test('HTTP exposes processing, validates mutation requests and hands off completed batches without model calls',async()=>{
  const f=await fixture(),handler=createKnowledgeHandler(f.base),server=http.createServer(async(req,res)=>{if(!await handler(req,res,new URL(req.url,'http://localhost').pathname)){res.writeHead(404);res.end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
  try{
    assert.equal((await fetch(origin+'/api/knowledge/processing?stage=ready').then(r=>r.json())).total,2);
    assert.equal((await fetch(origin+'/api/knowledge/processing/run',{method:'POST',body:'{}'})).status,400);
    const response=await fetch(origin+'/api/knowledge/processing/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({taskId:'b'})});assert.equal(response.status,202);
    let run;for(let i=0;i<100;i++){run=(await fetch(origin+'/api/knowledge/processing/status').then(r=>r.json())).run;if(run.status!=='running')break;await new Promise(resolve=>setTimeout(resolve,50));}assert.equal(run.status,'completed',run.error);
    const transfer=await fetch(origin+'/api/knowledge/processing/transfer',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:run.id})}).then(r=>r.json());assert.equal(transfer.inputFile,`kb://processed/${run.id}`);assert.equal(transfer.run.ready,1);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
test('workflow shows actual stages and safely renders before/after evidence',()=>{
  const html=renderWorkflow('cleaned',{raw:4,merged:3,cleaned:3,ready:2});assert.match(html,/aria-selected="true"[^>]*data-source-stage="cleaned"/);assert.match(html,/洞察输入/);
  const raw={job_name:'<script>x</script>',job_description:'<img onerror=1>',job_url:'javascript:alert(1)'};const processed=normalizeJobFields(raw);
  const detail=renderProcessingDetail({raw,processed,origins:[{label:'<b>x</b>'}],changes:[{field:'薪资',before:'<script>x</script>',after:'面议',basis:'不填0'}]});assert.ok(!detail.includes('<script>'));assert.ok(!detail.includes('<img '));assert.ok(!detail.includes('href="javascript:'));assert.match(detail,/清洗前后对照/);
});
test('a new cleaning batch never loads an unrelated historical all-library report before choosing a role',async()=>{
  let applied;const selected={inputFile:'kb://processed/'+randomUUID(),role:''};let calls=0;
  const loader=createInsightSnapshotLoader({selection:()=>selected,apply:next=>applied=next,api:async url=>{calls++;assert.ok(url.includes(encodeURIComponent(selected.inputFile)));return {state:{status:'empty',inputFile:selected.inputFile,role:selected.role},snapshot:null};}});
  await loader.refresh();assert.equal(calls,0);assert.equal(applied.report,null);assert.equal(applied.inputFile,selected.inputFile);
  selected.role='智能体/大模型应用';await loader.refresh();assert.equal(calls,1);assert.equal(applied.inputFile,selected.inputFile);assert.equal(applied.report,null);
});
test('a processed batch reaches the actual insight analyzer with shared salary and provenance fields',async()=>{
  const f=await fixture(),native=new DatabaseSync(path.join(f.tasks[0].outputDir,'统一采集数据.sqlite'));
  const row={platform:'智联招聘',job_id:'embedded',job_name:'嵌入式软件开发工程师',company_name:'样本公司',city:'深圳市',salary:'200-300元/天',education:'本科',experience:'1-3年',employment_type:'实习',job_description:'岗位职责：负责嵌入式软件研发和固件开发，基于STM32进行C++驱动开发，进行RTOS实时任务调试与板级联调。维护设备驱动和串口协议，完成软硬件联合调试和故障排查。任职要求：熟悉Linux与ARM，掌握嵌入式系统的软件开发流程。'};
  native.prepare('INSERT INTO jobs VALUES(?,?,?)').run(row.platform,row.job_id,JSON.stringify(row));native.close();await f.store.sync({refresh:false});
  const run=await runJobProcessing({...f,dataDir:f.base,input:{taskId:'a',q:'嵌入式'},synchronize:false});assert.equal(run.ready,1);
  const uri=`kb://processed/${run.id}`,snapshot=await f.store.snapshot(uri,{synchronize:false}),configFile=path.join(f.base,'config.json'),outputFile=path.join(f.base,'report.json');
  await fs.writeFile(configFile,JSON.stringify({inputFile:snapshot.uri,displayInputFile:uri,role:'嵌入式开发',analysisMode:'full'}));
  await promisify(execFile)(process.execPath,[fileURLToPath(new URL('./analyze_job_market_sample.mjs',import.meta.url)),configFile,outputFile],{env:{...process.env,JOB_UI_DATA_DIR:f.base,TEMP:root,TMP:root},windowsHide:true,timeout:45000,maxBuffer:1000000});
  const report=JSON.parse(await fs.readFile(outputFile,'utf8'));assert.equal(report.total_rows,1);assert.equal(report.sample_rows,1);assert.equal(report.input_file,uri);assert.equal(report.cohort_observations[0].salary_midpoint_k,5.4375);assert.equal(report.cohort_observations[0].province,'广东');assert.equal(report.cohort_observations[0].processing_rules_hash,PROCESSING_HASH);
});
