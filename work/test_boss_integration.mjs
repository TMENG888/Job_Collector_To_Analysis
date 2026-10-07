import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';
import {bossSearchUrl,bossJobUrl,bossBlockedReason,bossPageGuard,extractBossCards,extractBossDetail,bossCsv} from './boss_page_adapter.mjs';
const root=path.resolve(import.meta.dirname,'..'),testDir=await fs.mkdtemp(path.join(os.tmpdir(),'boss-integration-'));
const port=Number(process.env.BOSS_TEST_PORT||8786),origin='http://127.0.0.1:'+port;
const server=spawn(process.execPath,[path.join(root,'job_collector_ui/server.mjs'),String(port)],{cwd:root,env:{...process.env,JOB_UI_DATA_DIR:testDir,JOB_UI_OPEN_BROWSER:'0',JOB_UI_PORT:String(port)},windowsHide:true,stdio:['ignore','pipe','pipe']});
let log='',browser;server.stdout.on('data',x=>log+=x);server.stderr.on('data',x=>log+=x);
async function waitFor(fn){for(let i=0;i<100;i++){const result=await fn().catch(()=>null);if(result)return result;await new Promise(r=>setTimeout(r,100));}throw Error('超时：'+log);}
async function request(url,body){const response=await fetch(origin+url,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});const result=await response.json();assert.ok(response.ok,JSON.stringify(result));return result;}
try{
 await waitFor(async()=>{if(server.exitCode!=null)throw Error(log);return (await fetch(origin+'/api/state')).ok;});
 assert.ok((await request('/api/state')).capabilities.bossCollection);
 assert.equal((await request('/api/platforms')).platforms.find(p=>p.key==='boss').status,'not_logged_in');
 browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin+'/platforms');await page.locator('[data-platform-login="boss"]').waitFor();
 assert.match(await page.locator('[data-platform-login="boss"]').locator('..').locator('..').textContent(),/BOSS直聘/);
 await page.goto(origin+'/');assert.equal(await page.locator('#platformChecks input[value="boss"]').count(),1);
 assert.equal(await page.locator('#platformChecks input[value="boss"]').isChecked(),false);
 const {task}=await request('/api/tasks',{label:'爬虫工程师BOSS测试',primaryKeyword:'爬虫工程师',keywords:['爬虫工程师'],platforms:['boss'],cities:['北京'],targetRows:2,outputDir:path.join(testDir,'output')});
 assert.deepEqual(task.platforms,['boss']);
 const saved=JSON.parse(await fs.readFile(path.join(testDir,'tasks.json'),'utf8')).find(x=>x.id===task.id);
 const config=JSON.parse(await fs.readFile(saved.bossConfigPath,'utf8'));
 assert.equal(config.maxRows,4);assert.equal(config.minimumIntervalMs,6000);assert.equal(config.cities[0].code,'101010100');
 await page.goto(origin+'/tasks/'+task.id);await page.locator('[data-action="boss"]').waitFor();
 // With no saved session, the collector must pause before opening any real site.
 await request('/api/tasks/'+task.id+'/run',{stage:'boss'});
 const paused=await waitFor(async()=>{const t=(await request('/api/tasks/'+task.id)).task;return t.status==='paused'?t:null;});
 assert.match(paused.message,/BOSS采集暂停/);
 const cp=JSON.parse(await fs.readFile(path.join(task.outputDir,'断点数据/BOSS直聘/state.json'),'utf8'));
 assert.equal(cp.status,'paused');assert.match(cp.message,/人工登录/);assert.equal(cp.rows.length,0);
 // Use a separate page so application polling cannot mutate the DOM fixtures.
 const fixture=await browser.newPage();
 await fixture.setContent('<div class="job-card-wrapper"><a href="https://www.zhipin.com/job_detail/abc123.html?x=1"><span class="job-name">爬虫工程师</span><span class="salary">15-25K</span><span class="job-area">北京·海淀</span></a><span class="company-name">测试公司</span><ul class="tag-list"><li>3-5年</li><li>本科</li></ul></div>');
 const cards=await extractBossCards(fixture);assert.equal(cards.length,1);assert.equal(cards[0].url,'https://www.zhipin.com/job_detail/abc123.html');
 await fixture.setContent('<div class="job-banner"><h1>爬虫工程师</h1><span class="salary">15-25K</span></div><div class="job-sec-text">负责Python爬虫开发、数据清洗与入库。</div><div class="location-address">北京海淀</div>');
 const row=await extractBossDetail(fixture,cards[0],'爬虫工程师','北京');
 assert.equal(row.platform,'BOSS直聘');assert.equal(row.job_id,'abc123');assert.equal(row.education,'本科');assert.equal(row.employment_type,'');assert.match(row.job_description,/数据清洗/);
 await fixture.setContent('<div class="verify-wrap">请完成验证</div>');await assert.rejects(bossPageGuard(fixture),/人工处理/);
 await fixture.setContent('<div>职位描述未加载</div>');await assert.rejects(extractBossDetail(fixture,cards[0],'爬虫工程师','北京'),/详情结构/);
 assert.ok(bossBlockedReason({status:429}));assert.ok(bossBlockedReason({login:true}));assert.equal(bossBlockedReason({text:'普通招聘页'}),'');
 assert.equal(bossJobUrl('https://evil.example/job_detail/abc.html'),null);assert.equal(bossJobUrl('https://www.zhipin.com/job_detail/abc.html?token=sensitive'),'https://www.zhipin.com/job_detail/abc.html');
 assert.match(bossSearchUrl('爬虫工程师','北京'),/city=101010100/);assert.throws(()=>bossSearchUrl('职位','不存在'),/不支持/);
 // Generic merge must discover BOSS CSV, remove duplicates and expose a native final dataset.
 await fs.writeFile(path.join(task.outputDir,'boss_标准化数据.csv'),bossCsv([row,row]));
 await request('/api/tasks/'+task.id+'/run',{stage:'finalize'});
 await waitFor(async()=>{const t=(await request('/api/tasks/'+task.id)).task;return t.status==='ready'&&t.currentStage==='finalize';});
 const quality=JSON.parse(await fs.readFile(path.join(task.outputDir,'数据质量报告.json'),'utf8'));
 assert.equal(quality.output_rows,1);assert.equal(quality.duplicates_removed,1);
 const source=await request('/api/tasks/'+task.id+'/insight-source');assert.equal(source.dataset.expectedRows,1);
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({ok:true,testDir,checks:['platform login card','task platform option','config and city mapping','missing session pauses without real-site access','DOM details','captcha guard','canonical URLs','CSV merge/dedup and insight transfer'],realBossSiteTested:false,pageErrors:errors}));
}finally{await browser?.close();server.kill();}
