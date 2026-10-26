import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {prepareStructuredCollection} from './structured_collection_plan.mjs';
import {collectionChannelAvailable} from './channel_availability.mjs';
import {assertBrowserPlatform} from './managed_browser.mjs';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'structured-plan-'));
const publicConfigPath=path.join(dir,'public.json'),zhaopinConfigPath=path.join(dir,'logged.json');
const task={id:'task',targetRows:8000,platforms:['shixiseng','iguopin','job51','jobonline','zhaopin'],publicConfigPath,zhaopinConfigPath};
const config={task_id:task.id,request:{minimumIntervalMs:550,attempts:9,concurrency:9},platforms:{job51:{maxPages:15},jobonline:{maxPages:10,maxRows:1000},shixiseng:{enabled:true,maxPages:7,maxRows:80,cities:[{name:'北京',code:'北京'}]}}};
await fs.writeFile(publicConfigPath,JSON.stringify(config));await fs.writeFile(zhaopinConfigPath,'{"task_id":"foreign-do-not-touch"}');
const logged=await fs.readFile(zhaopinConfigPath,'utf8'),plan=await prepareStructuredCollection(task),saved=JSON.parse(await fs.readFile(publicConfigPath,'utf8'));
assert.deepEqual(saved.platforms,config.platforms);assert.equal(saved.request.minimumIntervalMs,2500);assert.equal(saved.request.concurrency,1);assert.equal(saved.request.attempts,2);
assert.equal(saved.acquisitionMode,'direct_http_validated_data');assert.equal(await fs.readFile(zhaopinConfigPath,'utf8'),logged);assert.equal((await prepareStructuredCollection(task)).changes.length,0);
assert.equal(plan.channels.find(c=>c.key==='job51').directHttpReady,false);
for(const key of ['boss','yupao']){assert.equal(collectionChannelAvailable(key),false);assert.throws(()=>assertBrowserPlatform(key),{code:'DIRECT_HTTP_REQUIRED'});}
for(const key of ['shixiseng','iguopin','mohrss','zhaopin','jobonline','liepin']){assert.equal(collectionChannelAvailable(key),true);assert.throws(()=>assertBrowserPlatform(key));}
assert.equal(collectionChannelAvailable('job51'),true);assert.doesNotThrow(()=>assertBrowserPlatform('job51'),'existing manual-session proxy is distinct from a validated direct-HTTP adapter');
await prepareStructuredCollection({...task,targetRows:null,collectUntilExhausted:true});
const openPlan=JSON.parse(await fs.readFile(publicConfigPath,'utf8'));
assert.equal(openPlan.taskTargetRows,0);assert.equal(openPlan.collectUntilExhausted,true);assert.deepEqual(openPlan.platforms,config.platforms);
assert.doesNotThrow(()=>assertBrowserPlatform('deepseek'));
const before=await fs.readFile(publicConfigPath,'utf8');await assert.rejects(prepareStructuredCollection({...task,id:'foreign'}),/任务 ID/);assert.equal(await fs.readFile(publicConfigPath,'utf8'),before);
console.log('PASS strict transport plan: quotas/cities/paused configs unchanged, timing floors, idempotency, ownership, browser guards; AI annotation unaffected.');
