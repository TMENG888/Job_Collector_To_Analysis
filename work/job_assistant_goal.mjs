// Public, allowlisted preferences only. Never store resume text or identity here.
const negative=/(?:不看|不要|不找|排除|不考虑|不是|不混入?|而非|不包含|不推荐|不能|禁止)(?:用|使用|推荐|提供|混入|采用)?\s*$/;
const positive=(text,re)=>[...text.matchAll(re)].filter(m=>!negative.test(text.slice(Math.max(0,m.index-12),m.index)));
export const conditionReleased=(text,field)=>new RegExp(`(?:不限|不限制|不限定|不(?:再)?局限|不用局限|不必局限|无需局限|无需限制|不用限制|取消|去掉|移除|放开)(?:于|在|为)?(?:任何|所有|当前|的)?(?:${field})|(?:${field})(?:条件|限制|要求|范围)?(?:不限|不限制|都可以)`).test(text);
export function hiringScopeIntent(text){
  if(/(?:校招.{0,4}社招|社招.{0,4}校招).{0,4}(?:都看|都可以|一起看)/.test(text))return 'formal';
  const broad=conditionReleased(text,'实习|招聘阶段|求职阶段|用工(?:类型)?')||/不只(?:看|限于)?实习|不(?:再)?仅(?:看|限于)?实习|(?:实习.{0,4}(?:全职|正式)|(?:全职|正式).{0,4}实习).{0,4}(?:都看|都可以|一起看)/.test(text);
  const stages=positive(text,/秋招|春招|校招|校园招聘|应届(?:生)?招聘|正式校招|社招|社会招聘|实习/g).filter(m=>!(broad&&m[0]==='实习'));
  if(stages.length){const chosen=stages.at(-1)[0];return /实习/.test(chosen)?'internship':/社招|社会招聘/.test(chosen)?'social':'campus';}
  if(broad)return 'all';
  if(/(?:不看|不要|不找|排除|不考虑)\s*实习|(?:校招.{0,4}社招|社招.{0,4}校招).{0,4}(?:都看|都可以)/.test(text))return 'formal';
  if(positive(text,/正式岗位|正式工作/g).length)return 'formal';
  return null;
}
export const isMarketSalaryQuestion=text=>/(?:薪资|工资|薪酬|待遇).{0,12}(?:上限|天花板|成长空间)|(?:薪资|工资|薪酬)(?:行情|分布)|职业薪资|市场薪资/.test(text);
export function updateCareerGoal(message,previous={},profile={}){
  const text=String(message||''),goal={...previous};
  if(/清空.*条件|重置.*条件|取消所有筛选/.test(text))for(const key of Object.keys(goal))delete goal[key];
  const scope=hiringScopeIntent(text),stages=scope?[scope]:[];
  if(stages.length){
    goal.stage=scope;goal.stage_source='user';
  }else if(!goal.stage&&goal.stage_source!=='user'&&profile.employment_preference==='实习'){goal.stage='internship';goal.stage_source='resume';}
  if(isMarketSalaryQuestion(text)){goal.analysis_mode='market';if(!scope&&previous.analysis_mode!=='market'){goal.stage='formal';goal.stage_source='user';}}
  else if(/(?:按|根据).{0,8}简历|匹配.{0,5}简历|(?:我|本人).{0,8}(?:报价|要价|谈薪|能拿)|(?:我要找|我想找|帮我找)/.test(text))goal.analysis_mode='personal';
  else if(scope==='all'||scope==='formal')goal.analysis_mode='market';
  else if(scope&&previous.analysis_mode!=='market')goal.analysis_mode='personal';
  if(!stages.length&&/全职|正式工作/.test(text)&&goal.stage==='internship'){delete goal.stage;goal.stage_source='user';goal.salary_period='month';}
  const year=text.match(/(?<!\d)((?:20)?\d{2})\s*届/);
  if(year){goal.graduation_year=Number(year[1].length===2?'20'+year[1]:year[1]);goal.cohort_source='user';}
  else if(!goal.graduation_year&&goal.cohort_source!=='unrestricted'&&profile.graduation_year){goal.graduation_year=profile.graduation_year;goal.cohort_source='resume';}
  if(conditionReleased(text,'届次|毕业届次')){delete goal.graduation_year;goal.cohort_source='unrestricted';}
  if(!goal.education&&goal.education_source!=='unrestricted'&&profile.education)goal.education=profile.education;
  const degree=positive(text,/博士|硕士|本科|大专/g).at(-1)?.[0];if(degree){goal.education=degree;goal.education_source='user';}
  if(conditionReleased(text,'学历')){delete goal.education;goal.education_source='unrestricted';}
  for(const [field,terms]of [['city','城市|地区'],['experience','经验|年限'],['roles','岗位|岗位方向']]){
    if(conditionReleased(text,terms))goal[field+'_source']='unrestricted';
    else if(field==='city'&&/北京|上海|广州|深圳|杭州|成都|南京|武汉/.test(text)||field==='experience'&&/\d+\s*年|应届/.test(text))goal[field+'_source']='user';
  }
  const periods=positive(text,/日薪|时薪|月薪|年薪|年包|总包|一天|每个月|每月|一年|每年/g);
  if(periods.length)goal.salary_period=/日薪|一天/.test(periods.at(-1)[0])?'day':/时薪/.test(periods.at(-1)[0])?'hour':/年薪|年包|总包|一年|每年/.test(periods.at(-1)[0])?'year':'month';
  // A hiring-stage change resets the previous stage's pay unit unless restated.
  if(stages.length&&!periods.length)goal.salary_period=goal.stage==='internship'?'day':'month';
  if(goal.analysis_mode==='market'&&!periods.length&&goal.stage!=='internship')goal.salary_period='month';
  goal.unit_conflict=goal.stage==='campus'&&['day','hour'].includes(goal.salary_period);
  if(goal.unit_conflict)goal.salary_period='month';
  goal.salary_period ||= goal.stage==='internship'?'day':'month';
  return goal;
}
export function applyCareerGoal(filters,goal){
  const next={...filters};
  if(goal.education&&!next.education)next.candidate_education=goal.education;
  if(goal.stage&&goal.stage_source!=='resume'){next.career_stage=goal.stage;if(goal.stage==='all')delete next.employment_type;else next.employment_type=goal.stage==='internship'?'实习':'全职';}
  else if(!goal.stage&&goal.stage_source==='user')delete next.career_stage;
  if(goal.education_source==='unrestricted'){delete next.education;delete next.candidate_education;}
  if(goal.city_source==='unrestricted'){delete next.city;delete next.cities;delete next.exclude_cities;}
  if(goal.experience_source==='unrestricted'){delete next.years;delete next.experience;}
  if(goal.roles_source==='unrestricted')delete next.roles;
  if(goal.graduation_year&&!['all','formal','social'].includes(goal.stage))next.graduation_year=goal.graduation_year;else delete next.graduation_year;
  return next;
}
export function hiringCohorts(job){
  const title=String(job.job_name||''),body=String(job.description||'');
  const years=[];
  const add=text=>{for(const m of text.matchAll(/(?<!\d)((?:20)?\d{2})\s*届/g))years.push(Number(m[1].length===2?'20'+m[1]:m[1]));};
  add(title);
  for(const m of title.matchAll(/(?<!\d)(20\d{2})\s*年?\s*应届(?:毕业)?生/g))years.push(Number(m[1]));
  for(const m of title.matchAll(/(?<!\d)(20\d{2})\s*(?:年)?(?:校招|校园招聘|秋招|春招)/g))years.push(Number(m[1]));
  for(const line of body.split(/[\n。；;]/))if(!/优先|加分/.test(line)&&/(?:届.{0,15}(?:毕业|应届|在校|本科|硕士)|(?:面向|仅限|要求|招收|招募).{0,20}届)/.test(line))add(line);
  return [...new Set(years)];
}
export function cohortNeedsReview(job){
  const titleYears=hiringCohorts({...job,description:''});
  return [...String(job.description||'').matchAll(/非\s*((?:20)?\d{2})\s*届([^\n。；;]{0,30})/g)].some(m=>{
    const year=Number(m[1].length===2?'20'+m[1]:m[1]);
    // “非27届勿投” means only27; masked/missing clauses cannot be inferred.
    return titleYears.includes(year)&&!/勿投|不投|不要投|不接受|不考虑|不符合|谢绝/.test(m[2]);
  });
}
export function jobCareerStage(job){
  const title=String(job.job_name||''),body=String(job.description||'');
  if(/实习/.test(title)||job.employment_type==='实习')return 'internship';
  if(/校招|校园招聘|应届|毕业生|\d{2}届/.test(title+' '+String(job.experience||''))||hiringCohorts(job).length||/(?:面向|招收|招募).{0,15}(?:应届|毕业生)/.test(body))return 'campus';
  return 'social';
}
export function matchesCareerGoal(job,filters={}){
  if(filters.graduation_year&&cohortNeedsReview(job))return false;
  if(filters.career_stage==='formal'&&jobCareerStage(job)==='internship')return false;
  if(filters.career_stage&&!['all','formal'].includes(filters.career_stage)&&jobCareerStage(job)!==filters.career_stage)return false;
  if(filters.career_stage==='campus'){
    const exp=String(job.experience||'');if(/(?:[1-9]\d*)\s*(?:[-–~至到]\s*\d+\s*)?年/.test(exp)&&!/不限|以下|应届/.test(exp))return false;
  }
  const years=hiringCohorts(job);
  return !filters.graduation_year||!years.length||years.includes(Number(filters.graduation_year));
}
export function effectiveResumeProfile(profile,goal={}){
  const next={...profile,...(goal.education?{education:goal.education}:{}),...(goal.graduation_year?{graduation_year:goal.graduation_year}:{}),
    ...(goal.stage?{employment_preference:{internship:'实习',campus:'校招',social:'社招'}[goal.stage]}:{})};
  if(goal.education_source==='unrestricted')delete next.education;
  if(goal.cohort_source==='unrestricted'||['all','formal','social'].includes(goal.stage))delete next.graduation_year;
  if(goal.roles_source==='unrestricted')next.target_roles=[];
  else if(goal.roles_source==='user'&&goal.roles?.length)next.target_roles=[...goal.roles];
  return next;
}
export const isSalaryQuestion=message=>/薪资|工资|薪酬|行情|报价|要价|谈薪|多少钱|多少薪|年包|总包|日薪|月薪|年薪/.test(String(message));
export const goalLabels={internship:'实习',campus:'正式校招',social:'社招',formal:'正式岗位（校招＋社招）',all:'不限招聘阶段',day:'元/天',hour:'元/小时',month:'元/月',year:'元/年'};
