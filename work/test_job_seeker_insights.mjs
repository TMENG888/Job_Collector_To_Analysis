import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { summarizeCohort, cityName, quantile } from '../job_collector_ui/public/insight-cohorts.js';

const origin=process.env.JOB_INSIGHT_TEST_URL || 'http://127.0.0.1:8765';
const {report}=await (await fetch(`${origin}/api/insights`)).json();
const rows=report.cohort_observations;
assert.equal(rows.length,report.sample_rows);
assert.equal(report.cities.reduce((n,c)=>n+c.count,0),rows.length);
assert.equal(cityName('北京-东城区'),'北京');
for(const city of report.cities){const selected=rows.filter(r=>r.city===city.name);assert.equal(city.count,selected.length);const median=quantile(selected.map(r=>r.salary_midpoint_k),.5);if(median!=null)assert.ok(Math.abs(city.median_salary_k-median)<=.051);else assert.equal(city.median_salary_k,null);}
const summary=summarizeCohort(rows);
if(summary.industries.length)assert.ok(Math.abs(summary.industries.reduce((n,i)=>n+i.share,0)-1)<1e-8);
assert.equal(summary.skills.find(s=>s.name==='Python').count,rows.filter(r=>r.skills.includes('Python')).length);
const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
try{
  const page=await browser.newPage({viewport:{width:1440,height:1000},locale:'zh-CN'});const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin,{waitUntil:'networkidle'});await page.locator('[data-view="insights"]').click();
  await page.locator('#cohortCity').waitFor();
  assert.match(await page.locator('#cohortSummary').innerText(),new RegExp(`${rows.length} 条匹配岗位`));
  await page.locator('#cohortCity').selectOption('北京');await page.locator('#cohortExperience').selectOption('1-3年');
  const expected=rows.filter(r=>r.city==='北京' && r.experience==='1-3年');
  assert.match(await page.locator('#cohortSummary').innerText(),new RegExp(`${expected.length} 条匹配岗位`));
  assert.match(await page.locator('#cohortSkills').innerText(),/Python/);
  await page.locator('#cityDistrictMap svg path').first().waitFor();
  assert.match(await page.locator('#cityMapDetail').innerText(),/区县未明确或未匹配/);
  await page.locator('#resetCohort').click();
  await page.locator('#cityMap .city-mark[aria-label="查看上海岗位"]').click();
  assert.equal(await page.locator('#cohortCity').inputValue(),'上海');
  await page.locator('#cityDistrictMap svg path').first().waitFor();
  await page.locator('#resetCohort').click();
  await page.locator('[data-salary-skill]').first().locator('..').click();
  const model=report.salary_model;const profile=Object.fromEntries(await page.locator('[data-salary-profile]').evaluateAll(es=>es.map(e=>[e.dataset.salaryProfile,e.value])));
  const skills=await page.locator('[data-salary-skill]:checked').evaluateAll(es=>es.map(e=>e.value));
  const matching=model.observed_samples.filter(r=>Object.keys(profile).every(k=>r[k]===profile[k]) && skills.every(s=>r.skills.includes(s)));
  assert.equal(await page.locator('#salaryEstimateSupport').innerText(),`${matching.length} 条`);
  if(matching.length>=5)assert.equal(await page.locator('#salaryEstimateValue').innerText(),`${quantile(matching.map(r=>r.salary_midpoint_k),.5).toFixed(1)}K/月`);
  const out=path.resolve('outputs','crawler-insight-test');
  await fs.mkdir(out,{recursive:true});
  await page.locator('#cohortExplorer').scrollIntoViewIfNeeded();
  await page.screenshot({path:`${out}\\岗位洞察_桌面验证.png`});
  await page.setViewportSize({width:390,height:844});
  await page.locator('#cohortExplorer').scrollIntoViewIfNeeded();
  await page.screenshot({path:`${out}\\岗位洞察_手机验证.png`});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'Mobile should not overflow horizontally');
  await page.setViewportSize({width:1440,height:1000});
  await page.locator('[data-view="labels"]').click();
  await page.locator('[data-label-job="1790913948169-label"]').click();
  await page.getByRole('button',{name:'用于岗位洞察',exact:true}).click();
  assert.equal(await page.locator('#insightForm input[name="inputFile"]').inputValue(),report.input_file);
  assert.equal(await page.locator('#insightLabelJob').inputValue(),'auto');
  const started=page.waitForResponse(r=>r.url().endsWith('/api/insights/run') && r.request().method()==='POST');
  await page.locator('#runInsight').click();
  assert.ok((await started).ok());
  let regenerated;
  for(let attempt=0;attempt<90;attempt++) {
    regenerated=await (await fetch(`${origin}/api/insights`)).json();
    if(regenerated.status==='completed' && regenerated.report.generated_at!==report.generated_at)break;
    if(regenerated.status==='failed')throw new Error(regenerated.error);
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  assert.equal(regenerated.status,'completed');assert.equal(regenerated.report.label_provenance.job_id,'1790913948169-label');
  assert.notEqual(regenerated.report.generated_at,report.generated_at);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,rows:rows.length,beijing_1_3:expected.length,matched_skill_rows:matching.length,city_drilldown:true,mobile:true,label_to_insight:true,live_regeneration:true}));
}finally{await browser.close();}
