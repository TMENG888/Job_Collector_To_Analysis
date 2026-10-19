import {renderKeywordWordCloud} from './insight-wordcloud.js';
import {cohortConditionValue,cohortSalaryStatistics} from './insight-cohorts.js';
import {fitSkillSalaryIncrements} from './skill-salary-increments.js';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const colors=['#117d70','#39a999','#658bc4','#9171b5','#dc9d50','#cf788d','#a3afb7'];

export function renderProfileCloud(items,title,industry=false) {
  const terms=(items||[]).map(item=>({...item,score:Number(industry?item.share??item.count:item.count)})).filter(item=>item.score>0);
  return renderKeywordWordCloud(terms,{title,summary:industry?'字号按公司行业占比加权':'字号按岗位覆盖频次加权，同一岗位同一标签只计一次',
    detailFor:word=>industry?`${word.name}；公司行业占比 ${(Number(word.share??0)*100).toFixed(1)}%`:`${word.name}；${word.count} 条岗位${word.rate==null?'':`；覆盖 ${(word.rate*100).toFixed(1)}%`}`});
}

export function distribution(rows,field,limit=6) {
  const counts=new Map();
  for(const row of rows){const name=cohortConditionValue(row,field);counts.set(name,(counts.get(name)||0)+1);}
  const ranked=[...counts].map(([name,count])=>({name,count})).sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name,'zh-CN'));
  if(ranked.length<=limit)return ranked;
  return [...ranked.slice(0,limit),{name:'其他（剩余类别）',count:ranked.slice(limit).reduce((sum,row)=>sum+row.count,0)}];
}
export function renderDonut(rows,field,title) {
  if(!rows.length)return '<p class="empty">当前条件没有岗位样本</p>';
  const groups=distribution(rows,field),total=rows.length,r=72,circumference=2*Math.PI*r;
  let offset=0;
  const rings=groups.map((row,i)=>{
    const length=row.count/total*circumference,start=offset;offset+=length;
    const detail=`${row.name}：${row.count} 条，${(row.count/total*100).toFixed(1)}%`;
    return `<circle cx="110" cy="110" r="${r}" fill="none" stroke="${colors[i]}" stroke-width="24" stroke-dasharray="${length} ${circumference-length}" stroke-dashoffset="${-start}" transform="rotate(-90 110 110)" tabindex="0" aria-label="${escape(detail)}"><title>${escape(detail)}</title></circle>`;
  }).join('');
  return `<div class="profile-donut"><svg viewBox="0 0 220 220" role="img" aria-label="${escape(title)}，共${total}条岗位"><title>${escape(title)}</title>${rings}<text x="110" y="107" text-anchor="middle" class="donut-total">${total.toLocaleString('zh-CN')}</text><text x="110" y="130" text-anchor="middle" class="donut-caption">岗位样本</text></svg><ul>${groups.map((row,i)=>`<li><i style="background:${colors[i]}"></i><span>${escape(row.name)}</span><b>${(row.count/total*100).toFixed(1)}%</b><small>${row.count.toLocaleString('zh-CN')} 条</small></li>`).join('')}</ul></div>`;
}
function experienceOrder(name) {
  if(/在校/.test(name))return -3;
  if(/应届/.test(name))return -2;
  if(/无需经验/.test(name))return -1;
  if(/年/.test(name)){const number=Number(name.match(/\d+/)?.[0]);if(Number.isFinite(number))return number+(/以下/.test(name)?-.5:0);}
  return Infinity;
}
export function skillSalaryAssociations(rows) {
  const names=[...new Set(rows.flatMap(row=>row.skills||[]))].filter(Boolean);
  return names.map(name=>{
    const has=rows.filter(row=>(row.skills||[]).includes(name));
    const without=rows.filter(row=>!(row.skills||[]).includes(name));
    const tagged=cohortSalaryStatistics(has),untagged=cohortSalaryStatistics(without);
    return {name,count:has.length,tagged,untagged,difference:tagged.count>=5 && untagged.count>=5?Number((tagged.median-untagged.median).toFixed(2)):null};
  }).sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name,'zh-CN'));
}
export function renderSkillSalaryAssociations(rows) {
  const model=fitSkillSalaryIncrements(rows);
  if(model.status!=='ready')return `<p class="empty">${escape(model.reason)}</p>`;
  const k=v=>`${v.toFixed(2)}K/月`;
  const foundation=model.baseline_skills.length?model.baseline_skills.join(' + '):'未标注入模技术（不等于无技能）';
  const metrics=`公司分组验证：MAE ${k(model.metrics.mae_k)}，R² ${model.metrics.r2==null?'—':model.metrics.r2.toFixed(3)}；条件基线 MAE ${k(model.baseline_metrics.mae_k)}；有效薪资 ${model.sample_count} 条`;
  const table=model.positive_increment_publish?`<div class="table-scroll"><table class="insight-table"><thead><tr><th>技术</th><th>薪资样本（有／无标签）</th><th>相对基础组合月薪增量</th><th>增幅</th><th>基础＋该技术估计</th></tr></thead><tbody>${model.effects.map(e=>`<tr><td>${escape(e.name)}</td><td>${e.count}／${e.without_count}</td><td>${e.foundation?'基础组合已包含':e.delta_k<.005?'未检出正向增量':`+${k(e.delta_k)}`}</td><td>${e.delta_pct>=.005?`+${e.delta_pct.toFixed(2)}%`:'—'}</td><td>${k(e.estimated_salary_k)}</td></tr>`).join('')}</tbody></table></div>`:'<p class="empty">技术增量模型在公司分组验证中未明显优于条件基线，暂不发布增量数值。</p>';
  return `<p>基础技术组合：${escape(foundation)} · 原样本支持 ${model.baseline_support} 条 · 条件标准化基础月薪 ${k(model.baseline_salary_k)}</p><p class="profile-chart-note">${escape(metrics)}；${escape(model.method)}</p>${table}<p class="profile-chart-note">${escape(model.disclaimer)}技术项少于10条或无标签对照不足时不入模；最多展示20项常见技术。筛选条件变化会重新拟合，增量不能直接累计解释成个人涨薪。</p>`;
}
export function salaryExperienceGroups(rows) {
  const grouped=new Map();
  for(const row of rows){const name=cohortConditionValue(row,'experience');if(!grouped.has(name))grouped.set(name,[]);grouped.get(name).push(row);}
  return [...grouped].map(([name,items])=>({name,order:experienceOrder(name),...cohortSalaryStatistics(items)}))
    .sort((a,b)=>a.order-b.order||a.name.localeCompare(b.name,'zh-CN'));
}
export function renderSalaryExperienceLine(rows) {
  const groups=salaryExperienceGroups(rows);
  if(!groups.length)return '<p class="empty">当前条件没有岗位样本</p>';
  const numeric=groups.filter(row=>Number.isFinite(row.order)),other=groups.filter(row=>!Number.isFinite(row.order));
  const valid=numeric.filter(row=>row.count>=5);
  const table=`<details class="profile-chart-data"><summary>查看分组数据</summary><div class="table-scroll"><table class="insight-table"><thead><tr><th>经验要求</th><th>有效薪资样本</th><th>月薪中位数</th></tr></thead><tbody>${groups.map(row=>`<tr><td>${escape(row.name)}</td><td>${row.count}</td><td>${row.count>=5?`${row.median}K/月`:'样本不足5条'}</td></tr>`).join('')}</tbody></table></div></details>`;
  if(!valid.length)return '<p class="empty">有年限的经验分组均不足5条有效薪资样本，暂不绘制折线。</p>'+table;
  const width=Math.max(640,numeric.length*82),height=300,left=62,right=32,top=28,bottom=80,max=Math.max(...valid.map(row=>row.median))*1.15;
  const x=i=>numeric.length===1?width/2:left+i*(width-left-right)/(numeric.length-1);
  const y=value=>height-bottom-value/max*(height-top-bottom);
  const grid=Array.from({length:5},(_,i)=>{const value=max*i/4;return `<line x1="${left}" x2="${width-right}" y1="${y(value)}" y2="${y(value)}" class="salary-grid"/><text x="${left-10}" y="${y(value)+4}" text-anchor="end" class="salary-axis">${value.toFixed(1)}</text>`;}).join('');
  let segments=[],segment=[];
  numeric.forEach((row,i)=>{if(row.count>=5)segment.push(`${x(i)},${y(row.median)}`);else{if(segment.length)segments.push(segment);segment=[];}});
  if(segment.length)segments.push(segment);
  const points=numeric.map((row,i)=>`<text x="${x(i)}" y="${height-bottom+25}" transform="rotate(25 ${x(i)} ${height-bottom+25})" text-anchor="start" class="salary-axis">${escape(row.name)}</text>${row.count<5?'':`<circle cx="${x(i)}" cy="${y(row.median)}" r="5" fill="#117d70" tabindex="0" aria-label="${escape(`${row.name}：${row.median}K/月，${row.count}条薪资样本`)}"><title>${escape(`${row.name}：${row.median}K/月；${row.count}条有效薪资样本`)}</title></circle><text x="${x(i)}" y="${y(row.median)-12}" text-anchor="middle" class="salary-point-label">${row.median}K</text>`}`).join('');
  return `<div class="profile-line-scroll"><svg viewBox="0 0 ${width} ${height}" style="min-width:${width}px" role="img" aria-label="经验与招聘月薪中位数，单位千元每月"><title>经验与招聘月薪中位数</title><text x="8" y="18" class="salary-axis">K/月</text>${grid}${segments.map(points=>`<polyline points="${points.join(' ')}" fill="none" stroke="#117d70" stroke-width="3"/>`).join('')}${points}</svg></div>${table}`;
}
