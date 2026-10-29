import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {writeNativeChannelRows} from './collector_native_sink.mjs';
const root=path.resolve(import.meta.dirname,'..'),dir=await fs.mkdtemp(path.join(os.tmpdir(),'collection-recovery-http-'));
const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
const child=spawn(process.execPath,['job_collector_ui/server.mjs',String(port)],{cwd:root,env:{...process.env,JOB_UI_DATA_DIR:dir,JOB_UI_OPEN_BROWSER:'0',JOB_TASK_OUTPUT_ROOT:path.join(dir,'outputs'),JOB_TASK_BACKUP_ROOT:path.join(dir,'backups')},windowsHide:true,stdio:['ignore','pipe','pipe']});
let logs='';child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
const base='http://127.0.0.1:'+port;
async function api(route,body){const r=await fetch(base+route,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});const data=await r.json();assert.ok(r.ok,JSON.stringify(data));return data;}
try{
 let ready=false;for(let i=0;i<100;i++){try{await api('/api/tasks');ready=true;break;}catch{await new Promise(r=>setTimeout(r,100));}}assert.ok(ready,logs);
 const {task}=await api('/api/tasks',{label:'AI漫剧隔离回归',primaryKeyword:'AI漫剧',keywords:['AI漫剧'],cities:['北京'],platforms:['iguopin','zhaopin'],collectUntilExhausted:true});
 const row=(platform,id)=>({platform,job_id:id,job_name:'AI漫剧制作',company_name:'隔离测试',city:'北京',job_url:'https://example.com/'+id,job_description:'负责AI漫剧制作与分镜设计，使用生成式工具完成视频制作。'});
 await writeNativeChannelRows(task.outputDir,task.id,[row('国聘','a'),row('智联招聘','b'),row('智联招聘','c')]);
 await fs.writeFile(path.join(task.outputDir,'采集清单.json'),JSON.stringify({task_id:task.id,total_rows:3,platforms:{iguopin:{rows:1},zhaopin:{rows:2}}}));
 let actual=(await api('/api/tasks/'+encodeURIComponent(task.id))).task;
 assert.equal(actual.metrics.candidates,3);assert.equal(actual.metrics.publicRows,1);assert.equal(actual.metrics.zhaopinRows,2);assert.equal(actual.metrics.knowledgeRows,3);assert.equal(actual.metrics.liveCollection.platformCounts.iguopin,1);assert.equal(actual.metrics.liveCollection.platformCounts.zhaopin,2);
 assert.equal(actual.metrics.jobStats.scope,'jobs');assert.equal(actual.metrics.jobStats.rows,3);assert.equal(actual.metrics.validRows,3);
 await writeNativeChannelRows(task.outputDir,task.id,[row('nowcoder','job-only')]);
 actual=(await api('/api/tasks/'+encodeURIComponent(task.id))).task;
 assert.equal(actual.metrics.jobStats.rows,4);assert.equal(actual.metrics.jobStats.channels.find(c=>c.key==='nowcoder').rows,1);assert.equal(actual.metrics.candidates,4);assert.equal(actual.metrics.validRows,4);
 await fs.writeFile(path.join(task.outputDir,'统一采集数据状态.json'),JSON.stringify({task_id:task.id,rows:99999}));
 await fs.writeFile(path.join(task.outputDir,'采集清单.json'),JSON.stringify({task_id:'foreign',total_rows:999,platforms:{zhaopin:{rows:999}}}));
 actual=(await api('/api/tasks/'+encodeURIComponent(task.id))).task;assert.equal(actual.metrics.candidates,4,'foreign manifest cannot inflate count');assert.equal(actual.metrics.knowledgeRows,4,'stale unified report cannot inflate database count');
 const state=await api('/api/tasks');assert.equal(state.activeCount,0);assert.equal(actual.status,'ready');assert.doesNotMatch(logs,/▶ 多平台/);
 console.log('PASS isolated HTTP recovery: real server, integrated manifest does not double-count session rows, owned counts, task never started; '+dir);
}finally{child.kill();await new Promise(r=>{if(child.exitCode!==null)r();else child.once('exit',r);});}
