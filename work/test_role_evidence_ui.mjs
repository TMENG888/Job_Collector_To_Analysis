import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
const report=JSON.parse(await fs.readFile('ui_data/insights/comparisons/evidence-v2/production-test.report.json'));
const baseline=JSON.parse(await fs.readFile('ui_data/insights/comparisons/2026-10-07T12-35-57-026Z/legacy.json'));
const evaluation=JSON.parse(await fs.readFile('ui_data/insights/comparisons/evidence-v2/evaluation.json'));
assert.equal(crypto.createHash('sha256').update(await fs.readFile(report.input_file)).digest('hex'),evaluation.source_sha256,'原始数据不得改变');
const source=new Map(baseline.decisions.map(r=>[r.row_no,r]));
const mainIDs=new Set(report.cohort_observations.map(r=>r.row_no));
const reviewIDs=new Set(report.selection_review.rows.map(r=>r.row_no));
assert.equal(reviewIDs.size,report.selection_review.pending_rows,'复核清单不能重复行');
for(const r of report.selection_review.rows){
  assert.ok(!mainIDs.has(r.row_no),'复核不得进入主统计');
  assert.equal(r.job_id,source.get(r.row_no).job_id);
  for(const q of r.keyword_evidence.quotes)assert.ok(source.get(r.row_no).description.includes(q.quote),'证据必须为对应原文');
}
const payload=await (await fetch('http://127.0.0.1:8788/api/insights')).json();
const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
try {
  const page=await browser.newPage(); const errors=[];let writes=0;
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/**',async route=>{
    if(route.request().method()!=='GET'){writes++;return route.fulfill({status:409,json:{error:'离线测试禁止写操作'}});}
    if(new URL(route.request().url()).pathname==='/api/insights')return route.fulfill({status:200,json:{...payload,status:'completed',report}});
    return route.continue();
  });
  await page.goto('http://127.0.0.1:8788/insights');
  await page.waitForSelector('#insightPendingReview');
  assert.match(await page.locator('#insightFilterAudit').innerText(),/待复核 2,974 条/);
  assert.match(await page.locator('#insightFilterAudit').innerText(),/排除 11,151 条/);
  await page.locator('#insightPendingReview summary').click();
  const download=page.waitForEvent('download');
  await page.locator('#downloadInsightReview').click();
  const file=await download;
  const list=JSON.parse(await fs.readFile(await file.path()));
  assert.equal(list.rows.length,2974);assert.equal(list.included_in_statistics,false);
  assert.equal(list.selection_contract,'role-evidence-v2');
  assert.equal(list.input_file,report.input_file);
  assert.equal(report.selection_review.included_rows+report.selection_review.pending_rows+report.selection_review.excluded_rows,16720);
  assert.equal(report.cohort_observations.length,report.sample_rows,'复核岗位不得混入统计');
  assert.equal(writes,0);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,main:report.sample_rows,review:list.rows.length,excluded:report.selection_review.excluded_rows,download:'JSON',liveReportUnchanged:true}));
}finally{await browser.close();}
