export function normalize51Records(records,keyword,city,total,{htmlToText,collectedAt}) {
  return records.map(row=>({
    platform:'前程无忧',query_keyword:keyword,query_city:city.name,job_id:String(row.jobId),job_name:row.jobName,
    company_id:row.encCoId,company_name:row.fullCompanyName||row.companyName,salary:row.provideSalaryString,
    city:row.jobAreaLevelDetail?.cityString||row.jobAreaString,district:row.jobAreaLevelDetail?.districtString||'',experience:row.workYearString,
    education:row.degreeString,employment_type:row.isIntern?'实习':row.jobType,company_nature:row.companyTypeString,
    company_size:row.companySizeString,industry:row.companyIndustryType1Str||row.industryType1Str,publish_time:row.issueDateString,
    refresh_time:row.updateDateTime||row.confirmDateString,deadline:'',tags:(row.jobTags||[]).join(' | '),
    skills:(row.sesameLabelList||[]).map(item=>item.label||item.name||item).join(' | '),job_description:htmlToText(row.jobDescribe),
    address:row.address||row.jobAreaString,recruiter_name:row.hrName,recruiter_title:row.hrPosition,job_url:row.jobHref,
    company_url:row.encCoId?`https://jobs.51job.com/all/co${row.encCoId}.html`:'',source_total:total,access_level:'页面会话完整列表字段',collected_at:collectedAt,
  }));
}
