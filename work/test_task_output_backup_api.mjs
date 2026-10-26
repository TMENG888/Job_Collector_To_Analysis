import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {writeJsonAtomic} from './collector_storage.mjs';
import {writeNativeChannelRows} from './collector_native_sink.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'task-backup-api-'));
const portProbe=net.createServer();await new Promise(resolve=>portProbe.listen(0,'127.0.0.1',resolve));const port=portProbe.address().port;await new Promise(resolve=>portProbe.close(resolve));
const server=spawn(process.execPath,[path.join(root,'job_collector_ui/server.mjs'),String(port)],{cwd:root,env:{...process.env,JOB_UI_DATA_DIR:dataDir,JOB_UI_PORT:String(port),JOB_TASK_BACKUP_ROOT:path.join(dataDir,'task_backups'),JOB_TASK_OUTPUT_ROOT:path.join(dataDir,'task_outputs')},windowsHide:true,stdio:['ignore','pipe','pipe']});
let logs='';server.stdout.on('data',chunk=>logs+=chunk);server.stderr.on('data',chunk=>logs+=chunk);
const base=`http://127.0.0.1:${port}`,post=(url,body)=>fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
try{
  let ready=false;for(let i=0;i<80;i++){try{if((await fetch(base+'/api/tasks')).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}assert.ok(ready,logs);
  let response=await post('/api/tasks',{label:'目录恢复隔离测试',primaryKeyword:'测试工程师',keywords:['测试工程师'],cities:['北京'],targetRows:10,platforms:['shixiseng']});assert.equal(response.status,201,await response.clone().text());const {task}=await response.json();
  assert.ok(task.outputDir.startsWith(path.join(dataDir,'task_outputs')+path.sep));
  const checkpoint=path.join(task.outputDir,'断点数据','shixiseng_fixture.json');await fs.mkdir(path.dirname(checkpoint));await writeJsonAtomic(checkpoint,{task_id:task.id,list:[],details:{},completed:false});
  await writeNativeChannelRows(task.outputDir,task.id,[{platform:'实习僧',job_id:'one',job_name:'测试工程师'}]);
  const api=`/api/tasks/${encodeURIComponent(task.id)}/output-backup`;
  response=await post(api,{action:'snapshot'});assert.equal(response.status,200,await response.clone().text());
  response=await fetch(base+api);assert.equal(response.status,200);assert.ok((await response.json()).files.some(file=>file.relative==='统一采集数据.sqlite'));
  await fs.rename(task.outputDir,path.join(dataDir,'simulated-lost-source'));
  response=await post(`/api/tasks/${encodeURIComponent(task.id)}/run`,{stage:'all'});assert.notEqual(response.status,202);assert.match(await response.text(),/归属标记缺失/);
  response=await post(api,{action:'restore'});assert.equal(response.status,200,await response.clone().text());assert.ok((await response.json()).restored>=4);
  response=await fetch(base+`/api/tasks/${encodeURIComponent(task.id)}`);const restored=(await response.json()).task;assert.equal(restored.metrics.candidates,1);assert.notEqual(restored.status,'running');
  await fs.writeFile(checkpoint,JSON.stringify({records:['newer']}));response=await post(api,{action:'restore'});assert.notEqual(response.status,200);assert.match(await response.text(),/拒绝覆盖/);
  assert.ok(!logs.includes('▶ 多平台'),'No collection should have started');
  console.log(JSON.stringify({ok:true,dataDir,port,networkRequestsToPlatforms:0,checks:['new task uses persistent internal data root','initial backup created','live checkpoint and SQLite backed up','missing source blocks run API','restore API rebuilds missing directory','task API counts restored data','newer checkpoint not overwritten','real collection never launched']}));
}catch(error){console.error(logs);throw error;}finally{server.kill('SIGTERM');await new Promise(resolve=>server.once('exit',resolve));}
