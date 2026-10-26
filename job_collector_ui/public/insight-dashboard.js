import {summarizeCohort,cohortConditionValue,filterCohort,cohortFilterOptions,cohortSalaryStatistics} from './insight-cohorts.js';
import {renderProfileCloud,renderDonut,renderSalaryExperienceLine} from './insight-profile-charts.js';

const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number=value=>Number(value||0).toLocaleString('zh-CN');
const percent=value=>`${(Number(value||0)*100).toFixed(1)}%`;
const filters=[['city','城市','cohortCity'],['experience','经验','cohortExperience'],['education','学历','cohortEducation'],['company_size','公司规模','cohortCompanySize'],['employment_type','用工类型','cohortEmployment']];
const sections=[['insightOverviewSection','市场概览'],['insightSalarySection','薪资与经验'],['insightSkillsSection','岗位能力'],['insightLocationSection','需求分布']];
const heading=(id,number,title,extra='')=>`<header class="insight-section-heading"><div><span class="insight-section-number" aria-hidden="true">${number}</span><h3 id="${id}">${title}</h3></div>${extra}</header>`;
const expand=(target,title)=>`<button type="button" class="insight-chart-expand" data-insight-expand="${target}" data-chart-title="${title}" aria-label="展开${title}" title="展开查看"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 3H3v4m10-4h4v4M3 13v4h4m10-4v4h-4"/></svg></button>`;
const cloudPanels=[['cohortSkills','技能与技术栈词云'],['cohortTasks','工作内容词云'],['cohortDomains','业务方向词云'],['cohortIndustries','公司行业词云']];
const cloudMarkup=()=>cloudPanels.map(([id,title])=>`<article class="profile-cloud-panel"><header class="insight-chart-heading"><h4>${title}</h4>${expand(id,title)}</header><div id="${id}"></div></article>`).join('');
const mapMarkup=()=>`<div class="insight-grid map-layout"><article class="card insight-panel map-panel"><header class="insight-chart-heading"><h4>城市行政分布</h4><span class="insight-card-caption">点击城市筛选</span></header><div id="cityMap" class="city-map" aria-label="中国城市岗位样本分布图"></div></article><article class="card insight-panel"><header class="insight-chart-heading"><h4>城市排名</h4><span class="insight-card-caption">岗位数 · 月薪中位数</span></header><div id="insightCityRanking"></div></article></div><div id="insightCityDetail"></div>`;

export function cityCohortStatistics(rows,metadata=[]){
  const groups=new Map(),locations=new Map(metadata.map(city=>[cohortConditionValue({city:city.name},'city'),city]));
  for(const row of rows){const name=cohortConditionValue(row,'city');if(!groups.has(name))groups.set(name,[]);groups.get(name).push(row);}
  return [...groups].map(([name,jobs])=>{const salary=cohortSalaryStatistics(jobs);return {...locations.get(name),name,count:jobs.length,median_salary_k:salary.count>=5?salary.median:null};}).sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name,'zh-CN'));
}

export function renderCityRanking(cities,{interactive=true}={}){
  if(!cities.length)return '<p class="insight-chart-empty">暂无城市数据</p>';
  const max=Math.max(1,...cities.map(city=>city.count));
  return `<ol class="insight-city-ranking">${cities.slice(0,10).map((city,i)=>`<li><${interactive?'button type="button"':'div'} class="insight-city-row" ${interactive?`data-insight-city="${escape(city.name)}" aria-label="筛选${escape(city.name)}，${number(city.count)}条岗位"`:''}><span class="insight-city-index">${i+1}</span><span class="insight-city-name">${escape(city.name)}</span><span class="insight-city-bar" aria-hidden="true"><i style="width:${city.count/max*100}%"></i></span><b>${number(city.count)}</b><small>${city.median_salary_k==null?'—':`${city.median_salary_k}K`}</small></${interactive?'button':'div'}></li>`).join('')}</ol>`;
}

