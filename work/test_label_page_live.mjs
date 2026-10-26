import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const origin='http://127.0.0.1:8765';
const {jobs,activeCount}=await (await fetch(origin+'/api/labels')).json();
assert.equal(activeCount,0,'This read-only unchanged-data test expects idle labeling tasks');
const job=jobs.find(j=>j.status==='completed' && j.metrics.completed>0 && !j.resultsMissing);
assert.ok(job);
const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
try {
  const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];let navigations=0;
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.isNavigationRequest() && r.frame()===page.mainFrame())navigations++;});
  await page.goto(origin+'/labels/'+encodeURIComponent(job.id));
  await page.waitForFunction(()=>document.querySelector('#labelLog')?._logLoaded && document.querySelector('#labelReview')?._reviewSignature);
  await page.evaluate(()=>{
    window.logRef=document.querySelector('#labelLog');window.reviewRef=document.querySelector('#labelReview');window.statsRef=document.querySelector('#labelStats strong');
    window.mutations=0;window.observer=new MutationObserver(rs=>window.mutations+=rs.length);observer.observe(document.querySelector('#labelsView'),{subtree:true,childList:true,attributes:true,characterData:true});
    logRef.scrollTop=40;
  });
  await page.waitForTimeout(6500);
  assert.equal(await page.evaluate(()=>window.mutations),0);
  assert.ok(await page.evaluate(()=>logRef===document.querySelector('#labelLog') && reviewRef===document.querySelector('#labelReview') && statsRef===document.querySelector('#labelStats strong') && logRef.scrollTop===40));
  assert.equal(navigations,1);assert.deepEqual(errors,[]);
  await page.screenshot({path:'ui_data/labels-incremental-20261005.png'});
  await page.locator('[data-view="tasks"]').click();await page.waitForFunction(()=>document.querySelector('#taskLog')?._logLoaded);
  await page.evaluate(()=>window.taskLogRef=document.querySelector('#taskLog'));
  await page.waitForTimeout(3500);assert.ok(await page.evaluate(()=>taskLogRef===document.querySelector('#taskLog')));
  console.log(JSON.stringify({ok:true,live_jobs:jobs.length,idle_label_dom_mutations:0,document_navigations:1,live_task_log_preserved:true,browser_errors:errors.length}));
}finally{await browser.close();}
