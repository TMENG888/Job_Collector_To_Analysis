import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {summarizeCohort} from '../job_collector_ui/public/insight-cohorts.js';
const origin='http://127.0.0.1:8765';
const snapshot=await(await fetch(origin+'/api/insights')).json();
assert.ok(snapshot.report?.cohort_observations?.length,'需要已有洞察报告');
const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
const errors=[];
async function headings(page){
 for(const name of ['高频技能','高频工作内容','业务工作方向','公司行业定位'])assert.equal(await page.getByRole('heading',{name,exact:true}).count(),1,name+'只展示一次');
 for(const name of ['高频技能与工具','主要工作内容','业务应用方向'])assert.equal(await page.getByRole('heading',{name,exact:true}).count(),0,name+'旧静态副本已移除');
 for(const name of ['多技术栈组合','技能条件薪资差异','经验与薪资对标','学历与薪资对标','城市行政分布'])assert.equal(await page.getByRole('heading',{name,exact:true}).count(),1,name+'保留');
}
try{
 for(const legacy of [false,true]){
  const page=await browser.newPage({viewport:{width:1440,height:1050}});
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/**',async route=>{
   if(route.request().method()!=='GET')return route.abort();
   if(new URL(route.request().url()).pathname==='/api/insights'){
    const data=structuredClone(snapshot);if(legacy)delete data.report.cohort_observations;
    return route.fulfill({json:data});
   }
   return route.continue();
  });
  await page.goto(origin+'/insights');
  await page.locator('#cohortExplorer h4').first().waitFor();await headings(page);
  if(!legacy){
   const rows=snapshot.report.cohort_observations;
   assert.match(await page.locator('#cohortSummary').textContent(),new RegExp(rows.length+' 条匹配岗位'));
   const city=rows[0].city;await page.locator('#cohortCity').selectOption(city);
   const summary=summarizeCohort(rows.filter(r=>r.city===city));
   assert.match(await page.locator('#cohortSummary').textContent(),new RegExp(summary.count+' 条匹配岗位'));
   if(summary.skills.length)assert.match(await page.locator('#cohortSkills').textContent(),new RegExp(summary.skills[0].name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
   await page.locator('#resetCohort').click();await headings(page);
   assert.match(await page.locator('#cohortSummary').textContent(),new RegExp(rows.length+' 条匹配岗位'));
   await page.locator('#cohortExplorer').screenshot({path:'work/insight-dashboard-dedup.png'});
  }else{
   assert.match(await page.locator('#cohortExplorer').textContent(),/历史报告汇总/);
   assert.equal(await page.locator('#cohortCity').count(),0);
  }
  await page.close();
 }
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({ok:true,checks:['four statistics shown once','distinct analyses retained','city filtering and reset','legacy aggregate fallback','no mutation requests'],pageErrors:errors}));
}finally{await browser.close();}
