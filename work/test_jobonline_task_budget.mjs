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
export async function collectJobonline(keyword,city,options){
 const rows=Array.from({length:options.maxRows},(_,i)=>({platform:'就业在线',job_id:keyword+'-'+i,job_name:'相邻有效岗位',query_keyword:keyword,query_city:city.name}));
 await fs.appendFile(process.env.BUDGET_CALLS,JSON.stringify({keyword,maxRows:options.maxRows,task_id:process.env.JOB_COLLECTOR_TASK_ID})+'\\n');
 await fs.writeFile(options.checkpointPath,JSON.stringify({records:rows,task_id:process.env.JOB_COLLECTOR_TASK_ID}));
 if(process.env.BUDGET_DEFER==='1')options.onDefer();
 return rows;
}
`);
await fs.writeFile(loader,`export async function resolve(specifier,context,next){if(specifier==='./browser_public_channels.mjs'&&context.parentURL?.endsWith('/collect_public_job_platforms.mjs'))return {url:${JSON.stringify(pathToFileURL(stub).href)},shortCircuit:true};return next(specifier,context);}`);
async function run(name,seed=0,{rounds=false,defer=false,resume=false}={}){
 const output=path.join(dir,name),calls=path.join(dir,name+'-calls.jsonl');
 await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,'任务归属.json'),JSON.stringify({task_id:'budget-task'}));
 if(seed)await fs.writeFile(path.join(output,'jobonline_标准化数据.csv'),'platform,job_id,job_name,query_keyword,query_city\n'+Array.from({length:seed},(_,i)=>'就业在线,historic-'+i+',历史岗位,甲,全国').join('\n'));
 const config=path.join(dir,name+'.json');await fs.writeFile(config,JSON.stringify({task_id:'budget-task',keywords:['甲','乙'],request:{attempts:1,minimumIntervalMs:1},platforms:{jobonline:{enabled:true,cities:[{name:'全国'}],maxRows:2,maxPages:1,...(rounds?{totalMaxRows:6}:{})}}}));
 const child=spawn(process.execPath,[fileURLToPath(new URL('./collect_public_job_platforms.mjs',import.meta.url)),config,output],{env:{...process.env,NODE_OPTIONS:'--experimental-loader='+pathToFileURL(loader).href,JOB_COLLECTOR_TASK_ID:'',BUDGET_DEFER:defer?'1':'0',BUDGET_CALLS:calls},windowsHide:true});
 let logs='';child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x);
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)});assert.equal(code,0,logs);
 const visits=(await fs.readFile(calls,'utf8').catch(e=>{if(e.code==='ENOENT')return '';throw e})).trim().split('\n').filter(Boolean).map(JSON.parse);
 const manifest=JSON.parse(await fs.readFile(path.join(output,'采集清单.json'),'utf8'));
 return {visits,rows:manifest.platforms.jobonline.rows};
}
try{
 const fresh=await run('fresh');assert.equal(fresh.rows,2);assert.deepEqual(fresh.visits,[{keyword:'甲',maxRows:2,task_id:'budget-task'}]);
 const existing=await run('existing',1);assert.equal(existing.rows,2);assert.equal(existing.visits[0].maxRows,1);assert.equal(existing.visits.length,1);
 const historic=await run('historic',3);assert.equal(historic.rows,3);assert.deepEqual(historic.visits,[]);
 const firstRound=await run('rounds',0,{rounds:true});assert.equal(firstRound.rows,2);
 const secondRound=await run('rounds',0,{rounds:true,resume:true});assert.equal(secondRound.rows,4);assert.deepEqual(secondRound.visits.map(v=>v.maxRows),[2,4]);
 const lastRound=await run('rounds',0,{rounds:true,resume:true});assert.equal(lastRound.rows,6);
 const recovery=await run('recovery',0,{rounds:true,defer:true});assert.equal(recovery.rows,2);assert.equal(recovery.visits.length,1,'yield recovery shares original round budget');
 console.log('PASS task-wide jobonline budget: shared across keywords, existing CSV counted, history retained, config-only task ID propagated');
}finally{await fs.rm(dir,{recursive:true,force:true})}
