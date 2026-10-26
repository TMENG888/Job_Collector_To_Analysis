import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {spawn} from 'node:child_process';import {pathToFileURL} from 'node:url';
const root=path.resolve(import.meta.dirname,'..'),dir=await fs.mkdtemp(path.join(os.tmpdir(),'rounds-console-'));
const stub=path.join(dir,'stub.mjs'),loader=path.join(dir,'loader.mjs'),calls=path.join(dir,'calls.jsonl');
await fs.writeFile(stub,`import fs from 'node:fs/promises';export async function collectJobonline(keyword,city,options){
 const saved=await fs.readFile(options.checkpointPath,'utf8').then(JSON.parse).catch(()=>({records:[]}));
 await fs.appendFile(${JSON.stringify(calls)},JSON.stringify({keyword,rows:options.maxRows})+'\\n');
 if(keyword==='受阻'&&saved.records.length){const error=Error('403 验证中断');error.code='access_blocked';error.partialRows=saved.records;error.stopChannel=true;throw error;}
 const rows=Array.from({length:options.maxRows},(_,i)=>({platform:'就业在线',job_id:keyword+'-'+i,job_name:'测试工程师',query_keyword:keyword,query_city:city.name,company_name:'测试公司',city:'北京',job_url:'https://www.jobonline.cn/positionDetail?id='+i,job_description:'负责系统质量测试、编写自动化测试用例并维护测试环境，完成缺陷分析与回归验证。'}));
 await fs.writeFile(options.checkpointPath,JSON.stringify({task_id:process.env.JOB_COLLECTOR_TASK_ID,records:rows,completed:false,nextPageNo:2}));return rows;
}`);
await fs.writeFile(loader,`export async function resolve(specifier,context,next){if(specifier==='./browser_public_channels.mjs'&&context.parentURL?.endsWith('/collect_public_job_platforms.mjs'))return {url:${JSON.stringify(pathToFileURL(stub).href)},shortCircuit:true};return next(specifier,context);}`);
const port=19887,base='http://127.0.0.1:'+port;
const child=spawn(process.execPath,['job_collector_ui/server.mjs',String(port)],{cwd:root,env:{...process.env,NODE_OPTIONS:'--experimental-loader='+pathToFileURL(loader).href,JOB_UI_DATA_DIR:dir,JOB_UI_OPEN_BROWSER:'0'},windowsHide:true});
let logs='';child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x);
async function wait(fn){for(let i=0;i<300;i++){if(await fn().catch(()=>false))return;await new Promise(r=>setTimeout(r,100));}throw Error('timeout '+logs);}
async function api(url,body){const r=await fetch(base+url,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});const d=await r.json();assert.ok(r.ok,JSON.stringify(d));return d;}
try{
 await wait(async()=> (await fetch(base+'/api/state')).ok);
 for(const keyword of ['正常','受阻']){
   const {task}=await api('/api/tasks',{label:keyword,primaryKeyword:keyword,targetRows:6,candidateTarget:10,platforms:['jobonline'],cities:['北京'],outputDir:path.join(dir,keyword)});
   const cfgFile=path.join(dir,'tasks',task.id,'公开渠道配置.json'),cfg=JSON.parse(await fs.readFile(cfgFile,'utf8'));cfg.platforms.jobonline.maxRows=3;await fs.writeFile(cfgFile,JSON.stringify(cfg));
   const url='/api/tasks/'+encodeURIComponent(task.id);await api(url+'/run',{stage:'all'});
   await wait(async()=> ['completed','partial'].includes((await api(url)).task.status));
   const ended=(await api(url)).task;assert.equal(ended.status,keyword==='正常'?'completed':'partial');
   const log=await fs.readFile(path.join(dir,'logs',task.id+'.log'),'utf8');assert.match(log,/目标续轮/);
 }
 const visits=(await fs.readFile(calls,'utf8')).trim().split('\n').map(JSON.parse);
 assert.deepEqual(visits,[{keyword:'正常',rows:3},{keyword:'正常',rows:6},{keyword:'受阻',rows:3},{keyword:'受阻',rows:6}]);
 console.log('PASS console pipeline end-to-end: automatic healthy continuation to valid target, 403 partial delivery without retry; isolated API fixtures');
}finally{child.kill();await new Promise(r=>child.exitCode!==null?r():child.once('close',r));}
