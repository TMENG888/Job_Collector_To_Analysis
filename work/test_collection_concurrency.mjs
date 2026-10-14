import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runChannels,withAccountLock,loadShixiDetailCache,reuseShixiDetails} from './collection_concurrency.mjs';

let active=0,peak=0,release;
const gate=new Promise(resolve=>release=resolve),started=[];
const results=await runChannels(['slow','broken','third'],2,async key=>{
  started.push(key);active++;peak=Math.max(peak,active);
  if(started.length===2)release();
  try {await gate;if(key==='broken')throw new Error('blocked');return key;}finally{active--;}
});
assert.equal(peak,2);assert.equal(results.length,3);
assert.ok(results.find(row=>row.item==='broken').error);
assert.equal(results.find(row=>row.item==='third').value,'third');
let stop=false;
assert.equal((await runChannels([1,2,3],1,async()=>{stop=true;},()=>stop)).length,1);
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'collection-concurrency-'));
const lock=path.join(dir,'account.lock');let inside=0,lockPeak=0;
const action=()=>withAccountLock(lock,'task',async()=>{
  inside++;lockPeak=Math.max(lockPeak,inside);
  await new Promise(resolve=>setTimeout(resolve,15));inside--;
},{interval:5});
await Promise.all([action(),action()]);assert.equal(lockPeak,1);
await assert.rejects(withAccountLock(lock,'task',async()=>{throw new Error('fixture');}),/fixture/);
await action(); // Exception releases ownership, so next task succeeds.
assert.equal((await withAccountLock(lock,'task',()=>assert.fail(),{shouldStop:()=>true})).code,43);
await fs.writeFile(path.join(dir,'shixiseng_a.json'),JSON.stringify({task_id:'task',details:{one:{ok:true,data:{info:'JD'}},bad:{ok:false,data:{info:'bad'}},empty:{ok:true,data:{}}}}));
await fs.writeFile(path.join(dir,'shixiseng_b.json'),JSON.stringify({task_id:'foreign',details:{foreign:{ok:true,data:{info:'wrong task'}}}}));
const cache=await loadShixiDetailCache(dir,'task');assert.deepEqual([...cache.keys()],['one']);
const details={};assert.equal(reuseShixiDetails([{uuid:'one'},{uuid:'bad'}],details,cache),1);
assert.equal(details.one.data.info,'JD');assert.equal(details.bad,undefined);
assert.equal(reuseShixiDetails([{uuid:'one'}],details,cache),0);
// Run the actual coordinator + actual collectors without platform requests:
// public channel already blocked, and the zero-target login collector is done.
const output=path.join(dir,'output');await fs.mkdir(output);
const publicConfigPath=path.join(dir,'public.json'),zhaopinConfigPath=path.join(dir,'zhaopin.json');
await fs.writeFile(publicConfigPath,JSON.stringify({task_id:'fixture',keywords:['test'],platforms:{jobonline:{enabled:true,cities:[]}}}));
await fs.writeFile(zhaopinConfigPath,JSON.stringify({task_id:'fixture',keywords:[],cities:[]}));
await fs.writeFile(path.join(output,'采集清单.json'),JSON.stringify({task_id:'fixture',platforms:{jobonline:{errors:[{stopChannel:true,code:'layout_changed'}]}}}));
await fs.writeFile(path.join(output,'jobonline_标准化数据.csv'),'platform,query_keyword,job_id\n就业在线,test,kept');
const child=spawn(process.execPath,[fileURLToPath(new URL('./collect_parallel_channels.mjs',import.meta.url)),JSON.stringify({public:true,zhaopin:true,publicConfigPath,zhaopinConfigPath,outputDir:output,candidateTarget:0,lockDir:dir})],{env:{...process.env,JOB_COLLECTOR_TASK_ID:'fixture',JOB_COLLECTOR_BLOCKED_POLICY:'skip'},windowsHide:true});
let logs='';child.stdout.on('data',data=>logs+=data);child.stderr.on('data',data=>logs+=data);
const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
assert.equal(exit,44,logs);
const report=JSON.parse(await fs.readFile(path.join(output,'并发渠道状态.json'),'utf8'));
assert.equal(report.results.find(row=>row.platform==='public').code,44);
assert.equal(report.results.find(row=>row.platform==='zhaopin').code,0);
assert.equal(JSON.parse(await fs.readFile(path.join(output,'采集清单.json'),'utf8')).total_rows,1);
console.log('PASS: bounded parallel channels, failure isolation, pause stops new work, account serialization/release, task-scoped successful detail reuse');
