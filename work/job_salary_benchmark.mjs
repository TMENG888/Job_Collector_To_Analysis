import {hiringCohorts,goalLabels} from './job_assistant_goal.mjs';

import {parseOriginalSalary} from './job_salary_parser.mjs';
import {educationAdmits} from './job_data_admission.mjs';
export {parseOriginalSalary} from './job_salary_parser.mjs';
const quantile=(values,p)=>{if(!values.length)return null;const sorted=[...values].sort((a,b)=>a-b),pos=(sorted.length-1)*p,i=Math.floor(pos);return sorted[i]+(sorted[Math.min(i+1,sorted.length-1)]-sorted[i])*(pos-i);};
function groupStatistics(rows){
  const values=rows.map(j=>j.original_salary.midpoint),count=values.length;
  return {count,published:count>=5,median:count>=5?quantile(values,.5):null,p25:count>=5?quantile(values,.25):null,p75:count>=5?quantile(values,.75):null,
    period_inferred_rows:rows.filter(j=>j.original_salary.period_inferred).length,pay_months_distribution:rows.reduce((out,j)=>{const p=j.original_salary.pay_months,key=p?`${p.min}${p.max!==p.min?'-'+p.max:''}薪`:'未公开';out[key]=(out[key]||0)+1;return out;},{})};
}
const fmt=(value,period)=>period==='month'?`${(value/1000).toFixed(1)}K/月`:period==='year'?`${(value/10000).toFixed(1)}万元/年`:`${Math.round(value)}${goalLabels[period]}`;
export function salaryQuestions(goal={}){
  const questions=[];
  if(goal.analysis_mode==='market'){
    if(!goal.roles?.length&&goal.roles_source!=='unrestricted')questions.push('希望对标哪些岗位方向？可以同时选择多个。');
    return questions;
  }
  if(!goal.stage)questions.push('你要找实习、正式校招还是社招？');
  if(!goal.city&&!goal.cities?.length&&goal.city_source!=='unrestricted')questions.push('主要考虑哪些城市？可以同时选择多个。');
  if(!goal.roles?.length&&goal.roles_source!=='unrestricted')questions.push('希望对标哪些岗位方向？可以同时选择多个。');
  if(!goal.education&&goal.education_source!=='unrestricted')questions.push('你的最高学历是本科、硕士、博士还是大专？不根据学校名称推断。');
  if(goal.stage==='campus'&&!goal.graduation_year&&goal.cohort_source!=='unrestricted')questions.push('你是哪一届毕业生？');
  if(goal.stage==='social'&&goal.years==null&&!goal.experience&&goal.experience_source!=='unrestricted')questions.push('你有几年全职工作经验？实习不折算为全职年限。');
  return questions;
}
export function buildSalaryBenchmark(jobs,{goal={},resumeSkills=[],hasResume=false,singleSegment=false}={}){
  const questions=salaryQuestions(goal),cities=goal.cities?.length?goal.cities:goal.city?[goal.city]:[];
  const emptyGroups=()=>Object.fromEntries(['day','hour','month','year'].map(p=>[p,groupStatistics([])]));
  if(questions.length)return {groups:emptyGroups(),city_groups:[],segments:[],primary_period:goal.salary_period||'month',matched_jobs:jobs.length,benchmark_jobs:0,questions,suggestion:null,evidence_keys:[],message:'已保存已明确的求职目标，补充后继续原任务，不需重述。\n\n'+questions.join('\n\n')};
  if(!singleSegment&&(cities.length>1||goal.roles?.length>1)){
    const segments=(cities.length?cities:[null]).flatMap(city=>(goal.roles?.length?goal.roles:[null]).map(role=>({city:city||'不限城市',role:role||'不限方向',...buildSalaryBenchmark(jobs.filter(j=>(!city||j.city===city)&&(!role||j.role_families?.includes(role))),{goal:{...goal,city,cities:city?[city]:[],roles:role?[role]:[]},resumeSkills,hasResume,singleSegment:true})})));
    return {groups:emptyGroups(),city_groups:[],segments,primary_period:goal.salary_period||'month',matched_jobs:jobs.length,benchmark_jobs:segments.reduce((n,s)=>n+s.benchmark_jobs,0),questions:[],suggestion:null,
      evidence_keys:[...new Set(segments.flatMap(s=>s.evidence_keys.slice(0,1)).concat(segments.flatMap(s=>s.evidence_keys)))].slice(0,4),
      message:'按城市 × 岗位方向分别对标，不混合为个人报价；同一岗位可能属于多个方向，各组数量不能相加视为独立岗位。\n\n'+segments.map(s=>`### ${s.city} · ${s.role}\n\n${s.message}`).join('\n\n')};
  }
  const unknownCohort=goal.stage==='campus'&&goal.graduation_year?jobs.filter(j=>!hiringCohorts(j).length):[];
  const cohortEligible=goal.stage==='campus'&&goal.graduation_year?jobs.filter(j=>hiringCohorts(j).includes(Number(goal.graduation_year))):jobs;
  const eligible=cohortEligible.filter(j=>educationAdmits(j,goal.education,{strict:true})&&j.admission?.salary!==false);
  const excluded={education_unknown:cohortEligible.filter(j=>!educationAdmits(j,goal.education,{strict:true})).length,salary_quality:cohortEligible.filter(j=>j.admission?.salary===false).length};
  const parsed=eligible.map(j=>({...j,original_salary:parseOriginalSalary(j.salary_raw)})).filter(j=>j.original_salary);
  const groups=Object.fromEntries(['day','hour','month','year'].map(period=>[period,groupStatistics(parsed.filter(j=>j.original_salary.period===period))]));
  const cityGroups=[...new Set(parsed.map(j=>j.city||'未明确'))].map(city=>({city,groups:Object.fromEntries(['day','hour','month','year'].map(period=>[period,groupStatistics(parsed.filter(j=>j.city===city&&j.original_salary.period===period))]))}));
  const unit=goal.salary_period||'month',primary=groups[unit];
  const skillEvidence=[...new Set(parsed.flatMap(j=>(j.skills||[]).filter(s=>resumeSkills.includes(s))))].slice(0,8);
  const publish=primary.published&&questions.length===0;
  const suggestion=publish&&goal.analysis_mode!=='market'?{kind:'谈判参考，非个人薪资预测',unit,opening:primary.median,
    negotiable:{min:primary.p25,max:primary.p75},reasons:[`同条件${primary.count}条原始${goalLabels[unit]}报价的中点分布`,...(hasResume?[`简历与样本岗位有${skillEvidence.length}项技术交集：${skillEvidence.join('、')}；提及不代表已核验能力`]:['尚无本轮可用简历，仅给市场谈判锚点'])],
    warning:'不是保底价或录用保证；取决于技术面试、职责、公司预算及福利，区间下沿不代表个人最低接受价'}:null;
  const lines=[`${goal.analysis_mode==='market'?'市场统计范围':'求职目标'}：${goalLabels[goal.stage]||'待明确'}${goal.graduation_year&&!['all','formal','social'].includes(goal.stage)?` · ${goal.graduation_year}届`:''}${goal.city?` · ${goal.city}`:' · 城市未限定'}${goal.education?` · ${goal.education}`:''}${goal.roles?.length?` · ${goal.roles.join('、')}`:''}。`];
  if(goal.unit_conflict)lines.push('你同时提到“一天报价”和秋招：正式校招按月薪／年包分析，日薪只用于提前实习，不混算。');
  lines.push(`当前资格筛选范围${jobs.length}条；薪资对标纳入${eligible.length}条${goal.stage==='campus'&&goal.graduation_year?'明确匹配毕业届次的岗位':''}，${unknownCohort.length}条届次未明确（不进入指定届次主统计）。`);
  if(excluded.education_unknown||excluded.salary_quality)lines.push(`准入排除：学历门槛未知或不满足 ${excluded.education_unknown} 条，薪资缺失／疑似异常待复核 ${excluded.salary_quality} 条；不删除原始数据，原因可能重叠。`);
  for(const [period,s] of Object.entries(groups))if(s.count)lines.push(`${goalLabels[period]}：${s.count}条原始报价；${s.published?`报价中点中位数${fmt(s.median,period)}，25%–75%为${fmt(s.p25,period)}—${fmt(s.p75,period)}`:'不足5条，暂不发布市场分位数'}${s.period_inferred_rows?`；${s.period_inferred_rows}条月薪周期按招聘格式推定，需向招聘方确认`:''}。`);
  if(groups.month.count)lines.push('月薪薪数：'+Object.entries(groups.month.pay_months_distribution).map(([label,count])=>`${label} ${count}条`).join('、')+'。');
  if(!parsed.length)lines.push('当前同条件没有可用的原始薪资，不能据其他届次、实习日薪或社招工资推算你的报价。');
  if(suggestion)lines.push(`谈判建议：可从${fmt(suggestion.opening,unit)}沟通，可谈参考范围${fmt(suggestion.negotiable.min,unit)}—${fmt(suggestion.negotiable.max,unit)}。依据：${suggestion.reasons.join('；')}。${suggestion.warning}。`);
  else if(goal.analysis_mode==='market')lines.push('以上为招聘样本分布，不是个人报价，也不代表职业薪资天花板。');
  else lines.push('暂不给个人开价：'+(questions.length?questions.join(' '):`同条件原始${goalLabels[unit]}样本不足5条。`));
  lines.push('日薪、时薪、月薪、原始年包分开统计；薪数未公开不默认12薪，名义年薪不等于保证总包。跨平台疑似同岗仍可能重复；记录是否仍在招需复核。');
  return {groups,city_groups:cityGroups,segments:[],excluded,primary_period:unit,matched_jobs:jobs.length,benchmark_jobs:eligible.length,unknown_cohort_rows:unknownCohort.length,
    unparsed_salary_rows:eligible.length-parsed.length,questions,suggestion,message:lines.join('\n\n'),
    evidence_keys:parsed.sort((a,b)=>Number(b.original_salary.period===unit)-Number(a.original_salary.period===unit)).slice(0,4).map(j=>j.key)};
}
