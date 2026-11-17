import {summarizeCohort,cohortConditionValue,cohortSalaryStatistics} from './insight-cohorts.js';
import {renderProfileCloud,renderDonut,renderSalaryExperienceLine} from './insight-profile-charts.js?v=20261113-cloud-top50';
import {insightConditionValue,filterInsightCohort as filterCohort,insightFilterOptions as cohortFilterOptions,companyRecruitingRanking} from './insight-groups.js?v=20261111-province-ranking';

const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number=value=>Number(value||0).toLocaleString('zh-CN');
const percent=value=>`${(Number(value||0)*100).toFixed(1)}%`;
const filters=[['province','省份','cohortProvince'],['experience','工作年限','cohortExperience'],['education','学历','cohortEducation'],['company_size','公司规模','cohortCompanySize'],['employment_type','用工类型','cohortEmployment']];
const sections=[['insightOverviewSection','市场概览'],['insightSalarySection','薪资与经验'],['insightSkillsSection','岗位能力'],['insightLocationSection','需求分布'],['insightCompanySection','招聘公司']];
const heading=(id,number,title,extra='')=>`<header class="insight-section-heading"><div><span class="insight-section-number" aria-hidden="true">${number}</span><h3 id="${id}">${title}</h3></div>${extra}</header>`;
const expand=(target,title)=>`<button type="button" class="insight-chart-expand" data-insight-expand="${target}" data-chart-title="${title}" aria-label="展开${title}" title="展开查看"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 3H3v4m10-4h4v4M3 13v4h4m10-4v4h-4"/></svg></button>`;
const cloudPanels=[['cohortSkills','技能与技术栈词云'],['cohortTasks','工作内容词云']];
const cloudMarkup=()=>cloudPanels.map(([id,title])=>`<article class="profile-cloud-panel"><header class="insight-chart-heading"><h4>${title}</h4>${expand(id,title)}</header><div id="${id}"></div></article>`).join('');
const mapMarkup=()=>`<article class="card insight-panel map-panel"><header class="insight-chart-heading"><h4>省份岗位分布</h4></header><div id="provinceMap" class="city-map" aria-label="中国省份岗位样本分布图"></div></article>`;

export function cityCohortStatistics(rows,metadata=[]){
  const groups=new Map(),locations=new Map(metadata.map(city=>[cohortConditionValue({city:city.name},'city'),city]));
  for(const row of rows){const name=cohortConditionValue(row,'city');if(!groups.has(name))groups.set(name,[]);groups.get(name).push(row);}
  return [...groups].map(([name,jobs])=>{const salary=cohortSalaryStatistics(jobs);return {...locations.get(name),name,count:jobs.length,median_salary_k:salary.count>=5?salary.median:null};}).sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name,'zh-CN'));
}

export function provinceCohortStatistics(rows){
  const groups=new Map();
  for(const row of rows){const name=insightConditionValue(row,'province');if(!groups.has(name))groups.set(name,[]);groups.get(name).push(row);}
  return [...groups].map(([name,jobs])=>{
    const salary=cohortSalaryStatistics(jobs),education=new Map();
    for(const job of jobs){const value=insightConditionValue(job,'education');education.set(value,(education.get(value)||0)+1);}
    const highest=Math.max(...education.values()),topEducation=[...education].filter(([,count])=>count===highest).map(([name])=>name).sort((a,b)=>a.localeCompare(b,'zh-CN'));
    return {name,count:jobs.length,salary_count:salary.count,converted_daily_count:salary.converted_daily_count,average_salary_k:salary.mean,p25_salary_k:salary.count>=5?salary.p25:null,median_salary_k:salary.count>=5?salary.median:null,p75_salary_k:salary.count>=5?salary.p75:null,top_education:topEducation,top_education_count:highest};
  }).sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name,'zh-CN'));
}

