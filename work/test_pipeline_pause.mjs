import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..'),dir=await fs.mkdtemp(path.join(os.tmpdir(),'pipeline-pause-'));
const resourceURL=pathToFileURL(path.join(root,'work/collector_resources.mjs')).href;
const marker=path.join(dir,'resource-check'),stub=path.join(dir,'resource-stub.mjs'),loader=path.join(dir,'loader.mjs');
await fs.writeFile(stub,`export * from ${JSON.stringify(resourceURL+'?real')};import fs from 'node:fs/promises';export async function assertCollectorResources(){await fs.writeFile(${JSON.stringify(marker)},'checking');await new Promise(r=>setTimeout(r,800));}`);
await fs.writeFile(loader,`export async function resolve(specifier,context,next){if(specifier==='../work/collector_resources.mjs'&&context.parentURL?.endsWith('/server.mjs'))return {url:${JSON.stringify(pathToFileURL(stub).href)},shortCircuit:true};return next(specifier,context);}`);
const port=19886,base=`http://127.0.0.1:${port}`;
const child=spawn(process.execPath,['--experimental-loader',pathToFileURL(loader).href,'job_collector_ui/server.mjs',String(port)],{cwd:root,env:{...process.env,JOB_UI_DATA_DIR:dir,JOB_UI_OPEN_BROWSER:'0'},windowsHide:true});
let logs='';child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(fn){for(let i=0;i<100;i++){if(await fn().catch(()=>false))return;await delay(50);}throw Error('timeout '+logs);}
async function api(url,body){const response=await fetch(base+url,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});const data=await response.json();assert.ok(response.ok,JSON.stringify(data));return data;}
try{
 await wait(async()=> (await fetch(base+'/api/state')).ok);
 const {task}=await api('/api/tasks',{label:'暂停测试',primaryKeyword:'测试',targetRows:8000,platforms:['jobonline'],cities:['北京'],outputDir:path.join(dir,'output')});
 const url='/api/tasks/'+encodeURIComponent(task.id);
 await api(url+'/run',{stage:'all'});await wait(()=>fs.access(marker).then(()=>true));
 await api(url+'/pause',{});await delay(1000);
 const state=await api('/api/state');assert.equal(state.activeCount,0);assert.equal(state.tasks.find(t=>t.id===task.id).status,'paused');
 const log=await fs.readFile(path.join(dir,'logs',task.id+'.log'),'utf8');assert.doesNotMatch(log,/▶/,'pause during awaited startup must prevent spawn');
 console.log('PASS live pause API during pipeline startup: accepted without child, no late spawn, paused state retained');
}finally{child.kill();await new Promise(r=>child.exitCode!==null?r():child.once('close',r));}
