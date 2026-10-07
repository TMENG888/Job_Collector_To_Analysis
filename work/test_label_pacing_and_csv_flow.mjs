import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { readJobDataset } from './job_dataset.mjs';
import { labelPolicy, classifyPlatformFailure, visiblePlatformNotice, pacingDelay, resumeBlock } from './label_runtime_policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await fs.mkdtemp(path.join(root, 'ui_data_pacing_test_'));
const input = path.join(temporary, '采集标准化.csv');
const csv = 'platform,job_id,job_name,salary,city,experience,education,employment_type,company_size,skills,job_description\r\n' +
  Array.from({ length: 8 }, (_, i) => `智联招聘,id-${i},爬虫工程师,${10+i}-${14+i}K,北京,1-3年,本科,全职,20-99人,Python | Scrapy,"负责Python与Scrapy爬虫开发，数据采集、数据清洗和网页解析。\n维护MySQL存储，处理日志和任务调度，提升数据质量。含逗号,和引号""原文""。"`).join('\r\n');
await fs.writeFile(input, `\uFEFF${csv}`, 'utf8');
await fs.writeFile(path.join(temporary, 'tasks.json'), JSON.stringify([{id:'collection-fixture',label:'爬虫/数据采集',primaryKeyword:'爬虫',keywords:['爬虫'],outputDir:temporary,platforms:[],cities:[],status:'partial',targetRows:8}]));
const dataset = await readJobDataset(input);
assert.equal(dataset.rows.length, 8); assert.equal(dataset.rows[0]['岗位ID'], 'id-0');
assert.match(dataset.rows[0]['岗位描述'], /\n维护MySQL/); assert.match(dataset.rows[0]['岗位描述'], /"原文"/);
assert.equal(labelPolicy('kimi', {batchSize:5,cooldownMs:1}).batchSize, 1);
assert.equal(labelPolicy('kimi', {cooldownMs:1}).cooldownMs, 30000);
for (const platform of ['deepseek','tongyi','zhipu','doubao']) assert.equal(labelPolicy(platform,{cooldownMs:1}).cooldownMs,15000);
assert.equal(classifyPlatformFailure('和Kimi聊天的人太多了，订阅会员可进入优先队列').code,'capacity_or_quota');
assert.equal(classifyPlatformFailure('请求过于频繁').requiresHuman,true);
assert.equal(classifyPlatformFailure('请先登录').code,'login_required');
assert.equal(classifyPlatformFailure('等待本批回复超时').pause,false);
assert.equal(visiblePlatformNotice('岗位职责：验证码开发与合规处理'),null);
assert.equal(visiblePlatformNotice('岗位包含验证码开发\n和Kimi聊天的人太多了，订阅会员可进入优先队列').code,'capacity_or_quota');
assert.equal(pacingDelay(labelPolicy('kimi'),5,200000,()=>0),110000);
assert.match(resumeBlock({status:'paused',retryAfter:new Date(Date.now()+100000).toISOString()}),/平台冷却/);
assert.match(resumeBlock({status:'paused',requiresHuman:true}),/需人工处理/);