function kpis({count,salary,topCity,total}){
  const enough=salary.count>=5&&Number.isFinite(salary.median);
  return `<div class="stats insight-kpis">
    <div class="stat"><span>匹配岗位</span><strong>${number(count)}</strong><em>当前范围 / ${number(total)} 条分析样本</em></div>
    <div class="stat"><span>招聘月薪中位数</span><strong>${enough?`${salary.median.toFixed(1)}<small>K/月</small>`:'—'}</strong><em>${enough?`P25–P75 · ${Number.isFinite(salary.p25)?salary.p25.toFixed(1):'—'}–${Number.isFinite(salary.p75)?salary.p75.toFixed(1):'—'}K`:'有效薪资样本不足5条'}</em></div>
    <div class="stat"><span>薪资可用率</span><strong>${percent(count?salary.count/count:0)}</strong><em>${number(salary.count)} 条有效月薪样本</em></div>
    <div class="stat"><span>最大需求城市</span><strong>${escape(topCity?.name||'—')}</strong><em>${topCity?`${number(topCity.count)} 条岗位 · ${percent(count?topCity.count/count:0)}`:'暂无城市数据'}</em></div>
  </div>`;
}
function salaryDetail(salary,selectedCount){
  const enough=salary.count>=5&&Number.isFinite(salary.median),fmt=value=>enough&&Number.isFinite(value)?`${value.toFixed(1)}K/月`:'—';
  return `<div class="insight-salary-primary"><span>招聘月薪中位数</span><strong>${enough?salary.median.toFixed(1):'—'}<small>K/月</small></strong></div>
    <dl class="insight-salary-details"><div><dt>月薪平均值</dt><dd>${fmt(salary.mean)}</dd></div><div><dt>P25</dt><dd>${fmt(salary.p25)}</dd></div><div><dt>P75</dt><dd>${fmt(salary.p75)}</dd></div><div><dt>有效薪资样本</dt><dd>${number(salary.count)} <small>/ ${number(selectedCount)}</small></dd></div></dl>
    ${!enough?'<p class="insight-chart-empty">有效薪资少于5条，暂不展示薪资分位数。</p>':''}`;
}

