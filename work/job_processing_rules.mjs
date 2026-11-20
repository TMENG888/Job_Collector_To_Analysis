import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {normalizeSalary,normalizeEmploymentType} from './job_knowledge_schema.mjs';
import {provinceName,experienceGroup,educationGroup,companySizeGroup} from '../job_collector_ui/public/insight-groups.js';
import {cityName} from '../job_collector_ui/public/insight-cohorts.js';

export const PROCESSING_VERSION='job-processing-v1-20261119';
// Invalidate derived caches when any shared rule changes, including this module.
export const PROCESSING_HASH=createHash('sha256').update(['./job_processing_rules.mjs','./job_knowledge_schema.mjs','./job_salary_parser.mjs','../job_collector_ui/public/insight-groups.js','../job_collector_ui/public/insight-cohorts.js'].map(file=>readFileSync(new URL(file,import.meta.url),'utf8')).join('\n')).digest('hex');
export const plainJobText=value=>String(value??'').replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/\s+/g,' ').trim();
export function jobInputUsability(raw){
  const body=plainJobText(raw.job_description);
  const errorBody=body.length<500&&/^(?:请先登录|登录后(?:查看|可见)|访问(?:失败|被拒绝)|请求失败|系统繁忙|验证码|安全验证|403\b|404\b|502\b)|^(?:error|access denied|forbidden)\b/i.test(body);
  const identity=!!String(raw.platform||'').trim()&&!!String(raw.job_id||'').trim()&&!!String(raw.job_name||'').trim();
  const bodyUsable=body.length>=16&&!errorBody;
  return {identity,bodyUsable,errorBody,body};
}
export function normalizeJobFields(raw){
  const salary=normalizeSalary(raw.salary),{body,bodyUsable,errorBody,identity}=jobInputUsability(raw);
  const province=provinceName(raw),salaryUsable=!!salary&&salary.midpoint/1000>=(salary.converted?Number.MIN_VALUE:3)&&salary.midpoint/1000<=200;
  const issues=[];
  if(!identity)issues.push('岗位身份或名称缺失');
  if(!bodyUsable)issues.push(errorBody?'正文疑似访问提示':body?'正文不足16字':'正文缺失');
  if(!salary)issues.push(/面议|保密|待定/.test(String(raw.salary||''))?'薪资面议/保密':'薪资未能转换为月薪');
  else if(!salaryUsable)issues.push('薪资超出图表统计范围');
  if(province==='未明确')issues.push('地区待核对');
  const education=educationGroup(raw.education),experience=experienceGroup(raw.experience);
  if(education==='未明确')issues.push('学历待核对');
  if(experience==='未明确')issues.push('经验待核对');
  return {version:PROCESSING_VERSION,rulesHash:PROCESSING_HASH,salary,
    fields:{city:cityName(raw.city),province,education,experience,company_size:companySizeGroup(raw.company_size),employment_type:normalizeEmploymentType(raw.employment_type),
      salary_min:salary?.min??null,salary_max:salary?.max??null,salary_midpoint_k:salary?salary.midpoint/1000:null,salary_period:salary?.original_period||'',salary_basis:salary?.basis||'无可用月薪',salary_conversion_days:salary?.conversion_days??null},
    usability:{jobs:identity,body:bodyUsable,salary:salaryUsable,province:!['未明确','全国/地点不限','多省份','海外'].includes(province),input:identity&&bodyUsable},issues};
}
export function jobProcessingChanges(raw,processed=normalizeJobFields(raw)){
  const f=processed.fields;
  return [
    ['薪资',raw.salary,processed.salary?`${f.salary_min.toFixed(2)}—${f.salary_max.toFixed(2)} 元/月；中点 ${Number((f.salary_midpoint_k*1000).toFixed(2))} 元`:'无可用月薪',f.salary_basis+'；不计奖金、不推断年薪；面议不填0'],
    ['地区',raw.city,`${f.province} / ${f.city}`,'沿用岗位洞察省份映射和城市规则'],
    ['学历',raw.education,f.education,'沿用洞察学历分组；数字代码保留原值，未明确不视为不限'],
    ['经验',raw.experience,f.experience,'沿用洞察经验区间分组；未知不视为经验不限'],
    ['公司规模',raw.company_size,f.company_size,'沿用洞察规模分组'],
    ['用工类型',raw.employment_type,f.employment_type,'实习、全职、兼职/临时；缺失为未明确'],
    ['正文',String(raw.job_description||'').slice(0,500),plainJobText(raw.job_description).slice(0,500),'预览去HTML与多余空白；分类、标注仍使用原文以保留证据'],
  ].map(([field,before,after,basis])=>({field,before:before??'',after,basis}));
}