const origin = 'http://127.0.0.1:8767';
const child = spawn(process.execPath, ['job_collector_ui/server.mjs','8767'], {cwd:root,env:{...process.env,JOB_UI_DATA_DIR:temporary,JOB_UI_OPEN_BROWSER:'0'},windowsHide:true,stdio:['ignore','pipe','pipe']});
let logs=''; child.stdout.on('data',c=>logs+=c);child.stderr.on('data',c=>logs+=c);
const request = async(route, body, expected=200) => {
  const response=await fetch(origin+route,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const value=await response.json();assert.equal(response.status,expected,JSON.stringify(value));return value;
};
let browser;
try {
  for(let i=0;i<40;i++){try{await request('/api/state');break;}catch{await new Promise(r=>setTimeout(r,200));}}
  const discovery=await request('/api/insights/datasets');assert.ok(discovery.datasets.some(d=>d.path===input && d.format==='csv' && d.taskId==='collection-fixture'));
  const {job}=await request('/api/labels',{inputFile:input,platform:'rules',jobFamily:'爬虫/数据采集',sampleSize:8},201);
  await request(`/api/labels/${job.id}/run`,{},202);
  for(let i=0;i<80;i++){await new Promise(r=>setTimeout(r,200));const current=(await request('/api/labels')).jobs.find(j=>j.id===job.id);if(current.status==='completed')break;if(current.status==='failed')throw new Error(current.message);}
  assert.equal((await request('/api/labels')).jobs.find(j=>j.id===job.id).metrics.completed,8);
  // Same task is resumed without duplicating persisted labels.
  await request(`/api/labels/${job.id}/run`,{},202);
  for(let i=0;i<80;i++){await new Promise(r=>setTimeout(r,200));if((await request('/api/labels')).jobs.find(j=>j.id===job.id).status==='completed')break;}
  assert.equal((await fs.readFile(path.join(job.outputDir,'标注结果.jsonl'),'utf8')).trim().split('\n').length,8);
  await request('/api/insights/run',{inputFile:input,role:'爬虫/数据采集',analysisMode:'full',labelJobId:'auto'},202);
  let report;
  for(let i=0;i<150;i++){await new Promise(r=>setTimeout(r,200));const state=await request('/api/insights');if(state.status==='failed')throw new Error(state.error);if(state.status==='completed'){report=state.report;break;}}
  assert.equal(report.total_rows,8);assert.equal(report.sample_rows,8);assert.equal(report.label_provenance.job_id,job.id);
  const {job:kimi}=await request('/api/labels',{inputFile:input,platform:'kimi',jobFamily:'爬虫/数据采集',sampleSize:8,batchSize:5,cooldownMs:1},201);
  const config=JSON.parse(await fs.readFile(path.join(temporary,'label_tasks',kimi.id,'打标配置.json'),'utf8'));
  assert.equal(config.batchSize,1);assert.equal(config.cooldownMs,30000);
  await fs.mkdir(path.join(temporary,'label_platform_runtime'),{recursive:true});
  await fs.writeFile(path.join(temporary,'label_platform_runtime','kimi.json'),JSON.stringify({status:'paused',errorCode:'capacity_or_quota',retryAfter:new Date(Date.now()+900000).toISOString(),recovery:'等待容量恢复'}));
  const blocked=await request(`/api/labels/${kimi.id}/run`,{},400);assert.match(blocked.error,/平台冷却/);
  assert.equal((await request('/api/labels')).activeCount,0,'No browser/model request when platform is cooling');
  // Direct legacy-worker invocation also observes the persistent platform circuit breaker.
  // This synthetic preexisting row tests preservation only; it is never mixed with live AI output.
  await fs.writeFile(path.join(kimi.outputDir,'标注结果.jsonl'),JSON.stringify({job_id:'id-0',row_no:2,label_platform:'test-fixture',skills:[],tasks:[]})+'\n');
  await assert.rejects(promisify(execFile)(process.execPath,['work/label_job_data.mjs',path.join(temporary,'label_tasks',kimi.id,'打标配置.json')],{cwd:root}),/平台冷却/);
  const quality=JSON.parse(await fs.readFile(path.join(kimi.outputDir,'标注质量报告.json'),'utf8'));
  assert.equal(quality.completed_rows,1);assert.equal(quality.pending_rows,7);assert.equal(quality.runtime.status,'paused');
  browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin,{waitUntil:'networkidle'});
  await page.locator('[data-action="labels"]').click();await page.locator('#labelDialog').waitFor();
  assert.equal(await page.locator('#labelForm input[name="inputFile"]').inputValue(),input);
  await page.locator('#labelForm select[name="platform"]').selectOption('kimi');assert.equal(await page.locator('#labelForm input[name="batchSize"]').inputValue(),'1');
  await page.locator('[data-close-label]').first().click();
  await page.locator('[data-view="tasks"]').click();await page.locator('[data-action="insights"]').click();
  await page.waitForFunction(expected => document.querySelector('#insightForm input[name="inputFile"]').value === expected, input);
  assert.equal(await page.locator('#insightForm input[name="inputFile"]').inputValue(),input);
  assert.equal(await page.locator('#insightLabelJob').inputValue(),'auto');assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,csv_rows:8,resume_no_duplicates:true,csv_labels_to_insights:true,cooling_blocks_requests:true,kimi_single_row:true,playwright_ui:true,test_data:temporary}));
} catch(error) { console.error(logs); throw error; }
finally { await browser?.close(); child.kill(); await new Promise(r=>child.once('exit',r)); }
