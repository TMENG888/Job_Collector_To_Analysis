// The direct public endpoint exposes one search window per condition, not the
// old browser's pagination. Exercise that production contract with NO network.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'jobonline-task-budget-'));
const stub=path.join(dir,'stub.mjs'),loader=path.join(dir,'loader.mjs');
await fs.writeFile(stub,`
import fs from 'node:fs/promises';
export const checkJobonlineDependencies=()=>({ok:true});
export async function fetchJobonlinePage(request,keyword,city){
 await fs.appendFile(process.env.BUDGET_CALLS,JSON.stringify({keyword,city:city.name})+'\\n');
 return {list:Array.from({length:3},(_,i)=>({id:keyword+'-'+i}))};
}
export function normalizeJobonline(raw,keyword,city){return {platform:'就业在线',job_id:raw.id,job_name:'测试岗位',query_keyword:keyword,query_city:city};}
`);
await fs.writeFile(loader,`export async function resolve(specifier,context,next){if(specifier==='./direct_jobonline_adapter.mjs'&&context.parentURL?.endsWith('/collect_public_job_platforms.mjs'))return {url:${JSON.stringify(pathToFileURL(stub).href)},shortCircuit:true};return next(specifier,context);}`);
async function run(name,maxRows=2){
 const output=path.join(dir,name),calls=path.join(dir,name+'-calls.jsonl');
 await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,'任务归属.json'),JSON.stringify({task_id:'budget-task'}));
 const config=path.join(dir,name+'.json');await fs.writeFile(config,JSON.stringify({task_id:'budget-task',keywords:['甲','乙'],interviews:{enabled:false,defaultChannelVersion:1},nowcoder:{enabled:false},request:{attempts:1,minimumIntervalMs:2500},platforms:{jobonline:{enabled:true,cities:[{name:'全国'}],maxRows,maxPages:1}}}));
 const child=spawn(process.execPath,[fileURLToPath(new URL('./collect_public_job_platforms.mjs',import.meta.url)),config,output],{env:{...process.env,NODE_OPTIONS:'--experimental-loader='+pathToFileURL(loader).href,JOB_COLLECTOR_TASK_ID:'',BUDGET_CALLS:calls},windowsHide:true});
 let logs='';child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x);
 const timer=setTimeout(()=>child.kill(),20000);
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)});clearTimeout(timer);assert.equal(code,0,logs);
 const visits=(await fs.readFile(calls,'utf8').catch(e=>{if(e.code==='ENOENT')return '';throw e})).trim().split('\n').filter(Boolean).map(JSON.parse);
 const manifest=JSON.parse(await fs.readFile(path.join(output,'采集清单.json'),'utf8'));
 const checkpoint=JSON.parse(await fs.readFile(path.join(output,'断点数据/jobonline_甲_全国.json'),'utf8'));
 return {visits,rows:manifest.platforms.jobonline.rows,checkpoint};
}
try{
 const capped=await run('capped');assert.equal(capped.rows,4);assert.equal(capped.visits.length,2);assert.equal(capped.checkpoint.completed,false);assert.equal(capped.checkpoint.completion_reason,'row_limit');
 const recovered=await run('capped',4);assert.equal(recovered.rows,6);assert.equal(recovered.visits.length,4);assert.equal(recovered.checkpoint.completed,true);assert.equal(recovered.checkpoint.direct_search_verified,true);
 const retained=await run('capped',4);assert.equal(retained.rows,6);assert.equal(retained.visits.length,4,'verified windows must not issue duplicate requests');
 assert.deepEqual(retained.checkpoint.records.map(row=>row.job_id),['甲-0','甲-1','甲-2']);assert.equal(retained.checkpoint.task_id,'budget-task');
 console.log('PASS direct Jobonline: per-window caps, capped-tail recovery, stable-ID dedup, completed-window reuse, task ownership; zero external requests. Legacy browser task-budget contract retired.');
}finally{assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));await fs.rm(dir,{recursive:true,force:true});}
