import {parseOriginalSalary} from './job_salary_parser.mjs';
import {cohortNeedsReview} from './job_assistant_goal.mjs';

// A versioned derived view, never a replacement for immutable source records.
export const ADMISSION_VERSION='admission-v4-20261016-multirole-lr';
const degrees=['大专','本科','硕士','博士'];
export function canonicalEducation(value){
  const text=String(value||'');
  if(/不限|不要求|无要求/.test(text))return '不限';
  return degrees.find(d=>text.includes(d))||(/研究生/.test(text)?'硕士':'未明确');
}
export function educationAdmits(job,education,{strict=false}={}){
  if(!education)return true;
  const required=canonicalEducation(job.education);
  if(required==='未明确')return !strict;
  return required==='不限'||degrees.indexOf(required)<=degrees.indexOf(education);
}
export function admitKnowledgeJobs(jobs){
  // The repeated 9.9K sentinel is an observed source anomaly, not proof of fraud.
  const suspectCounts=new Map();
  for(const j of jobs)if(/^9\.9[-~～–—至到]9\.9千(?:\/月)?$/.test(j.salary_raw.replace(/\s/g,'')))suspectCounts.set(j.platform,(suspectCounts.get(j.platform)||0)+1);
  return jobs.map(job=>{
    const salary=parseOriginalSalary(job.salary_raw),reasons=[];
    if(!salary)reasons.push('salary_unparsed');
    if((suspectCounts.get(job.platform)||0)>=5&&/^9\.9[-~～–—至到]9\.9千(?:\/月)?$/.test(job.salary_raw.replace(/\s/g,'')))reasons.push('repeated_9_9k_pending_verification');
    const education=canonicalEducation(job.education);
    if(education==='未明确')reasons.push('education_unknown');
    if(cohortNeedsReview(job))reasons.push('cohort_conflict_pending_review');
    const expired=job.explicitly_closed===true;
    if(expired)reasons.push('explicitly_closed');
    const admitted=job.decision==='include'&&!expired;
    return {...job,education,salary_midpoint_k:salary?.period==='month'?salary.midpoint/1000:null,
      salary_basis:salary?.period==='month'?'招聘月薪中点':'非月薪原始报价（不折算）',
      admission:{version:ADMISSION_VERSION,retrieval:admitted,salary:admitted&&!!salary&&!reasons.includes('repeated_9_9k_pending_verification')&&!reasons.includes('cohort_conflict_pending_review'),reasons,
        currency:'CNY',freshness:'仅明确关闭状态拦截；当前在招状态仍需核验'}};
  });
}
export function admissionSummary(jobs){
  const reasons={};for(const j of jobs)for(const reason of j.admission?.reasons||[])reasons[reason]=(reasons[reason]||0)+1;
  return {version:ADMISSION_VERSION,total:jobs.length,retrieval_admitted:jobs.filter(j=>j.admission?.retrieval).length,
    salary_admitted:jobs.filter(j=>j.admission?.salary).length,reasons,
    notice:'规则与监督分类准入不是人工金标准；原始记录、版本、人工标签不删除。疑似异常薪资仅暂停用于对标，需原站/人工复核。'};
}
