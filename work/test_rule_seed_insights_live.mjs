import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {chromium} from 'playwright';
const origin='http://127.0.0.1:8765';
const state=await(await fetch(origin+'/api/insights')).json();
assert.equal(state.status,'completed',state.message);
const report=JSON.parse(await fs.readFile('ui_data/insights/岗位市场洞察.json','utf8'));
const expected=JSON.parse(await fs.readFile('ui_data/keyword_validation/ai_drama_rule_seed_v2/全量筛选结果.json','utf8'));
const evaluation=JSON.parse(await fs.readFile('ui_data/keyword_validation/ai_drama_rule_seed_v2/算法评估.json','utf8'));
assert.equal(report.total_rows,3150);assert.equal(report.sample_rows,evaluation.included);
assert.deepEqual(report.cohort_observations.map(x=>x.row_no).sort((a,b)=>a-b),expected.filter(x=>x.matched).map(x=>x.row_no).sort((a,b)=>a-b));
assert.equal(report.keyword_selection.reviewed_rows,0);
assert.equal(report.keyword_selection.direct_rows,evaluation.direct);assert.equal(report.keyword_selection.expanded_rows,evaluation.expanded);
assert.equal(crypto.createHash('sha256').update(await fs.readFile(report.input_file)).digest('hex'),'296e93bc297af20b4e8dc46950f5a4e40b15453d51178efa6d9ec47329ec084a');
const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/**',r=>r.request().method()==='GET'?r.continue():r.abort());
 await page.goto(origin+'/insights');
 await page.waitForFunction(()=>document.querySelector('#insightFilterAudit')?.textContent.includes('回顾性验证'));
 const audit=await page.locator('#insightFilterAudit').textContent();
 for(const pattern of [new RegExp(String(evaluation.training_seed_rows)),new RegExp(String(evaluation.direct)),new RegExp(String(evaluation.expanded)),/未采用审核标签覆盖筛选/,/非新盲测/])assert.match(audit,pattern);
 assert.equal(await page.locator('.insight-kpis .stat strong').first().textContent(),String(evaluation.included));
 await page.locator('#insightFilterAudit').screenshot({path:'ui_data/keyword_validation/ai_drama_rule_seed_v2/页面验证.png'});
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({ok:true,included:report.sample_rows,salary_rows:report.quality.salary_rows,sourceUnchanged:true,uiRendered:true,pageErrors:errors}));
}finally{await browser.close();}
