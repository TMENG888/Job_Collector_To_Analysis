import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {collectBrowserDom,browserJobIdentity,browserCheckpointPath,browserDomSpecs} from './browser_dom_collection.mjs';
import {writeNativeChannelRows,readNativeTaskRows} from './collector_native_sink.mjs';
import {assertCollectorResources} from './collector_resources.mjs';

await assertCollectorResources();
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'browser-dom-fixture-'));
const browser=await chromium.launch({headless:true,chromiumSandbox:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
const city={name:'北京',code:'010'};let visits=[],scenario='normal',launches=0;
async function setup(id){const outputDir=path.join(dir,id);await fs.mkdir(outputDir);await fs.writeFile(path.join(outputDir,'任务归属.json'),JSON.stringify({task_id:id}));return {taskId:id,outputDir,platform:'jobonline',combinations:[{keyword:'销售工程师',city}],maxPages:2,maxRows:2,stateDir:path.join(dir,'rates'),log:()=>{},step:action=>action(),contextFactory:async()=>{
  launches++;const context=await browser.newContext();
  // Every browser request is fulfilled locally. No remote site is contacted.
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());visits.push(url.pathname+url.search);
    assert.equal(url.hostname,'www.jobonline.cn');let body='';
    if(url.pathname==='/jobtbao-es-api/elastic/api/position/queryPositionByCon'){await route.fulfill({contentType:'application/json',body:JSON.stringify({code:5009})});return;}
    if(scenario==='business')body='<p>暂无相关职位</p><script>fetch("/jobtbao-es-api/elastic/api/position/queryPositionByCon")</script>';
    else if(scenario==='empty')body='<p>暂无相关职位</p>';
    else if(scenario==='captcha')body='<div class="captcha-dialog">请按住滑块</div>';
    else if(url.pathname.includes('positionDetail'))body=scenario==='missing'?'<h1>销售工程师</h1><footer>网站导航内容，不是岗位详情</footer>':`<h1>销售工程师</h1><div class="company-name">隔离测试公司</div><div class="work-city">北京</div><div class="salary">10-15K</div><div class="job-description">负责设备销售及技术解决方案沟通，为客户提供技术咨询、产品演示与售后支持。</div>`;
    else{const n=Number(url.searchParams.get('page')||1);body=`<article class="job-card"><a href="https://www.jobonline.cn/positionDetail?id=fixture-${n}">销售工程师</a></article>${scenario==='stall'?'<button onclick="void 0">下一页</button>':n===1?'<a href="/findPositions?page=2">下一页</a>':''}`;if(scenario==='loading')body='<p>暂无相关职位</p><script>setTimeout(()=>{document.body.innerHTML='+JSON.stringify(body)+'},600)</script>';}
    await route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><html><body>'+body+'</body></html>'});
  });return context;
}};}
try{
  for(const [url,p]of [['https://evil.example/positionDetail?id=123','jobonline'],['https://www.jobonline.cn.evil.example/positionDetail?id=123','jobonline'],['http://www.jobonline.cn/positionDetail?id=123','jobonline'],['https://www.jobonline.cn/findPositions','jobonline']])assert.equal(browserJobIdentity(url,p),null);
  assert.equal(browserJobIdentity('https://www.jobonline.cn/positionDetail?id=123&token=do-not-keep','jobonline').url,'https://www.jobonline.cn/positionDetail?id=123');
  assert.equal(browserJobIdentity('https://jobs.51job.com/beijing/173502494.html','job51').id,'173502494');
  assert.equal(browserJobIdentity('https://jobs.zhaopin.com/CC123456789J00001.htm','zhaopin').id,'CC123456789J00001');
  assert.equal(browserJobIdentity('https://www.liepin.com/job/1971234567.shtml','liepin').id,'1971234567');
  const options=await setup('normal');
  await writeNativeChannelRows(options.outputDir,options.taskId,[{platform:'就业在线',job_id:'historical',job_name:'历史销售工程师',city:'北京',company_name:'历史公司',job_url:'https://www.jobonline.cn/positionDetail?id=historical',job_description:'负责客户拓展与产品销售、技术支持和项目方案咨询，维护客户关系。'}]);
  const result=await collectBrowserDom(options);assert.deepEqual(result.errors,[]);assert.equal(result.processed,2);assert.equal(result.rows,3,'historical rows must not consume new DOM budget');assert.equal(result.valid,3);
  const cp=browserCheckpointPath(options.outputDir,'jobonline','销售工程师',city);assert.equal(JSON.parse(await fs.readFile(cp)).budget_finished,true);
  const firstVisits=visits.length;await collectBrowserDom(options);assert.equal(visits.length,firstVisits,'completed budget checkpoint is not replayed');
  assert.equal((await readNativeTaskRows(options.outputDir,options.taskId)).length,3);
  assert.equal((await fs.readdir(options.outputDir)).some(f=>f.endsWith('.csv')),false);
  scenario='missing';const incomplete=await setup('missing');incomplete.maxRows=1;const missing=await collectBrowserDom(incomplete);assert.equal(missing.valid,0);const raw=(await readNativeTaskRows(incomplete.outputDir,incomplete.taskId))[0];assert.equal(raw.detail_status,'list_only');assert.equal(raw.job_description??'','');assert.equal(raw.city??'','','query city must not be invented as job city');
  scenario='captcha';const challenge=await setup('challenge');const stopped=await collectBrowserDom(challenge);assert.equal(stopped.rows,0);assert.equal(stopped.errors[0].code,'verification_required');
  scenario='stall';const stalled=await setup('stall');stalled.maxPages=3;stalled.maxRows=5;const repeated=await collectBrowserDom(stalled);assert.equal(repeated.rows,1);assert.equal(repeated.errors[0].code,'pagination_stalled');assert.equal(repeated.errors[0].stopChannel,false);
  scenario='loading';const loading=await setup('loading');loading.maxRows=1;assert.equal((await collectBrowserDom(loading)).valid,1,'temporary empty UI during SPA loading is not an exhausted source');
  scenario='business';const business=await setup('business');assert.equal((await collectBrowserDom(business)).errors[0].code,'page_business_error');
  scenario='empty';const empty=await setup('empty');const emptyResult=await collectBrowserDom(empty);assert.equal(emptyResult.errors[0].code,'empty_unverified');assert.equal(JSON.parse(await fs.readFile(browserCheckpointPath(empty.outputDir,'jobonline','销售工程师',city))).completed,false);
  const invalid={...options,taskId:'foreign'};const before=launches;await assert.rejects(collectBrowserDom(invalid),/归属/);assert.equal(launches,before);
  console.log('PASS real Playwright + local-only HTML fixtures: DOM detail reading, actual next-page clicks, SQLite dedup/enrichment, separate checkpoints, no invented fields, verification stop, repeated-page stop, ownership guard. Real memory check; network and pacing actions injected. NOT a live platform acceptance test.');
}finally{await browser.close();}
