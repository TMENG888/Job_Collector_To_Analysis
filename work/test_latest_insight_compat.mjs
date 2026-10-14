import assert from 'node:assert/strict';
import {resolveLatestInsightSource} from '../job_collector_ui/public/insight-transfer.js';
const task={id:'嵌入式任务',label:'嵌入式软件开发',outputDir:'C:\\数据\\任务\\',status:'paused'};
const latest={path:'C:\\数据\\任务\\最新数据.csv',expectedRows:11814,resolution:'latest_snapshot'};
assert.deepEqual(await resolveLatestInsightSource(task,async(url,options)=>{assert.match(url,/refresh-latest$/);assert.equal(options.method,'POST');return {dataset:latest};}),latest);
const fallback=await resolveLatestInsightSource(task,async()=>{throw Object.assign(new Error('接口不存在'),{status:404});});
assert.equal(fallback.path,latest.path);assert.equal(fallback.requiresManualSource,true);assert.equal(fallback.expectedRows,null);
await assert.rejects(resolveLatestInsightSource(task,async()=>{throw Object.assign(new Error('任务归属不符'),{status:400});}),/归属不符/);
console.log('PASS: latest source, old-server 404 fallback, fixed task CSV, no fabricated counts, validation errors preserved');
