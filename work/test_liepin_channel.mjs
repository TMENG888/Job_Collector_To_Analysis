import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {chromium} from 'playwright';
import {collectLiepin,parseLiepinPayload,normalizeLiepinRecord,liepinSearchURL,LIEPIN_SEARCH_METHOD} from './liepin_channel.mjs';

const dir=await fs.mkdtemp(path.join(os.tmpdir(),'liepin-channel-'));
const historic=JSON.parse(await fs.readFile(new URL('./logged_probe/liepin_013.json',import.meta.url),'utf8'));
assert.equal(parseLiepinPayload(historic,0).items.length,42);
assert.equal(parseLiepinPayload(historic,0).totalPages,20,'contradictory hasNext must not terminate early');
const card=id=>({job:{jobId:String(id),title:'测试工程师'+id,salary:'15-25k·13薪',dq:'北京',requireWorkYears:'3-5年',requireEduLevel:'本科',labels:[{label:'测试技术'}],link:'https://www.liepin.com/job/'+id+'.shtml'},comp:{compId:'company',compName:'测试公司',compScale:'100-499人',compIndustry:'计算机软件'},recruiter:{recruiterName:'招聘人员'}});
const payload=(page,items,totalPages=2)=>({flag:1,data:{data:{jobCardList:items},pagination:{currentPage:page,totalPage:totalPages,pageSize:2,totalCounts:totalPages*2,hasNext:false}}});
const normalized=normalizeLiepinRecord(card(1),'测试工程师',{name:'北京'},4);
assert.equal(normalized.detail_status,'list_only');assert.equal(normalized.job_description,'');assert.equal(normalized.skills,'');assert.equal(normalized.salary,'15-25k·13薪');
assert.throws(()=>parseLiepinPayload(payload(0,[card(1)]),1),e=>e.code==='pagination_stalled');
assert.throws(()=>parseLiepinPayload({flag:1,data:{data:{jobCardList:[]},pagination:{currentPage:0,totalPage:1,pageSize:2,totalCounts:2}}},0),e=>e.code==='invalid_response');
assert.throws(()=>parseLiepinPayload({flag:0,message:'请登录'}),e=>e.code==='login_required');
assert.throws(()=>parseLiepinPayload({flag:1,data:{euuid:'fixture',backUrl:'https://safe.liepin.com'}}),e=>e.code==='verification_required');
assert.throws(()=>liepinSearchURL('测试',{name:'未知城市'}),e=>e.code==='invalid_config');
assert.equal(new URL(liepinSearchURL('测试工程师',{name:'北京'},1)).searchParams.get('dq'),'010');

const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
let contexts=0,closed=0;const requests=[];
async function factory(mode='success'){
  contexts++;const context=await browser.newContext();context.on('close',()=>closed++);
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());requests.push(url.pathname);
    if(url.hostname==='api-c.liepin.com'){
      const n=Number(url.searchParams.get('page'));
      if(mode==='rate'&&n===1)return route.fulfill({status:429,headers:{'access-control-allow-origin':'*'},json:{flag:0}});
      if(mode==='foreign')return route.fulfill({headers:{'access-control-allow-origin':'*'},json:payload(0,[card(1),card(2)])});
      const items=mode==='repeated'?[card(1),card(2)]:[card(n*2+1),card(n*2+2)];
      return route.fulfill({headers:{'access-control-allow-origin':'*'},json:payload(n,items,mode==='yield'?10:2)});
    }
    if(mode==='verify')return route.fulfill({contentType:'text/html; charset=utf-8',body:'<body>账号行为异常，请进行短信验证</body>'});
    const pageNo=Number(url.searchParams.get('curPage'));
    return route.fulfill({contentType:'text/html; charset=utf-8',body:'<body>岗位搜索<script>fetch("https://api-c.liepin.com/api/'+LIEPIN_SEARCH_METHOD+'?page='+pageNo+'")</script></body>'});
  });
  return context;
}
const city={name:'北京'},base={taskId:'fixture',request:{minimumIntervalMs:0},wait:async()=>{},maxPages:10,responseTimeoutMs:1000};
const collect=(name,mode='success',opts={})=>collectLiepin('测试工程师',city,{...base,checkpointPath:path.join(dir,name+'.json'),contextFactory:()=>factory(mode),maxRows:100,...opts});
try{
  const capped=await collect('resume','success',{maxRows:1});assert.equal(capped.length,1);
  let saved=JSON.parse(await fs.readFile(path.join(dir,'resume.json'),'utf8'));assert.equal(saved.nextPageNo,0);assert.equal(saved.nextCardIndex,1);assert.equal(saved.completed,false);assert.equal(saved.task_id,'fixture');
  const resumed=await collect('resume','success',{maxRows:4});assert.equal(resumed.length,4);assert.equal(resumed[0].collected_at,capped[0].collected_at);
  saved=JSON.parse(await fs.readFile(path.join(dir,'resume.json'),'utf8'));assert.equal(saved.completed,true);assert.ok(saved.records.every(row=>row.task_id==='fixture'));
  const before=contexts;assert.equal((await collect('resume')).length,4);assert.equal(contexts,before,'completed checkpoint must not open browser');
  await assert.rejects(collect('blocked','rate'),e=>e.code==='access_blocked'&&e.partialRows.length===2);
  saved=JSON.parse(await fs.readFile(path.join(dir,'blocked.json'),'utf8'));assert.equal(saved.completed,false);assert.equal(saved.nextPageNo,1);assert.equal(saved.records.length,2);
  const started=Date.now();await assert.rejects(collect('verification','verify'),e=>e.code==='verification_required');assert.ok(Date.now()-started<3000);
  await assert.rejects(collect('repeat','repeated'),e=>e.code==='pagination_stalled'&&e.partialRows.length===2);
  await assert.rejects(collect('wrong-page','foreign'),e=>e.code==='pagination_stalled');
  await assert.rejects(collect('resume','success',{taskId:'foreign'}),e=>e.code==='TASK_OUTPUT_OWNERSHIP');
  const limited=await collect('window','success',{maxPages:1});assert.equal(limited.length,2);assert.equal(JSON.parse(await fs.readFile(path.join(dir,'window.json'),'utf8')).completed,false);
  // A checkpoint and its failure diagnostics never contain credentials or raw
  // network headers. Assertions use synthetic fixtures, not the user's Cookie.
  for(const name of await fs.readdir(dir)){const bytes=await fs.readFile(path.join(dir,name),'utf8');assert.doesNotMatch(bytes,/set-cookie|authorization|lt_auth|requestHeaders/i);}
  assert.equal(closed,contexts,'all leases released on success and failure');
  console.log(JSON.stringify({ok:true,dir,networkRequestsToPlatforms:0,mockedRequests:requests.length,checks:['historical response schema','same-page resume','dedupe','task ownership','completed fast path','HTTP429 partial preservation','SMS/captcha prompt stop','wrong/repeated pages stop','maxPages not exhausted','list-only truthfulness','no credentials persisted','browser leases released']}));
}finally{await browser.close();}
