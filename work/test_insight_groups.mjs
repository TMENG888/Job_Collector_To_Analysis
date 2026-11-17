import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {provinceName,experienceGroup,companySizeGroup,educationGroup,filterInsightCohort,insightFilterOptions,companyRecruitingRanking} from '../job_collector_ui/public/insight-groups.js';
import {filterCohort} from '../job_collector_ui/public/insight-cohorts.js';
import {provinceCohortStatistics,renderCompanyRanking} from '../job_collector_ui/public/insight-dashboard.js';
import {distribution,salaryExperienceGroups} from '../job_collector_ui/public/insight-profile-charts.js';
import {createInsightReportCache} from './insight-report-cache.mjs';
import {DatabaseSync} from 'node:sqlite';

test('province mapping handles municipalities, province-level addresses, prefectures and multiple locations',()=>{
  for(const [city,expected]of [['深圳市-南山区','广东'],['广东省广州市天河区','广东'],['北京市海淀区','北京'],['呼和浩特市','内蒙古'],['延边','吉林'],['乌鲁木齐','新疆'],['海南州','青海'],['三亚','海南'],['陕西省','陕西'],['广州/深圳','广东'],['广州/上海','多省份'],['全国','全国/地点不限'],['海外','海外'],['城市编码440300','未明确']])assert.equal(provinceName(city),expected,city);
  assert.equal(provinceName({province:'湖北省',city:'武汉'}),'湖北');
  assert.equal(provinceName({city:'未明确',raw_city:'南京市鼓楼区'}),'江苏');
});
test('experience and company buckets preserve unknown codes and avoid inferring broad upper-only intervals',()=>{
  for(const [value,expected]of [['应届毕业生','在校/应届'],['在校生','在校/应届'],['1年以下','1年以内'],['1年及以上','1-3年'],['3-5年','3-5年'],['5-10年','5-10年'],['10年以上','10年以上'],['无工作经验','经验不限'],['20','未明确'],['2','未明确'],['3年以下','未明确']])assert.equal(experienceGroup(value),expected,value);
  for(const [value,expected]of [['20-99人','100人以下'],['150-500人','100-499人'],['500-2000人','500-999人'],['1000-9999人','1000-9999人'],['10000人以上','10000人及以上'],['1万人以上','10000人及以上'],['少于50人','100人以下'],['500人以下','未明确'],['50','未明确']])assert.equal(companySizeGroup(value),expected,value);
  assert.equal(educationGroup('1'),'未明确');assert.equal(educationGroup('中技/中专'),'中专/中技');
});
const rows=[
  {knowledge_key:'K1',platform:'甲平台',job_id:'1',company_name:'甲科技',city:'广州',experience:'1-3年',company_size:'100-299人',education:'本科',salary_midpoint_k:10},
  {knowledge_key:'K2',platform:'乙平台',job_id:'2',company_name:'甲科技',city:'深圳',experience:'2年',company_size:'150-500人',education:'本科',salary_midpoint_k:12},
  {knowledge_key:'K3',platform:'甲平台',job_id:'3',company_name:'乙科技',city:'杭州',experience:'5-10年',company_size:'500-2000人',education:'硕士',salary_midpoint_k:20},
  {knowledge_key:'K4',company_name:'',city:'北京',experience:'50',company_size:'20',education:'0'}
];
test('linked facets, chart totals and companies use identical scopes while assistant raw-city scopes remain compatible',()=>{
  const profile={province:'广东',experience:'1-3年',company_size:'100-499人'};
  const selected=filterInsightCohort(rows,profile);assert.equal(selected.length,2);
  assert.deepEqual(insightFilterOptions(rows,profile,'province').map(item=>item.value),['广东']);
  assert.equal(distribution(selected,'province')[0].count,2);assert.equal(distribution(selected,'experience')[0].count,2);
  assert.equal(salaryExperienceGroups(selected)[0].count,2);assert.equal(provinceCohortStatistics(rows)[0].count,2);
  assert.equal(companyRecruitingRanking(selected).rows[0].count,2);
  assert.equal(filterCohort(rows,{city:'广州',experience:'1-3年'}).length,1);
  assert.equal(filterInsightCohort(rows,{province:'不存在'}).length,0);
});
test('company top10 deduplicates source jobs, merges same names, excludes missing names, stable ties and escapes HTML',()=>{
  const ranking=companyRecruitingRanking([...rows,rows[0],{...rows[0],company_name:' 甲科技 ',knowledge_key:'K5',job_id:'5'}]);
  assert.equal(ranking.knownJobs,4);assert.equal(ranking.rows[0].count,3);assert.equal(ranking.rows[0].share,.75);assert.equal(ranking.companyCount,2);
  assert.equal(companyRecruitingRanking(Array.from({length:15},(_,i)=>({company_name:'企业'+i,platform:'P',job_id:String(i)}))).rows.length,10);
  assert.match(renderCompanyRanking(rows),/不等同于实际招聘人数/);
  assert.doesNotMatch(renderCompanyRanking([{company_name:'<script>',platform:'P',job_id:'1'}]),/<script>/);
  assert.match(renderCompanyRanking([]),/没有可识别公司名称/);
});
test('historical report worker enriches company names from exact content versions without writing source or database',async()=>{
  const dir=await fs.mkdtemp('E:/Codex/temp/20261111-insight-provinces/report-'),dbFile=path.join(dir,'knowledge.sqlite'),reportFile=path.join(dir,'report.json');
  const db=new DatabaseSync(dbFile);db.exec('CREATE TABLE job_versions(job_key TEXT,content_hash TEXT,raw TEXT); CREATE TABLE jobs(job_key TEXT,content_hash TEXT,raw TEXT);');
  db.prepare('INSERT INTO job_versions VALUES(?,?,?)').run('K1','old',JSON.stringify({company_name:'历史公司',province:'广东省'}));
  db.prepare('INSERT INTO jobs VALUES(?,?,?)').run('K1','new',JSON.stringify({company_name:'新公司'}));db.close();
  const source=JSON.stringify({cohort_observations:[{knowledge_key:'K1',knowledge_hash:'old',city:'深圳'},{knowledge_key:'missing',knowledge_hash:'none'}]});await fs.writeFile(reportFile,source);
  const cache=createInsightReportCache(reportFile,{knowledgeFilename:dbFile});const result=await cache.load(),data=JSON.parse(result.raw);
  assert.equal(data.cohort_observations[0].company_name,'历史公司');assert.equal(data.cohort_observations[0].province,'广东');
  assert.equal(data.cohort_observations[1].company_name,undefined);assert.equal(data.company_ranking.rows[0].name,'历史公司');assert.equal(await fs.readFile(reportFile,'utf8'),source);
  assert.equal(await cache.load(),result);
});
