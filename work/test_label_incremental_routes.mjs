import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await fs.mkdtemp(path.join(root, 'ui_data_routes_test_'));
for (const name of ['tasks.json', 'label_jobs.json']) await fs.copyFile(path.join(root, 'ui_data', name), path.join(temporary, name));
const origin = 'http://127.0.0.1:8768';
const server = spawn(process.execPath, ['job_collector_ui/server.mjs', '8768'], { cwd: root, env: { ...process.env, JOB_UI_DATA_DIR: temporary, JOB_UI_OPEN_BROWSER: '0' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; server.stdout.on('data', c => logs += c); server.stderr.on('data', c => logs += c);
let browser;
const fixture = id => ({ id, name: `测试任务 ${id}`, platform:'kimi', platformName:'Kimi', jobFamily:'爬虫/数据采集', inputFile:'C:\\fixtures\\source.xlsx', outputDir:'C:\\fixtures\\labels', sheetName:'岗位数据', sampleSize:20, batchSize:1, status:'paused', message:'已暂停', metrics:{total:20,completed:5,failed:0,averageConfidence:.9,riskRows:0,schemaSuccessRate:.25,rowsPerMinute:0}, runningSeconds:0 });
let jobs = [fixture('label-a'), fixture('label-b')];
let logText = Array.from({length:150},(_,i)=>`日志 ${i}：已保存岗位`).join('\n');
const review = {approved:0,rejected:0,pending:5,rows:[{job_name:'测试岗位',row_no:2,job_id:'posting-a',skills:['Python'],tasks:[],evidence_json:[{quote:'Python'}],job_description:'原文包含 Python，供复核阅读。',confidence:.9,evidence_coverage:1}]};
try {
  for(let i=0;i<40;i++){try{if((await fetch(origin+'/api/state')).ok)break;}catch{}await new Promise(r=>setTimeout(r,200));}
  for(const route of ['/tasks','/platforms','/labels','/labels/label-a','/insights']) {const r=await fetch(origin+route);assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/text\/html/);}
  const liveLabels=await (await fetch(origin+'/api/labels')).json();
  assert.equal((await fetch(origin+'/api/labels/'+encodeURIComponent(liveLabels.jobs[0].id))).status,200);
  assert.equal((await fetch(origin+'/api/labels/nonexistent')).status,404);
  assert.equal((await fetch(origin+'/api/tasks')).status,200);
  const liveTasks=await (await fetch(origin+'/api/tasks')).json();
  if(liveTasks.tasks.length)assert.equal((await fetch(origin+'/api/tasks/'+encodeURIComponent(liveTasks.tasks[0].id))).status,200);
  browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];let documents=0,logsRequested=0,metadataRequested=0;
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.isNavigationRequest() && r.frame()===page.mainFrame())documents++;});
  await page.route('**/api/labels',route=>{metadataRequested++;return route.fulfill({json:{jobs,activeCount:0}});});
  await page.route('**/api/labels/*/review',route=>route.fulfill({json:review}));
  await page.route('**/api/labels/*/logs',route=>{logsRequested++;return route.fulfill({json:{content:logText}});});
  await page.goto(origin+'/labels/label-a');
  await page.waitForFunction(()=>document.querySelector('#labelReview')?._reviewSignature && document.querySelector('#labelLog')?._logLoaded);
  await page.evaluate(()=>{
    window.refs={log:document.querySelector('#labelLog'),review:document.querySelector('#labelReview'),metric:document.querySelector('.label-metrics b'),item:document.querySelector('[data-label-job="label-a"]'),stat:document.querySelector('#labelStats strong')};
    window.changed=0;window.watch=new MutationObserver(records=>window.changed+=records.length);watch.observe(document.querySelector('#labelsView'),{subtree:true,childList:true,attributes:true,characterData:true});
    refs.log.scrollTop=40;const button=refs.review.querySelector('button');button.focus({preventScroll:true});window.focused=button;
  });
  await page.waitForTimeout(6500);
  assert.equal(await page.evaluate(()=>window.changed),0,'Unchanged polls must not mutate the labeling page');
  assert.ok(metadataRequested>=3);assert.ok(logsRequested>=3 && logsRequested<=5,'No duplicate log requests from metadata refresh');
  assert.equal(documents,1,'Polling is not document navigation');
  assert.ok(await page.evaluate(()=>refs.log===document.querySelector('#labelLog') && refs.review===document.querySelector('#labelReview') && document.activeElement===window.focused && refs.log.scrollTop===40));
  jobs=structuredClone(jobs);jobs[0].metrics.completed=6;
  await page.waitForFunction(()=>document.querySelector('.label-metrics .metric:nth-child(2) b').textContent==='6');
  assert.ok(await page.evaluate(()=>refs.log===document.querySelector('#labelLog') && refs.review===document.querySelector('#labelReview') && refs.metric===document.querySelector('.label-metrics b') && refs.item===document.querySelector('[data-label-job="label-a"]') && refs.stat===document.querySelector('#labelStats strong') && document.activeElement===window.focused));
  review.approved=1;review.pending=4;
  await page.waitForFunction(()=>document.querySelector('#labelReview p').textContent.includes('已批准 1'));
  assert.ok(await page.evaluate(()=>document.activeElement===window.focused && refs.review.querySelector('button')===window.focused),'Review counters should not replace unchanged rows');
  logText+='\n新增日志：岗位已保存';
  await page.waitForFunction(()=>document.querySelector('#labelLog').textContent.includes('新增日志'));
  assert.equal(await page.evaluate(()=>refs.log.scrollTop),40,'Reading older logs must not jump to bottom');
  await page.evaluate(()=>refs.log.scrollTop=refs.log.scrollHeight);
  logText+='\n尾部跟随测试';
  await page.waitForFunction(()=>document.querySelector('#labelLog').textContent.includes('尾部跟随'));
  assert.ok(await page.evaluate(()=>refs.log.scrollHeight-refs.log.scrollTop-refs.log.clientHeight<2));
  await page.locator('[data-label-job="label-b"]').click();assert.match(page.url(),/\/labels\/label-b$/);
  await page.goBack();await page.waitForFunction(()=>document.querySelector('#labelDetail').dataset.jobId==='label-a');
  await page.locator('[data-view="platforms"]').click();assert.match(page.url(),/\/platforms$/);
  const beforeLogs=logsRequested;await page.waitForTimeout(2600);assert.equal(logsRequested,beforeLogs,'Hidden view must not poll labeling logs');
  await page.goto(origin+'/labels/label-b');await page.waitForFunction(()=>document.querySelector('#labelDetail').dataset.jobId==='label-b');
  await page.reload();await page.waitForFunction(()=>document.querySelector('#labelDetail').dataset.jobId==='label-b');
  await page.goto(origin+'/labels/missing-id');await page.getByRole('heading',{name:'未找到打标任务'}).waitFor();assert.match(page.url(),/missing-id$/);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,unchanged_dom_mutations:0,metrics_updated_in_place:true,log_scroll_preserved:true,focus_preserved:true,rest_routes:true,history_and_reload:true,missing_resource:true,test_data:temporary}));
}catch(error){console.error(logs);throw error;}
finally{await browser?.close();server.kill();await new Promise(r=>server.once('exit',r));}
