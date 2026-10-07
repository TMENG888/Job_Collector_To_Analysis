import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {chromium} from 'playwright';
import {collect51Records,collectJobonline,blockedReason,parse51Payload} from './browser_public_channels.mjs';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'job-public-channel-'));
const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
let closed=0;
async function contextFactory(handler){const ctx=await browser.newContext();ctx.on('close',()=>closed++);await ctx.route('**/*',handler);return ctx;}
try{
 assert.ok(blockedReason('访问验证 请按住滑块，拖动到最右边'));
 assert.equal(blockedReason('工程师 经验不限 本科 登录/注册'), '');
 assert.throws(()=>parse51Payload({}), /无有效岗位列表/);
 const first={resultbody:{job:{totalCount:40,items:[{jobId:'51-1',jobName:'智能体开发',provideSalaryString:'1-2万'}]}}};
 const handler=route=>{
   if(route.request().url().includes('/api/job/search-pc'))return route.fulfill({json:first});
   return route.fulfill({contentType:'text/html; charset=utf-8',body:'<body>岗位列表<button class="btn-next" onclick="document.body.innerHTML=\'访问验证 请按住滑块\'">下一页</button><script>fetch("/api/job/search-pc?pageNum=1")</script></body>'});
 };
 const checkpointPath=path.join(dir,'51.json');
 const start=Date.now();
 await assert.rejects(collect51Records('智能体开发',{name:'北京',code:'010000'},{checkpointPath,contextFactory:()=>contextFactory(handler)}),e=>e.code==='verification_required'&&e.records.length===1);
 assert.ok(Date.now()-start<10000,'captcha should not wait 40 seconds');
 const partial=JSON.parse(await fs.readFile(checkpointPath,'utf8'));assert.equal(partial.records.length,1);assert.equal(partial.completed,false);
 assert.equal(closed,1,'failed browser closed');
 const success=await collect51Records('智能体开发',{name:'北京',code:'010000'},{checkpointPath:path.join(dir,'51-ok.json'),contextFactory:()=>contextFactory(route=>route.request().url().includes('/api/job/search-pc')?route.fulfill({json:{resultbody:{job:{totalCount:1,items:first.resultbody.job.items}}}}):route.fulfill({contentType:'text/html; charset=utf-8',body:'<script>fetch("/api/job/search-pc?pageNum=1")</script>'}))});
 assert.equal(success.records.length,1);assert.equal(closed,2);
 const onlineFixture=`<html><body><script>
 const list=()=>{document.body.innerHTML=[1,2].map(i=>'<div><div class="position_item_left"><p><span class="left_title" onclick="detail('+i+')">工程师'+i+'</span><span class="salary">4000-6000元</span></p><p class="left_info"><span>山东省-威海市</span><span>|经验不限</span><span>|大学本科</span><span>|社招</span></p><p><span class="name">测试公司</span><span class="nature">民营</span><span class="size">50-99人</span></p></div>职位来源：公共招聘</div>').join('')+'<button disabled>下一页</button>'};
 window.detail=i=>{history.pushState({},'', '/positionDetail?id='+i);document.body.innerHTML='<div>4000-6000元/月</div><div class="job-sec"><h3>职位描述:</h3><div class="text">负责产品工艺设计及成本核算</div></div><div class="job-sec"><h3>职位亮点:</h3><ul><li>五险一金</li></ul></div><div class="location-address">山东省威海市测试地址</div><div><h2>测试公司</h2><p>行业：制造业</p><p>人数：50-99人</p></div><div>职位同步时间：2026/07/06</div>'};window.onpopstate=list;list();
 </script></body></html>`;
 const onlinePath=path.join(dir,'online.json');
 const online=await collectJobonline('工程师',{name:'全国'},{checkpointPath:onlinePath,maxRows:2,contextFactory:()=>contextFactory(route=>route.fulfill({contentType:'text/html; charset=utf-8',body:onlineFixture}))});
 assert.equal(online.length,2);assert.equal(online[0].platform,'就业在线');assert.equal(online[0].industry,'制造业');assert.equal(online[0].company_size,'50-99人');assert.equal(online[0].salary,'4000-6000元/月');assert.match(online[0].job_description,/工艺设计/);
 assert.equal(new Set(online.map(r=>r.job_id)).size,2);assert.equal(closed,3);
 await assert.rejects(collectJobonline('工程师',{name:'全国'},{checkpointPath:path.join(dir,'blocked-online.json'),contextFactory:()=>contextFactory(route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'请先登录后查看'}))}), /登录或账号/);
 assert.equal(closed,4);
 console.log(JSON.stringify({ok:true,checks:['51 captcha stops promptly','partial checkpoint survives','contexts closed on error/success','valid API payload','jobonline detail fields and dedup','jobonline login stop'],testDir:dir}));
}finally{await browser.close();}