export function provinceTooltipDetails(item={},name=item.name||'省份'){
  const salary=value=>Number.isFinite(value)?`${value.toLocaleString('zh-CN',{maximumFractionDigits:2})}K/月`:'—';
  const education=item.top_education?.length?`${item.top_education.join('、')}${item.top_education.length>1?'（并列）':''} · ${number(item.top_education_count)} 条${item.top_education.length>1?'／类':''}`:'—';
  const salaryFields=item.salary_count>=5?[['薪资 P25',salary(item.p25_salary_k)],['薪资中位数',salary(item.median_salary_k)],['薪资 P75',salary(item.p75_salary_k)]]:item.salary_count>0?[[item.salary_count===1?'单条月薪':'平均月薪',salary(item.average_salary_k)]]:[['薪资','暂无有效月薪']];
  const fields=[['岗位数量',`${number(item.count)} 条`],...salaryFields,['最常见学历',education]];
  const note=item.count?`${number(item.salary_count)} 条有效月薪样本${item.converted_daily_count?` · 含 ${number(item.converted_daily_count)} 条日薪按21.75天/月折算`:''}${item.salary_count>1&&item.salary_count<5?' · 不足5条，展示平均薪资':''}`:'当前筛选范围暂无岗位';
  return {label:`${name}；${fields.map(([label,value])=>`${label}：${value}`).join('；')}；${note}`,html:`<strong>${escape(name)}</strong><dl>${fields.map(([label,value])=>`<div><dt>${label}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl><p>${escape(note)}</p>`};
}

export function renderCompanyRanking(rows){
  const ranking=companyRecruitingRanking(rows);
  if(!ranking.rows.length)return '<p class="insight-chart-empty">没有可识别公司名称</p>';
  const max=ranking.rows[0].count;
  return `<p class="insight-card-caption" title="按去重岗位条数统计，不等同于实际招聘人数">当前筛选范围 · ${number(ranking.companyCount)} 家公司 · ${number(ranking.knownJobs)} 条岗位</p><div class="table-scroll"><table class="insight-table insight-company-table"><caption class="sr-only">目标岗位招聘公司 Top10</caption><thead><tr><th scope="col">排名</th><th scope="col">招聘公司</th><th scope="col">岗位条数</th><th scope="col">占已明确公司岗位</th><th scope="col">来源平台</th></tr></thead><tbody>${ranking.rows.map(item=>`<tr><td><span class="company-rank${item.rank<=3?' leading':''}">${item.rank}</span></td><th scope="row"><span class="company-rank-name">${escape(item.name)}</span><span class="company-rank-bar" aria-hidden="true"><i style="width:${item.count/max*100}%"></i></span></th><td><b>${number(item.count)}</b></td><td>${percent(item.share)}</td><td>${escape(item.platforms.join('、')||'未明确')}</td></tr>`).join('')}</tbody></table></div>`;
}

function kpis({count,salary,topCity,total}){
  const enough=salary.count>=5&&Number.isFinite(salary.median);
  return `<div class="stats insight-kpis">
    <div class="stat"><span>匹配岗位</span><strong>${number(count)}</strong><em>当前范围 / ${number(total)} 条分析样本</em></div>
    <div class="stat"><span>招聘月薪中位数</span><strong>${enough?`${salary.median.toFixed(1)}<small>K/月</small>`:'—'}</strong><em>${enough?`P25–P75 · ${Number.isFinite(salary.p25)?salary.p25.toFixed(1):'—'}–${Number.isFinite(salary.p75)?salary.p75.toFixed(1):'—'}K`:'有效薪资样本不足5条'}</em></div>
    <div class="stat"><span>薪资可用率</span><strong>${percent(count?salary.count/count:0)}</strong><em>${number(salary.count)} 条有效月薪样本${salary.converted_daily_count?` · 含 ${number(salary.converted_daily_count)} 条日薪折算`:''}</em></div>
    <div class="stat"><span>最大需求省份</span><strong>${escape(topCity?.name||'—')}</strong><em>${topCity?`${number(topCity.count)} 条岗位 · ${percent(count?topCity.count/count:0)}`:'暂无省份数据'}</em></div>
  </div>`;
}
function salaryDetail(salary,selectedCount){
  const enough=salary.count>=5&&Number.isFinite(salary.median),fmt=value=>enough&&Number.isFinite(value)?`${value.toFixed(1)}K/月`:'—';
  return `<div class="insight-salary-primary"><span>招聘月薪中位数</span><strong>${enough?salary.median.toFixed(1):'—'}<small>K/月</small></strong></div>
    <dl class="insight-salary-details"><div><dt>月薪平均值</dt><dd>${fmt(salary.mean)}</dd></div><div><dt>P25</dt><dd>${fmt(salary.p25)}</dd></div><div><dt>P75</dt><dd>${fmt(salary.p75)}</dd></div><div><dt>有效薪资样本</dt><dd>${number(salary.count)} <small>/ ${number(selectedCount)}</small></dd></div></dl>
    ${!enough?'<p class="insight-chart-empty">有效薪资少于5条，暂不展示薪资分位数。</p>':''}`;
}

export function renderInsightWorkspace(root,report,{drawProvinceMap=()=>{}}={}){
  const rows=report.cohort_observations||[],role=report.detected_role?.name||report.role||'岗位市场';
  const legacy=!Array.isArray(report.cohort_observations)||(!rows.length&&Number(report.sample_rows)>0);
  root.className='insight-workspace';
  root.innerHTML=`<div class="insight-control-deck" id="insightAnalysisControls">
    ${legacy?'':`<details class="insight-filter-panel" open><summary><span>分析范围</span><span id="insightFilterCount" class="insight-filter-count">全部条件</span></summary><div class="cohort-filters">${filters.map(([field,label,id])=>`<label>${label}<select id="${id}" data-cohort-filter="${field}"><option value="">不限</option></select></label>`).join('')}<button type="button" class="ghost" id="resetCohort">重置筛选</button></div></details>`}
    <nav class="insight-section-nav" aria-label="洞察章节">${sections.map(([id,title],i)=>`<button type="button" data-insight-section="${id}" ${i===0?'aria-current="location"':''}>${title}</button>`).join('')}</nav>
  </div>
  <section class="insight-section" id="insightOverviewSection" aria-labelledby="insightOverviewHeading">
    ${heading('insightOverviewHeading','01','市场概览',`<span class="insight-role-badge">${escape(role)}</span>`)}<div id="insightOverviewKpis"></div><div id="cohortSummary" class="insight-cohort-summary" role="status" aria-live="polite"></div>
  </section>
  <section class="insight-section" id="insightSalarySection" aria-labelledby="insightSalaryHeading">
    ${heading('insightSalaryHeading','02','薪资与经验','<span class="insight-section-unit">招聘月薪 · K/月</span>')}
    <div class="insight-salary-layout"><article class="card insight-salary-card"><h4>同条件薪资统计</h4><div id="salaryEstimator"></div></article><article class="profile-chart-panel insight-experience-card"><header class="insight-chart-heading"><h4>经验与招聘月薪中位数</h4>${expand('cohortSalaryExperience','经验与招聘月薪中位数')}</header><div id="cohortSalaryExperience"></div></article></div>
  </section>
  <section class="insight-section" id="insightSkillsSection" aria-labelledby="insightSkillsHeading">
    ${heading('insightSkillsHeading','03','岗位能力画像','<span class="insight-section-unit">技能 · 工作职责</span>')}<div class="insight-grid two-col profile-cloud-grid">${cloudMarkup()}</div>
  </section>
  <section class="insight-section" id="insightLocationSection" aria-labelledby="insightLocationHeading">
    ${heading('insightLocationHeading','04','需求结构与地域')}
    <div class="insight-grid two-col insight-distribution-grid"><article class="profile-chart-panel"><header class="insight-chart-heading"><h4>学历要求占比</h4></header><div id="cohortEducationDonut"></div></article><article class="profile-chart-panel"><header class="insight-chart-heading"><h4>省份岗位占比</h4></header><div id="cohortProvinceDonut"></div></article><article class="profile-chart-panel"><header class="insight-chart-heading"><h4>公司规模占比</h4></header><div id="cohortSizeDonut"></div></article><article class="profile-chart-panel"><header class="insight-chart-heading"><h4>工作年限占比</h4></header><div id="cohortExperienceDonut"></div></article></div>
    ${mapMarkup()}
  </section>
  <section class="insight-section" id="insightCompanySection" aria-labelledby="insightCompanyHeading">
    ${heading('insightCompanyHeading','05','目标岗位招聘公司 Top10','<span class="insight-section-unit">按去重岗位条数排序</span>')}
    <article class="card insight-panel"><div id="insightCompanyRanking"></div></article>
  </section>
  <dialog class="insight-chart-dialog" id="insightChartDialog" aria-labelledby="insightChartDialogTitle"><header><h3 id="insightChartDialogTitle"></h3><button type="button" class="ghost" data-close-insight-chart aria-label="关闭图表">×</button></header><div id="insightChartDialogBody"></div></dialog>`;
  const $=selector=>root.querySelector(selector),dialog=$('#insightChartDialog');
  if(typeof matchMedia==='function'&&matchMedia('(max-width: 700px)').matches){const panel=$('.insight-filter-panel');if(panel)panel.open=false;}
  function update(){
    if(dialog.open)dialog.close();
    const profile=Object.fromEntries(filters.map(([field,,id])=>[field,$('#'+id).value]));
    for(const [field,,id]of filters){
      const available=cohortFilterOptions(rows,profile,field),select=$('#'+id),current=profile[field];
      select.innerHTML='<option value="">不限</option>'+available.map(item=>`<option value="${escape(item.value)}">${escape(item.value==='不限'?'要求不限':item.value)} · ${number(item.count)}</option>`).join('')+(current&&!available.some(item=>item.value===current)?`<option value="${escape(current)}">${escape(current)} · 0</option>`:'');
      select.value=current;
    }
    const selected=filterCohort(rows,profile),summary=summarizeCohort(selected),salary=cohortSalaryStatistics(selected),cities=provinceCohortStatistics(selected);
    const active=filters.filter(([field])=>profile[field]),scopes=active.map(([field,label])=>`${label}：${profile[field]}`);
    $('#insightFilterCount').textContent=active.length?`${active.length} 项筛选`:'全部条件';
    $('#insightOverviewKpis').innerHTML=kpis({count:selected.length,salary,topCity:cities.find(item=>!['未明确','多省份','海外','全国/地点不限'].includes(item.name)),total:rows.length});
    $('#cohortSummary').innerHTML=`<span class="insight-scope-dot" aria-hidden="true"></span><b>${number(selected.length)} 条匹配岗位</b><span>${escape(scopes.join(' / ')||'全部分析样本')}${!selected.length?' · 暂无匹配，请调整筛选':''}</span>`;
    $('#salaryEstimator').innerHTML=salaryDetail(salary,selected.length);
    const semanticRows=report.semantic_cloud?.mode==='model-only'?selected.filter(row=>row.semantic_labeled):[],semanticSummary=summarizeCohort(semanticRows);
    const notice=`<p class="insight-card-caption">标签覆盖 ${number(semanticRows.length)} / ${number(selected.length)} 条</p>`;
    for(const[id,key,title]of [['cohortSkills','skills','技能与技术栈词云'],['cohortTasks','tasks','工作内容词云']]){
      const cloud=$('#'+id);
      cloud.innerHTML=semanticRows.length?notice+renderProfileCloud(semanticSummary[key],title):'<p class="insight-chart-empty">暂无标签，请应用已保存标签后重新生成分析</p>';
      const count=cloud.querySelectorAll('svg text').length;
      cloud.closest('article').querySelector('h4').textContent=count?`${title} · 前 ${count} 个词`:title;
    }
    $('#cohortSalaryExperience').innerHTML=renderSalaryExperienceLine(selected);
    $('#cohortEducationDonut').innerHTML=renderDonut(selected,'education','学历要求占比');
    $('#cohortProvinceDonut').innerHTML=renderDonut(selected,'province','省份岗位占比');
    $('#cohortSizeDonut').innerHTML=renderDonut(selected,'company_size','公司规模占比');
    $('#cohortExperienceDonut').innerHTML=renderDonut(selected,'experience','工作年限占比');
    drawProvinceMap(cities);
    $('#insightCompanyRanking').innerHTML=renderCompanyRanking(selected);
  }
  if(legacy){
    const salary=report.salary||{},count=Number(report.sample_rows||0),salaryCount=Number(report.quality?.salary_rows||0);
    $('#insightOverviewKpis').innerHTML=kpis({count,salary:{...salary,count:salaryCount},topCity:null,total:count});
    $('#cohortSummary').textContent='历史汇总报告';
    $('#salaryEstimator').innerHTML=salaryDetail({...salary,count:salaryCount},count);
    for(const[id]of cloudPanels)$('#'+id).innerHTML='<p class="insight-chart-empty">请重新生成分析以更新词云</p>';
    for(const id of ['cohortSalaryExperience','cohortEducationDonut','cohortProvinceDonut','cohortSizeDonut','cohortExperienceDonut'])$('#'+id).innerHTML='<p class="insight-chart-empty">重新生成分析后可查看逐条岗位统计。</p>';
    drawProvinceMap([]);$('#insightCompanyRanking').innerHTML=renderCompanyRanking([]);
  }else{
    root.querySelectorAll('[data-cohort-filter]').forEach(select=>select.addEventListener('change',update));
    $('#resetCohort').addEventListener('click',()=>{for(const[, ,id]of filters)$('#'+id).value='';update();});update();
  }
  function navigate(id){const target=$('#'+id);if(!target)return;target.scrollIntoView({behavior:typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'});for(const button of root.querySelectorAll('[data-insight-section]')){if(button.dataset.insightSection===id)button.setAttribute('aria-current','location');else button.removeAttribute('aria-current');}}
  root.addEventListener('click',event=>{
    const navigation=event.target.closest('[data-insight-section]');if(navigation){navigate(navigation.dataset.insightSection);return;}
    const open=event.target.closest('[data-insight-expand]');if(open){$('#insightChartDialogTitle').textContent=open.dataset.chartTitle;$('#insightChartDialogBody').innerHTML=$('#'+open.dataset.insightExpand).innerHTML;dialog.showModal();return;}
    if(event.target.closest('[data-close-insight-chart]'))dialog.close();
  });
  dialog.addEventListener('click',event=>{if(event.target===dialog){const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)dialog.close();}});
  let frame=0;
  const syncNavigation=()=>{frame=0;if(!root.isConnected||!root.getClientRects().length)return;const boundary=$('#insightAnalysisControls').getBoundingClientRect().bottom+64;let active=sections[0][0];for(const[id]of sections)if($('#'+id).getBoundingClientRect().top<=boundary)active=id;for(const button of root.querySelectorAll('[data-insight-section]')){if(button.dataset.insightSection===active)button.setAttribute('aria-current','location');else button.removeAttribute('aria-current');}};
  const scroll=()=>{if(!frame)frame=requestAnimationFrame(syncNavigation);};
  window.addEventListener('scroll',scroll,{passive:true});
  const resize=typeof ResizeObserver==='function'?new ResizeObserver(()=>root.style.setProperty('--insight-deck-height',`${$('#insightAnalysisControls').offsetHeight}px`)):null;
  resize?.observe($('#insightAnalysisControls'));
  return ()=>{window.removeEventListener('scroll',scroll);if(frame)cancelAnimationFrame(frame);resize?.disconnect();if(dialog.open)dialog.close();};
}
