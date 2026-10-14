import {cohortConditionValue,cohortFilterFields} from './insight-cohorts.js';

// Monthly midpoint, not individual pay or a causal return to learning a skill.
const valid = r => Number.isFinite(r.salary_midpoint_k) && r.salary_midpoint_k >= 3 && r.salary_midpoint_k <= 200;
const uniqueSkills = r => [...new Set(r.skills || [])].filter(Boolean);
function specification(rows) {
  const counts = new Map();
  for (const r of rows) for (const s of uniqueSkills(r)) counts.set(s,(counts.get(s)||0)+1);
  const minimum = Math.max(10,Math.ceil(rows.length*.02));
  const skills = [...counts].filter(([,n])=>n>=minimum && rows.length-n>=minimum)
    .sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,20).map(([s])=>s);
  const controls = [];
  for (const field of cohortFilterFields) {
    const values = new Map();
    for (const r of rows) {const v=cohortConditionValue(r,field);values.set(v,(values.get(v)||0)+1);}
    // Rare and unseen categories share an explicit pooled reference category.
    const frequent=[...values].filter(([,n])=>n>=10).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([v])=>v);
    const pooled=frequent.length<values.size;
    for (const value of (pooled?frequent:frequent.slice(1))) controls.push({field,value});
  }
  return {skills,controls,minimum};
}
function vector(row,spec,skills=uniqueSkills(row)) {
  const selected=new Set(skills);
  return [1,...spec.controls.map(c=>Number(cohortConditionValue(row,c.field)===c.value)),...spec.skills.map(s=>Number(selected.has(s)))];
}
function fit(rows,spec,penalty,withSkills=true) {
  const size=1+spec.controls.length+(withSkills?spec.skills.length:0);
  const gram=Array.from({length:size},()=>Array(size).fill(0)), xy=Array(size).fill(0);
  for (const r of rows) {
    const x=vector(r,spec).slice(0,size), y=r.salary_midpoint_k;
    const active=x.flatMap((v,i)=>v?[i]:[]);
    for(const i of active){xy[i]+=y;for(const j of active)gram[i][j]++;}
  }
  const beta=Array(size).fill(0);beta[0]=xy[0]/rows.length;
  for(let iteration=0;iteration<500;iteration++){
    let change=0;
    for(let i=0;i<size;i++){
      let target=xy[i];for(let j=0;j<size;j++)if(j!==i)target-=gram[i][j]*beta[j];
      const denominator=gram[i][i]+(i===0?0:i<=spec.controls.length?2:penalty);
      let next=denominator?target/denominator:0;
      if(i>spec.controls.length)next=Math.max(0,next);
      change=Math.max(change,Math.abs(next-beta[i]));beta[i]=next;
    }
    if(change<1e-6)break;
  }
  return beta;
}
const predict=(r,spec,beta,skills)=>vector(r,spec,skills).reduce((sum,v,i)=>sum+v*(beta[i]||0),0);
function group(r) {return r.company_key || (r.job_id?`${r.platform||''}:${r.job_id}`:`row:${r.row_no}`);}
function fold(key){let h=2166136261;for(const c of key)h=Math.imul(h^c.charCodeAt(0),16777619);return (h>>>0)%3;}
function metrics(actual,predicted){
  const mean=actual.reduce((s,v)=>s+v,0)/actual.length;
  const mae=actual.reduce((s,v,i)=>s+Math.abs(v-predicted[i]),0)/actual.length;
  const sse=actual.reduce((s,v,i)=>s+(v-predicted[i])**2,0),sst=actual.reduce((s,v)=>s+(v-mean)**2,0);
  return {mae_k:mae,r2:sst?1-sse/sst:null,rows:actual.length};
}
export function fitSkillSalaryIncrements(input) {
  const seen=new Set();
  const rows=input.filter(valid).filter(r=>{
    // Deduplicate only identifiable postings; unidentifiable rows remain distinct.
    const key=r.platform && r.job_id?`${r.platform}:${r.job_id}`:null;
    if(!key)return true;if(seen.has(key))return false;seen.add(key);return true;
  });
  const spec=specification(rows);
  if(rows.length<80 || !spec.skills.length)return {status:'insufficient',sample_count:rows.length,reason:'至少需要80条有效薪资，以及有标签/无标签各至少10条的技术样本'};
  const candidates=[2,10,40].map(p=>({penalty:p,actual:[],predicted:[]})),base={actual:[],predicted:[]};
  for(let f=0;f<3;f++){
    const train=rows.filter(r=>fold(group(r))!==f),test=rows.filter(r=>fold(group(r))===f);
    if(train.length<40 || !test.length)continue;
    const fs=specification(train), baseline=fit(train,fs,10,false);
    for(const r of test){base.actual.push(r.salary_midpoint_k);base.predicted.push(predict(r,fs,baseline));}
    for(const c of candidates){const beta=fit(train,fs,c.penalty);for(const r of test){c.actual.push(r.salary_midpoint_k);c.predicted.push(predict(r,fs,beta));}}
  }
  if(base.actual.length<rows.length*.8 || new Set(rows.map(group)).size<6)
    return {status:'insufficient',sample_count:rows.length,reason:'独立公司/岗位分组不足，无法验证拟合效果'};
  candidates.forEach(c=>c.metrics=metrics(c.actual,c.predicted));candidates.sort((a,b)=>a.metrics.mae_k-b.metrics.mae_k);
  const best=candidates[0],baseMetrics=metrics(base.actual,base.predicted),beta=fit(rows,spec,best.penalty);
  // A supported low-complexity basket, rather than the lowest posted salary or
  // an unobserved no-skill worker, defines the comparison baseline.
  const baskets=new Map();
  for(const r of rows){const s=uniqueSkills(r).sort();const key=JSON.stringify(s);baskets.set(key,(baskets.get(key)||0)+1);}
  const supported=[...baskets].filter(([,n])=>n>=Math.max(5,Math.ceil(rows.length*.01)))
    .sort((a,b)=>JSON.parse(a[0]).length-JSON.parse(b[0]).length||b[1]-a[1]);
  if(!supported.length)return {status:'insufficient',sample_count:rows.length,reason:'缺少至少5条且覆盖1%的基础技术组合，无法设定可靠参照'};
  const foundation=JSON.parse(supported[0][0]),support=supported[0][1];
  const baseline=rows.reduce((sum,r)=>sum+predict(r,spec,beta,foundation),0)/rows.length;
  const improvement=baseMetrics.mae_k-best.metrics.mae_k;
  const publish=improvement>=Math.max(.1,baseMetrics.mae_k*.02) && baseline>0;
  const effects=spec.skills.map((name,i)=>{
    const delta=foundation.includes(name)?0:beta[1+spec.controls.length+i];
    const count=rows.filter(r=>uniqueSkills(r).includes(name)).length;
    return {name,count,without_count:rows.length-count,foundation:foundation.includes(name),
      delta_k:publish?delta:null,delta_pct:publish?delta/baseline*100:null,
      estimated_salary_k:publish?baseline+delta:null};
  }).sort((a,b)=>(b.delta_k||0)-(a.delta_k||0)||b.count-a.count);
  return {status:'ready',version:'nonnegative-salary-increment-v1',method:'非负加性岭回归；公司分组3折验证；训练折内选特征',
    sample_count:rows.length,baseline_skills:foundation,baseline_support:support,baseline_salary_k:baseline,
    metrics:best.metrics,baseline_metrics:baseMetrics,penalty:best.penalty,positive_increment_publish:publish,
    validation_gain_k:improvement,effects,coefficients:beta,feature_spec:spec,
    candidates:candidates.map(c=>({penalty:c.penalty,...c.metrics})),
    disclaimer:'相同岗位族、控制城市/经验/学历/公司规模/用工类型后的招聘月薪中点关联。基础组合来自低技术标签数量的常见样本，不等于最低工资或真实底层能力；按当前样本画像平均预测，部分画像可能缺少基础组合支持。非负约束是建模假设，不证明技术没有负向关联；零表示未检出正向增量，不代表真实效应为零。未估计因果效应及增量置信区间，不承诺个人涨薪。'};
}