export function renderInsightWorkspace(root,report,{drawCityMap=()=>{},drawCityDetail=()=>{}}={}){
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
    ${heading('insightSkillsHeading','03','岗位能力画像','<span class="insight-section-unit">技能 · 职责 · 业务 · 行业</span>')}<div class="insight-grid two-col profile-cloud-grid">${cloudMarkup()}</div>
  </section>
  <section class="insight-section" id="insightLocationSection" aria-labelledby="insightLocationHeading">
    ${heading('insightLocationHeading','04','需求结构与地域')}
    <div class="insight-grid two-col insight-distribution-grid"><article class="profile-chart-panel"><header class="insight-chart-heading"><h4>学历要求占比</h4></header><div id="cohortEducationDonut"></div></article><article class="profile-chart-panel"><header class="insight-chart-heading"><h4>城市岗位占比</h4></header><div id="cohortCityDonut"></div></article></div>
    ${mapMarkup()}
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
    const selected=filterCohort(rows,profile),summary=summarizeCohort(selected),salary=cohortSalaryStatistics(selected),cities=cityCohortStatistics(selected,report.cities);
    const active=filters.filter(([field])=>profile[field]),scopes=active.map(([field,label])=>`${label}：${profile[field]}`);
    $('#insightFilterCount').textContent=active.length?`${active.length} 项筛选`:'全部条件';
    $('#insightOverviewKpis').innerHTML=kpis({count:selected.length,salary,topCity:cities[0],total:rows.length});
    $('#cohortSummary').innerHTML=`<span class="insight-scope-dot" aria-hidden="true"></span><b>${number(selected.length)} 条匹配岗位</b><span>${escape(scopes.join(' / ')||'全部分析样本')}${!selected.length?' · 暂无匹配，请调整筛选':''}</span>`;
    $('#salaryEstimator').innerHTML=salaryDetail(salary,selected.length);
    const semanticRows=report.semantic_cloud?.mode==='model-only'?selected.filter(row=>row.semantic_labeled):[],semanticSummary=summarizeCohort(semanticRows);
    const reused=semanticRows.length-new Set(semanticRows.map(row=>row.semantic_key||row.job_id)).size;
    const notice=`<p class="insight-card-caption">AI累计标注 ${number(report.semantic_cloud?.sampled||0)} 条 · 当前范围覆盖 ${number(semanticRows.length)} / ${number(selected.length)} 条${reused?`（含 ${number(reused)} 条同文标签复用）`:''} · 仅统计已提取岗位</p>`;
    for(const[id,key,title]of [['cohortSkills','skills','技能与技术栈词云'],['cohortTasks','tasks','工作内容词云'],['cohortDomains','business_domains','业务方向词云'],['cohortIndustries','industries','公司行业词云']])$('#'+id).innerHTML=semanticRows.length?notice+renderProfileCloud(semanticSummary[key],title,key==='industries'):'<p class="insight-chart-empty">当前筛选范围没有已应用的 AI 语义标签。请检查上方联合标注结果，再点击“生成全量分析”；已保存标签可直接复用，无需重复付费。</p>';
    $('#cohortSalaryExperience').innerHTML=renderSalaryExperienceLine(selected);
    $('#cohortEducationDonut').innerHTML=renderDonut(selected,'education','学历要求占比');
    $('#cohortCityDonut').innerHTML=renderDonut(selected,'city','城市岗位占比');
    $('#insightCityRanking').innerHTML=renderCityRanking(cities);
    drawCityMap(cities);
    if(profile.city)drawCityDetail(profile.city,selected);else $('#cityMapDetail')?.remove();
  }
  if(legacy){
    $('.map-panel .insight-card-caption').remove();
    const salary=report.salary||{},count=Number(report.sample_rows||0),salaryCount=Number(report.quality?.salary_rows||0);
    $('#insightOverviewKpis').innerHTML=kpis({count,salary:{...salary,count:salaryCount},topCity:report.cities?.[0],total:count});
    $('#cohortSummary').textContent='历史汇总报告';
    $('#salaryEstimator').innerHTML=salaryDetail({...salary,count:salaryCount},count);
    for(const[id]of cloudPanels)$('#'+id).innerHTML='<p class="insight-chart-empty">历史词云已停用，请完成模型语义抽取并重新生成分析。</p>';
    for(const id of ['cohortSalaryExperience','cohortEducationDonut','cohortCityDonut'])$('#'+id).innerHTML='<p class="insight-chart-empty">重新生成分析后可查看逐条岗位统计。</p>';
    $('#insightCityRanking').innerHTML=renderCityRanking(report.cities||[],{interactive:false});drawCityMap(report.cities||[]);
  }else{
    root.querySelectorAll('[data-cohort-filter]').forEach(select=>select.addEventListener('change',update));
    $('#resetCohort').addEventListener('click',()=>{for(const[, ,id]of filters)$('#'+id).value='';update();});update();
  }
  function navigate(id){const target=$('#'+id);if(!target)return;target.scrollIntoView({behavior:typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'});for(const button of root.querySelectorAll('[data-insight-section]')){if(button.dataset.insightSection===id)button.setAttribute('aria-current','location');else button.removeAttribute('aria-current');}}
  root.addEventListener('click',event=>{
    const navigation=event.target.closest('[data-insight-section]');if(navigation){navigate(navigation.dataset.insightSection);return;}
    const cityButton=event.target.closest('[data-insight-city]');if(cityButton){const select=$('#cohortCity');if(select){select.value=cityButton.dataset.insightCity;update();navigate('insightOverviewSection');}return;}
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
