import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {chromium} from 'playwright';
import {collectJobonline} from './browser_public_channels.mjs';
import {JobonlinePaginationHealth} from './jobonline_pagination_health.mjs';
import {jobonlineContinuation} from './jobonline_continuation.mjs';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pagination-guard-'));
const ids=Array.from({length:20},(_,i)=>String(i));
let monitor=new JobonlinePaginationHealth({},ids),snapshot;
for(let page=1;page<=3;page++)snapshot=monitor.observe(page,ids);
assert.equal(snapshot.stalled,false);monitor=new JobonlinePaginationHealth(snapshot,ids);
assert.equal(monitor.observe(4,ids).stalled,false);assert.equal(monitor.observe(5,ids).stalled,true,'recovery worker must retain the no-growth window');
const budget={mode:'checkpoint_rounds',start:0,limit:1000,totalLimit:12400};
assert.equal(jobonlineContinuation({budget,size:20,checkpoints:[{completed:false,stop_reason:'pagination_stalled'}],maxPages:500}).reason,'pagination_stalled');
assert.equal(jobonlineContinuation({budget,size:20,checkpoints:[{completed:true,completion_reason:'reported_window_end'}],maxPages:500}).reason,'reported_window_end');
const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});let lists=0,details=0,contexts=0;
const html=`<body><div id=client></div><script>document.querySelector('#client').__vue__={condition:{positionName3:'测试'},positionList:[],$post:async(url,data)=>(await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)})).json()};</script>`;
const checkpointPath=path.join(dir,'online.json');
async function contextFactory(){contexts++;const context=await browser.newContext();await context.route('**/*',route=>{
 const url=route.request().url();
 if(url.includes('queryPositionByCon')){lists++;return route.fulfill({json:{code:'200',object:{total:10000,rows:ids.map(id=>({id,positionName:'测试工程师'}))}}});}
 if(url.includes('getPositionDetail')){details++;const data=route.request().postDataJSON();return route.fulfill({json:{code:'200',object:{id:data.positionId,description:'负责自动化测试与缺陷分析，维护测试用例及测试环境。',companyBean:{name:'测试公司'}}}});}
 return route.fulfill({contentType:'text/html',body:html});
 });return context;}
try{
 await assert.rejects(collectJobonline('测试工程师',{name:'全国'},{checkpointPath,maxRows:1000,maxPages:500,wait:async()=>{},contextFactory}),error=>error.code==='pagination_stalled'&&error.partialRows.length===20);
 assert.equal(lists,6);assert.equal(details,20,'duplicate pages must not refetch details');
 const saved=JSON.parse(await fs.readFile(checkpointPath,'utf8'));assert.equal(saved.completed,false);assert.equal(saved.stop_reason,'pagination_stalled');assert.equal(saved.nextPageNo,7);
 const retained=await collectJobonline('测试工程师',{name:'全国'},{checkpointPath,maxRows:2000,maxPages:500,contextFactory});assert.equal(retained.length,20);assert.equal(lists,6,'known stalled checkpoint is not retried automatically');
 const legacy=path.join(dir,'legacy.json');await fs.writeFile(legacy,JSON.stringify({records:saved.records,total:10000,completed:true,pageNo:500,nextPageNo:501}));
 const old=await collectJobonline('测试工程师',{name:'全国'},{checkpointPath:legacy,maxRows:2000,maxPages:500,contextFactory});assert.equal(old.length,20);assert.equal(contexts,1);
 const migrated=JSON.parse(await fs.readFile(legacy,'utf8'));assert.equal(migrated.completed,false);assert.equal(migrated.stop_reason,'legacy_pagination_unverified');
 console.log('PASS deep pagination HTTP200 duplicate response stops after 6 pages, exact detail dedup, recovery window, retained history and no automatic replay of unverified legacy completion');
}finally{await browser.close();await fs.rm(dir,{recursive:true,force:true});}
