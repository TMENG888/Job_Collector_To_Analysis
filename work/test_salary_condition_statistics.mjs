import fs from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {summarizeCohort,cohortConditionValue,cohortFilterFields,filterCohort,cohortFilterOptions,cohortSalaryStatistics} from '../job_collector_ui/public/insight-cohorts.js';

const rows=Array.from({length:30},(_,i)=>({city:i<20?(i%2?'北京 ':'北京市'):'上海',experience:i%2?'3-5年':'经验不限',education:i%3?'本科':'不限',company_size:'100-299人',employment_type:i<25?'全职':'实习',salary_midpoint_k:i+3,skills:['Python'],tasks:[],domains:[]}));
rows.push({city:'无薪地区',experience:'未明确',education:'未明确',company_size:'未明确',employment_type:'未明确',salary_midpoint_k:null,skills:['SQL']});
assert.equal(filterCohort(rows,{}).length,31);
assert.equal(filterCohort(rows,{city:'北京'}).length,20);
assert.equal(cohortFilterOptions(rows,{},'city').filter(r=>r.value==='北京').length,1);
assert.equal(filterCohort(rows,{education:'不限'}).length,10);
assert.equal(filterCohort(rows,{experience:'经验不限'}).length,15);
assert.equal(filterCohort(rows,{city:'无薪地区'}).length,1);
assert.equal(cohortSalaryStatistics(filterCohort(rows,{city:'无薪地区'})).count,0);
assert.equal(cohortSalaryStatistics([{salary_midpoint_k:2},{salary_midpoint_k:201},{salary_midpoint_k:3},{salary_midpoint_k:200},{salary_midpoint_k:null}]).count,2);
const all=cohortSalaryStatistics(rows);
assert.equal(all.count,30);assert.equal(all.median,17.5);assert.equal(all.mean,17.5);
assert.equal(all.p25,10.25);assert.equal(all.p75,24.75);

const script=await fs.readFile('job_collector_ui/public/app.js','utf8');
assert.ok(!script.includes('salaryEstimatorMarkup(report)'));
assert.ok(!script.includes('bindSalaryEstimator(report)'));
const ids=['cohortCity','cohortExperience','cohortEducation','cohortCompanySize','cohortEmployment'];
const elements=new Map();
function element(id){
 if(!elements.has(id))elements.set(id,{value:'',innerHTML:'',textContent:'',addEventListener(type,fn){this[type]=fn;},remove(){}});
 return elements.get(id);
}
const selects=ids.map(element);
const root=element('cohortExplorer');
root.querySelectorAll=()=>selects;
const context=vm.createContext({$:id=>element(id.slice(1)),number:value=>Number(value).toLocaleString('en-US'),percent:value=>(value*100).toFixed(1)+'%',escapeHtml:value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),summarizeCohort,cohortConditionValue,filterCohort,cohortFilterOptions,cohortSalaryStatistics,insightBars:()=>'<div>bars</div>',drawCityDetail:()=>{}});
vm.runInContext(script.slice(script.indexOf('function cohortSalaryMarkup()'),script.indexOf('async function loadInsightDatasets()'))+
 script.slice(script.indexOf('function bindCohortExplorer('),script.indexOf('const cityMapCodes ='))+
 '\nglobalThis.bindTest=bindCohortExplorer;',context);
context.bindTest({cohort_observations:rows});
assert.ok(root.innerHTML.includes('data-cohort-filter="education"'));
assert.equal((root.innerHTML.match(/id="salaryEstimator"/g)||[]).length,1);
assert.equal(element('salaryEstimateValue').textContent,'17.5K/月');
selects[0].value='北京';selects[0].change();
assert.ok(element('cohortSummary').innerHTML.includes('20 条匹配岗位'));
assert.equal(element('salaryEstimateSupport').textContent,'20 条');
assert.ok(!selects[4].innerHTML.includes('value="实习"'));
selects[0].value='无薪地区';selects[0].change();
assert.ok(element('cohortSummary').innerHTML.includes('1 条匹配岗位'));
assert.equal(element('salaryEstimateSupport').textContent,'0 条');
assert.equal(element('salaryEstimateBasis').textContent,'有匹配岗位，但没有有效薪资');
element('resetCohort').click();
assert.ok(selects.every(s=>s.value===''));
assert.equal(element('salaryEstimateValue').textContent,'17.5K/月');
context.bindTest({cohort_observations:rows.slice(0,4)});
assert.equal(element('salaryEstimateValue').textContent,'样本不足');

let live;
try { live=JSON.parse(await fs.readFile('ui_data/insights/岗位市场洞察.json','utf8')); }
catch (error) { if(error.code!=='ENOENT') throw error; }
if (!live) {
 console.log('salary-condition-statistics: synthetic fixtures passed; local report integration skipped (no report bundled)');
} else {
const actual=live.cohort_observations;
context.bindTest(live);
const stats=cohortSalaryStatistics(actual);
assert.equal(element('salaryEstimateSupport').textContent,stats.count.toLocaleString('en-US')+' 条');
assert.equal(stats.count,live.salary_model.observed_samples.length);
assert.equal(element('salaryEstimateValue').textContent,stats.median.toFixed(1)+'K/月');
let combinations=0;
for(const row of actual.filter((_,i)=>i%67===0)){
 const profile={};
 for(const field of cohortFilterFields){
  const value=cohortConditionValue(row,field);
  assert.ok(cohortFilterOptions(actual,profile,field).some(o=>o.value===value&&o.count>0));
  profile[field]=value;
  assert.ok(filterCohort(actual,profile).length>0);combinations++;
 }
}
console.log(JSON.stringify({passed:true,live_jobs:actual.length,valid_salary_rows:stats.count,median_k:stats.median,nonempty_progressive_combinations:combinations,checks:'五项联动、空格/市名归一、实际取值、原文不限、统一岗位/薪资范围、无薪岗位不误报无岗位、重置、小样本、真实报告'}));
}
