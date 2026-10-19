import {hiringCohorts,cohortNeedsReview} from './job_assistant_goal.mjs';
// Extract only allowlisted matching facts. Never return resume excerpts or identity.
export function extractResumeProfile(resume='') {
  const text=String(resume),head=text.split(/\n/).slice(0,7).join(' ');
  const intent=text.match(/求职意向[^\n]{0,100}/)?.[0]||head;
  const graduation=text.match(/(20\d{2})\s*届/)?.[1]||text.match(/(20\d{2})[.年/-]\s*\d{1,2}\s*[（(]?预计/)?.[1];
  const education=/博士/.test(head)?'博士':/硕士|研究生/.test(head)?'硕士':/本科/.test(text)?'本科':/大专/.test(text)?'大专':'';
  const student=/在校|在读|本科生|预计.{0,8}毕业|毕业.{0,8}预计|\d{4}[.年/-]\d{1,2}\s*[（(]预计/.test(text);
  const internship=/实习生|求职意向[^\n]{0,60}实习|意向[^\n]{0,30}intern/i.test(intent);
  const target_roles=[];
  if(/智能体|\bagent\b|LLM|大模型应用/i.test(intent))target_roles.push('智能体/大模型应用');
  if(/后端|Python\s*开发/i.test(intent))target_roles.push('后端开发');
  if(/数据分析/.test(intent))target_roles.push('数据分析');
  if(/嵌入式/.test(intent))target_roles.push('嵌入式开发');
  return {education,student,graduation_year:graduation?Number(graduation):null,employment_preference:internship?'实习':'未明确',target_roles,
    notice:'仅依据简历明确事实；实习不折算为多年全职经验。城市、到岗时间和实习天数未从经历地点推断。'};
}

// ReAct is an agent reasoning pattern, not the React front-end library.
export function hasReactSkill(text='') {
  return /(?<![a-z0-9])react(?:\.js|js)?(?![a-z0-9])/i.test(String(text).replace(/\bReAct\b/g,''));
}

const degreeLevel={'大专':1,'本科':2,'硕士':3,'博士':4};
function minimumDegree(job){
  const body=String(job.description||'');
  // An explicit alternative (本科/硕士) is not a masters-only gate.
  const lines=body.split(/[\n。；;]/).filter(l=>!/优先|加分/.test(l));
  for(const level of ['博士','硕士'])if(lines.some(l=>new RegExp(`${level}(?:研究生)?(?:及以上|以上|学历|在读|学位)`).test(l)&&!/本科|大专/.test(l)))return level;
  return job.education||'';
}
export function assessResumeJobFit(job,profile){
  const reasons=[],checks=[],title=String(job.job_name||''),body=String(job.description||''),exp=String(job.experience||'');
  const minimum=minimumDegree(job);
  if(degreeLevel[profile.education]&&degreeLevel[minimum]>degreeLevel[profile.education])reasons.push(`学历要求${minimum}，简历为${profile.education}`);
  if(profile.education&&!degreeLevel[minimum]&&!/不限|无要求/.test(minimum))checks.push('学历门槛未明确，需要向招聘方确认');
  const internship=/实习/.test(title)||job.employment_type==='实习';
  const campus=/校招|应届|届|在校生/.test(title+' '+exp);
  const graduateYears=hiringCohorts(job);
  if(cohortNeedsReview(job))reasons.push('标题与正文的招聘届次表述存在歧义，待复核前不主推');
  if(profile.graduation_year&&graduateYears.length&&!graduateYears.includes(profile.graduation_year))reasons.push(`招聘届次${[...new Set(graduateYears)].join('/')}，简历为${profile.graduation_year}届`);
  if(profile.graduation_year&&!graduateYears.length)checks.push('招聘届次未明确，不能视为已确认符合毕业年份');
  if(profile.employment_preference==='校招'){
    if(internship)reasons.push('当前寻找正式校招，不以实习岗位替代');
    if(/高级|资深|专家|总监|架构师/.test(title))reasons.push('资深岗位，不作为校招主推荐');
    const required=exp.match(/(\d+)\s*(?:[-–~至到]\s*\d+\s*)?年/);
    if(required&&Number(required[1])>=1&&!/以下|不限|应届/.test(exp))reasons.push(`要求${exp}，未将实习计为全职年限`);
  }
  if(profile.employment_preference==='实习'){
    const requiredYears=exp.match(/(\d+)\s*(?:[-–~至到]\s*\d+\s*)?年/);
    if(!internship&&requiredYears&&Number(requiredYears[1])>=1&&!/以下|不限|应届/.test(exp))reasons.push(`要求${exp}，未将实习计为全职年限`);
    if(!internship&&/高级|资深|专家|总监|架构师/.test(title))reasons.push('资深岗位，不作为实习主推荐');
    if(!internship)checks.push(campus?'校招/应届岗位：需确认毕业届次及是否接受提前实习':'未明确提供实习名额，需确认用工类型');
    else checks.push('需确认到岗时间、每周出勤及连续实习时长');
    if(internship&&job.employment_type==='全职')checks.push('标题含实习但用工字段为全职，需确认数据口径');
  }
  if(/(?:985|211|双一流).{0,15}(?:高校|院校|大学|本科)/.test(body)&&!/985.{0,8}优先|211.{0,8}优先/.test(body))checks.push('原文另有院校条件，需人工核对；未判定满足');
  const target=profile.target_roles||[];
  const targetMatch=!target.length||target.some(r=>job.role_families?.includes(r))||(target.includes('智能体/大模型应用')&&/智能体|\bagent\b|\bRAG\b|大模型应用/i.test(title+' '+body));
  const targetPriority=target.includes('智能体/大模型应用')&&/智能体|\bagent\b|\bLLM\b|大模型|AI\s*应用/i.test(title)?3:target.includes('智能体/大模型应用')&&/AI.{0,8}(?:开发|应用|研发)|(?:开发|研发).{0,8}AI/i.test(title)?2:targetMatch?1:0;
  const active=profile.employment_preference==='实习'||!!profile.education;
  return {eligible:!reasons.length,tier:reasons.length?3:active&&profile.employment_preference==='实习'?internship?0:campus?1:2:0,
    label:reasons.length?'暂不主推':internship&&profile.employment_preference==='实习'?'优先核对实习岗位':campus?'校招备选（待确认）':'条件待确认',
    target_match:targetMatch,target_priority:targetPriority,reasons,checks};
}
