import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {collectionGoal,collectionOutcome} from './collection_goal.mjs';
import {shouldStopAtTarget} from './coordinator_policy.mjs';
import {knowledgeDatabasePath,storageError} from './knowledge_storage.mjs';
import {runAdaptiveCollection} from './collection_search_queue.mjs';
import {createKnowledgeStore} from './job_knowledge_store.mjs';
import {writeNativeChannelRows} from './collector_native_sink.mjs';
import {taskInsightSource} from './task-insight-source.mjs';

const dir=await fs.mkdtemp(path.join(os.tmpdir(),'open-collection-live-'));
let reader;
try{
  const goal=collectionGoal({});assert.equal(goal.targetRows,null);assert.equal(goal.collectUntilExhausted,true);
  assert.equal(collectionGoal({targetRows:'8000'}).targetRows,8000);
  assert.equal(collectionGoal({targetRows:100000}).candidateTarget,150000);
  assert.throws(()=>collectionGoal({targetRows:0}),/目标数量/);
  assert.throws(()=>collectionGoal({targetRows:1.5}),/目标数量/);
  assert.equal(shouldStopAtTarget({stage:'public',status:'running',valid:60000,target:null}),false);
  assert.equal(collectionOutcome(goal,{valid:60000,reason:'channels_blocked'}).status,'partial');
  assert.equal(collectionOutcome(goal,{valid:60000,reason:'search_queue_exhausted'}).targetReached,false);
  let rounds=0;
  const task={...goal,id:'live',label:'嵌入式软件开发',status:'running',outputDir:path.join(dir,'task'),platforms:['job51'],keywords:['嵌入式软件开发']};
  await fs.mkdir(task.outputDir);
  const outcome=await runAdaptiveCollection({task,count:async()=>60000+rounds,readQueue:async()=>[{platform:'job51',keyword:'嵌入式软件开发',city:{name:'北京'},state:rounds?'source_finished':'pending',progress:String(rounds)}],run:async()=>{rounds++;}});
  assert.equal(rounds,1,'no fabricated count may short-circuit remaining conditions');
  assert.equal(outcome.reason,'search_queue_exhausted');assert.equal(outcome.targetReached,false);
  await fs.writeFile(path.join(task.outputDir,'任务归属.json'),JSON.stringify({task_id:task.id}));
  await fs.writeFile(path.join(dir,'tasks.json'),JSON.stringify([task]));
  // Metadata and the actual database may reside on different volumes.
  const storage=path.join(dir,'data-disk');await fs.mkdir(storage);
  const filename=path.join(storage,'knowledge.sqlite');new DatabaseSync(filename).close();
  await fs.writeFile(path.join(dir,'knowledge-storage.json'),JSON.stringify({database:filename}));
  assert.equal(knowledgeDatabasePath(dir),filename);
  const store=createKnowledgeStore(dir);
  const row=i=>({platform:'智联招聘',job_id:String(i),job_name:'嵌入式软件开发工程师',company_name:'测试公司'+i,city:'北京',salary:'15-25K',education:'本科',experience:'1-3年',job_url:'https://example.com/'+i,job_description:'岗位职责：负责嵌入式软件研发与STM32固件开发，进行RTOS实时任务调试和Linux驱动开发。任职要求：熟悉ARM与C++。'});
  await writeNativeChannelRows(task.outputDir,task.id,[row(1)]);
  await store.sync({refresh:false});
  const pinned=await store.snapshot('kb://task/live');assert.equal(pinned.rows,1);
  // Hold a read transaction: subsequent commits remain WAL-only.
  const native=path.join(task.outputDir,'统一采集数据.sqlite');reader=new DatabaseSync(native,{readOnly:true});reader.exec('BEGIN');
  assert.equal(reader.prepare('SELECT COUNT(*) AS n FROM jobs').get().n,1);
  const stat=await fs.stat(native);
  await writeNativeChannelRows(task.outputDir,task.id,[row(2)]);
  assert.equal((await fs.stat(native)).mtimeMs,stat.mtimeMs,'fixture requires WAL-only change');
  await store.sync({refresh:false});
  assert.equal((await store.read('kb://task/live')).rows.length,2,'WAL commits must enter the knowledge base');
  assert.equal((await store.read(pinned.uri)).rows.length,1,'existing insight snapshots remain pinned');
  assert.equal(reader.prepare('SELECT COUNT(*) AS n FROM jobs').get().n,1,'existing reader remains consistent');
  const transfer=await taskInsightSource(task,{knowledge:true,dataDir:dir});
  assert.equal(transfer.dataset.collecting,true);assert.equal(transfer.dataset.expectedRows,2);
  assert.equal((await fs.readdir(task.outputDir)).some(f=>f.endsWith('.csv')),false);
  const missing=path.join(dir,'missing');await fs.mkdir(missing);
  await fs.writeFile(path.join(missing,'knowledge-storage.json'),JSON.stringify({database:path.join(missing,'not-there.sqlite')}));
  assert.throws(()=>knowledgeDatabasePath(missing),/不会创建替代空库/);
  assert.match(storageError(new Error('database or disk is full')).message,/数据盘空间不足/);
  console.log('PASS: optional goals, no false target stop, remaining conditions, external storage, missing-disk refusal, WAL-only live sync, pinned snapshots and running-task insight transfer without CSV');
}finally{
  reader?.close();
  await fs.rm(dir,{recursive:true,force:true});
}
