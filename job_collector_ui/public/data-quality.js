const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const number=value=>value==null?'—':new Intl.NumberFormat('zh-CN').format(value);
const rate=(n,d)=>d?`${(n/d*100).toFixed(1)}%`:'—';
const stamp=value=>value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'—';
const states={pending:'待处理',retained:'已确认保留',resolved:'已标记修复'};
const meter=(n,d)=>`<span class="quality-rate"><span class="quality-meter" aria-hidden="true"><i style="width:${d?Math.min(100,n/d*100):0}%"></i></span><span>${rate(n,d)}</span></span>`;
const table=(head,rows,caption)=>`<div class="quality-table-scroll${head.length>=4?' quality-table-wide':''}" tabindex="0" role="region" aria-label="${escape(caption)}"><table><caption class="quality-sr">${escape(caption)}</caption><thead><tr>${head.map(h=>`<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${rows||`<tr><td colspan="${head.length}" class="quality-empty">暂无数据</td></tr>`}</tbody></table></div>`;
const panel=(title,body,extra='')=>`<section class="quality-panel"><header><h2>${title}</h2>${extra}</header>${body}</section>`;

export function renderQualityReport(report){
  const r=report,s=r.salary,u=r.usable,total=r.total;
  const metrics=[['当前去重岗位',total,'同平台＋岗位ID'],['可用正文',u.body,`${rate(u.body,total)} 的岗位`],['可统计薪资',u.salary,`${rate(u.salary,total)} 的岗位`],['存在质量问题',r.problemJobs,'同一岗位只计一次']];
  const fields=table(['字段','有效 / 检查','完整率'],r.fields.map(f=>`<tr><th scope="row">${escape(f.name)}</th><td>${number(f.valid)} <span class="quality-muted">/ ${number(f.total)}</span></td><td>${meter(f.valid,f.total)}</td></tr>`).join(''),'关键字段完整性');
  const uses=[['岗位数量',u.jobs,'身份及名称有效'],['薪资分布',u.salary,'符合当前图表薪资口径'],['省份对比',u.province,'省份可识别'],['技能提取',u.body,'正文可用'],['发布时间',u.publication,'发布时间可解析且无未来异常'],['分类纳入',u.classifierIncluded,'入库时纳入至少一个岗位方向']];
  const usable=`<div class="quality-uses">${uses.map(([name,count,basis])=>`<div><span><strong>${name}</strong><small>${basis}</small></span><span><b>${number(count)}</b><small>${rate(count,total)}</small></span></div>`).join('')}</div><div class="quality-label-coverage"><span>规则命中技能 <b>${number(u.ruleSkills)}</b></span><span>有证据的已批准技能标签 <b>${number(u.approvedSkills)}</b></span><span>分类待核 <b>${number(u.classifierReview)}</b></span></div>`;
  const platforms=table(['平台','岗位数','可用正文','可统计薪资','省份可识别','学历有效','经验有效'],r.platformQuality.map(p=>`<tr><th scope="row">${escape(p.name)}</th><td>${number(p.rows)}</td>${[p.usable.body,p.usable.salary,p.usable.province,p.fields.education,p.fields.experience].map(n=>`<td><strong>${rate(n,p.rows)}</strong><small>${number(n)} / ${number(p.rows)}</small></td>`).join('')}</tr>`).join(''),'各平台质量对比');
  const salary=`<div class="quality-salary"><div><span>薪资解析率</span><strong>${rate(s.parsed,s.numericProvided)}</strong><small>${number(s.parsed)} / ${number(s.numericProvided)} 条非面议薪资文本</small></div><dl>${[['提供薪资文本',s.provided],['面议 / 保密',s.negotiable],['解析失败',s.failed],['日薪折算',s.dailyConverted],['隐含月薪已识别',s.inferredMonthly],['可统计月薪',s.usable]].map(([key,value])=>`<div><dt>${key}</dt><dd>${number(value)}</dd></div>`).join('')}</dl></div>`;
  const normalization=table(['字段处理','原始值','规范化结果','处理依据'],(r.normalizations||[]).map(item=>`<tr><th scope="row">${escape(item.kind)}<small>${escape(item.platform)} · ${escape(item.jobId)}</small></th><td>${escape(item.original)}</td><td>${escape(item.result)}</td><td>${escape(item.basis)}</td></tr>`).join(''),'清洗前后对照');
  const audit=r.ingestion,tracked=audit.batches.length>0;
  const batchTable=table(['批次 / 任务','输入条次','批内重复','去重后','新增','更新','无变化','隔离'],audit.batches.map(b=>`<tr><th scope="row">${escape(b.label)}<small>${stamp(b.createdAt)} · ${escape(b.id.slice(0,8))}</small></th>${['input','duplicates','unique','inserted','updated','unchanged','invalid'].map(k=>`<td>${number(b[k])}</td>`).join('')}</tr>`).join(''),'已留痕的最近20次入库');
  const quarantine=table(['任务','平台','岗位ID','岗位名称','隔离原因'],audit.quarantineSamples.map(i=>`<tr><td>${escape(i.label)}</td><td>${escape(i.platform)}</td><td>${escape(i.jobId)}</td><td>${escape(i.title)}</td><td>${escape(i.reason)}</td></tr>`).join(''),'未正常入库记录样例');
  const processing=`<div class="quality-audit-summary">${[['输入条次','input'],['批内重复','duplicates'],['新增','inserted'],['更新','updated'],['无变化','unchanged'],['隔离','invalid']].map(([name,key])=>`<div><span>${name}</span><strong>${tracked?number(audit.totals[key]):'—'}</strong></div>`).join('')}</div><p class="quality-note">${tracked?'自 '+stamp(audit.firstRecordedAt)+' 起的已留痕处理条次；历史批次未留痕。':'历史入库批次未留痕，无法准确还原新增、更新或隔离数量。新入库开始记录。'}</p><details><summary>查看入库批次与隔离样例</summary>${batchTable}${quarantine}</details>`;
  return `<div class="quality-meta"><span>${escape(r.scope.label)}${r.scope.platform==='all'?'':' / '+escape(r.scope.platform)}</span><span>检查 ${stamp(r.createdAt)} <span class="quality-separator">|</span> 数据版本 ${number(r.revision)}</span></div>
    <div class="quality-metrics">${metrics.map(([label,value,note])=>`<div><span>${label}</span><strong>${number(value)}</strong><small>${note}</small></div>`).join('')}</div>
    <div class="quality-grid">${panel('关键字段完整性',fields)}${panel('分析可用范围',usable,`<span class="quality-muted">基数 ${number(total)} 条</span>`)}</div>
    ${panel('各平台质量',platforms)}
    ${panel('薪资解析与清洗',salary+`<details><summary>查看清洗前后对照</summary>${normalization}</details>`)}
    ${panel('问题明细',`<div class="quality-issue-toolbar"><label>问题类型<select id="qualityIssueType"><option value="">全部问题</option>${r.issues.map(i=>`<option value="${escape(i.type)}">${escape(i.name)}（${number(i.count)}）</option>`).join('')}</select></label><label>处理状态<select id="qualityIssueState"><option value="">全部状态</option>${Object.entries(states).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select></label><span id="qualityIssueCount" class="quality-muted"></span></div><div id="qualityIssues"></div><div class="quality-pagination"><button class="ghost" type="button" data-quality-page="-1">上一页</button><span id="qualityPage" aria-live="polite"></span><button class="ghost" type="button" data-quality-page="1">下一页</button></div>`, '<span class="quality-muted">每平台、每类最多20条样例</span>')}
    ${panel('入库处理去向',processing)}
    <details class="quality-provenance"><summary>报告依据与统计口径</summary><dl><div><dt>报告快照</dt><dd>${escape(r.id)}</dd></div><div><dt>检查规则</dt><dd>${escape(r.provenance.rulesVersion)}</dd></div><div><dt>统计范围</dt><dd>${escape(r.provenance.scopePolicy)}</dd></div><div><dt>完整率</dt><dd>有效非空岗位数 ÷ 本次检查岗位数；“不限”与“未提供”分别保留。正文需至少16字且不是已识别的访问提示。</dd></div><div><dt>薪资口径</dt><dd>${escape(r.provenance.salaryPolicy)}</dd></div><div><dt>分类口径</dt><dd>${escape(r.provenance.classificationPolicy)}</dd></div><div><dt>时间口径</dt><dd>${escape(r.provenance.publicationPolicy)}</dd></div><div><dt>问题样例</dt><dd>${escape(r.provenance.samplePolicy)}人工处理状态不改写原始数据，也不改变报告数量。</dd></div><div><dt>分类版本</dt><dd>${r.provenance.classifierVersions.map(escape).join('<br>')||'本范围无可追溯分类版本'}</dd></div><div><dt>解析规则指纹</dt><dd>${escape(r.provenance.salaryParserSha256)}</dd></div></dl></details>`;
}

let installed=null;
export async function loadDataQuality({api,toast}){
  if(installed){await installed.load();return;}
  const root=document.querySelector('#qualityView');if(!root)return;
  root.innerHTML=`<div class="quality-toolbar"><div class="quality-filters"><label>采集范围<select id="qualityTask"><option value="all">全岗位知识库</option></select></label><label>平台<select id="qualityPlatform"><option value="all">全部平台</option></select></label><label>报告<select id="qualityHistory"><option value="">当前数据</option></select></label></div><div class="quality-actions"><button type="button" class="secondary" id="qualityExport" disabled>导出报告</button><button type="button" class="primary" id="qualityRefresh">检查更新</button></div></div><div id="qualityStatus" role="status" aria-live="polite"></div><div id="qualityReport"></div><dialog id="qualityIssueDialog" aria-labelledby="qualityIssueTitle"><div class="quality-dialog-head"><h2 id="qualityIssueTitle">问题详情</h2><button type="button" class="ghost" data-quality-close aria-label="关闭问题详情">×</button></div><div id="qualityIssueDetail"></div></dialog>`;
  const q=selector=>root.querySelector(selector),reportRoot=q('#qualityReport');let current=null,annotations={},page=0,busy=false,history=[],selectedIssue=null;
  const issueState=issue=>annotations[issue.id]?.state||'pending';
  function renderIssues(){
    if(!current)return;
    const type=q('#qualityIssueType').value,state=q('#qualityIssueState').value;
    const filtered=current.samples.filter(i=>(!type||i.type===type)&&(!state||issueState(i)===state));
    const pages=Math.max(1,Math.ceil(filtered.length/15));page=Math.min(Math.max(page,0),pages-1);
    const count=type?current.issues.find(i=>i.type===type)?.count:current.issues.reduce((n,i)=>n+i.count,0);
    q('#qualityIssueCount').textContent=`${number(count)} 项问题 · ${number(filtered.length)} 条可查看样例`;
    q('#qualityIssues').innerHTML=table(['岗位 / 平台','问题','原始值','处理状态',''],filtered.slice(page*15,page*15+15).map(i=>`<tr><th scope="row">${escape(i.title)}<small>${escape(i.platform)} · ${escape(i.jobId)}</small></th><td>${escape(i.name)}</td><td class="quality-original" title="${escape(i.original)}">${escape(i.original||'未提供')}</td><td><span class="quality-state" data-state="${issueState(i)}">${states[issueState(i)]||states.pending}</span></td><td><button class="ghost" type="button" data-quality-issue="${escape(i.id)}" aria-label="查看${escape(i.title)}的${escape(i.name)}">查看</button></td></tr>`).join(''),'数据质量问题样例');
    q('#qualityPage').textContent=`${page+1} / ${pages}`;
    q('[data-quality-page="-1"]').disabled=page===0;q('[data-quality-page="1"]').disabled=page>=pages-1;
  }
  function filters(){
    q('#qualityTask').innerHTML='<option value="all">全岗位知识库</option>'+current.tasks.map(t=>`<option value="${escape(t.id)}">${escape(t.label)}</option>`).join('');q('#qualityTask').value=current.scope.taskId;
    q('#qualityPlatform').innerHTML='<option value="all">全部平台</option>'+current.platforms.map(p=>`<option value="${escape(p.platform)}">${escape(p.platform)}（${number(p.rows)}）</option>`).join('');q('#qualityPlatform').value=current.scope.platform;
    const saved=q('#qualityHistory').value;
    q('#qualityHistory').innerHTML='<option value="">当前数据</option>'+history.map(r=>`<option value="${escape(r.id)}">${stamp(r.createdAt)} · ${escape(r.scope.label)}${r.scope.platform==='all'?'':' / '+escape(r.scope.platform)}</option>`).join('');q('#qualityHistory').value=saved;
  }
  async function load({reportId=q('#qualityHistory').value,taskId=q('#qualityTask').value,platform=q('#qualityPlatform').value}={}){
    if(busy)return;busy=true;for(const id of ['qualityRefresh','qualityTask','qualityPlatform','qualityHistory','qualityExport'])q('#'+id).disabled=true;q('#qualityStatus').textContent='正在检查已入库岗位…';reportRoot.setAttribute('aria-busy','true');
    try{
      const query=new URLSearchParams(reportId?{reportId}:{taskId,platform});
      const result=await api('/api/knowledge/quality?'+query,{timeoutMs:125000});current=result.report;annotations=result.states||{};
      history=(await api('/api/knowledge/quality/history')).reports;
      filters();q('#qualityHistory').value=reportId||'';
      reportRoot.innerHTML=renderQualityReport(current);page=0;renderIssues();
      q('#qualityStatus').textContent=result.reused?'已读取保存的报告，检查时间见下方。':'检查完成，报告已保存。';q('#qualityExport').disabled=false;
    }catch(error){q('#qualityStatus').innerHTML=`<span class="quality-error">${escape(error.message)}</span>`;}
    finally{busy=false;for(const id of ['qualityRefresh','qualityTask','qualityPlatform','qualityHistory'])q('#'+id).disabled=false;q('#qualityExport').disabled=!current;reportRoot.setAttribute('aria-busy','false');}
  }
  q('#qualityRefresh').addEventListener('click',()=>{q('#qualityHistory').value='';void load({reportId:''});});
  q('#qualityTask').addEventListener('change',()=>{q('#qualityHistory').value='';void load({reportId:'',platform:'all'});});
  q('#qualityPlatform').addEventListener('change',()=>{q('#qualityHistory').value='';void load({reportId:''});});
  q('#qualityHistory').addEventListener('change',()=>void load());
  root.addEventListener('change',event=>{if(['qualityIssueType','qualityIssueState'].includes(event.target.id)){page=0;renderIssues();}});
  root.addEventListener('click',async event=>{
    const target=event.target.closest('button');if(!target)return;
    if(target.hasAttribute('data-quality-close')){q('#qualityIssueDialog').close();return;}
    if(target.dataset.qualityPage){page+=Number(target.dataset.qualityPage);renderIssues();return;}
    if(target.dataset.qualityIssue){
      selectedIssue=current.samples.find(i=>i.id===target.dataset.qualityIssue);if(!selectedIssue)return;const i=selectedIssue;
      q('#qualityIssueTitle').textContent=i.name;
      q('#qualityIssueDetail').innerHTML=`<p class="quality-detail-job">${escape(i.title)}<small>${escape(i.platform)} · ${escape(i.jobId)}</small></p><dl><div><dt>原始值</dt><dd class="quality-evidence">${escape(i.original||'未提供')}</dd></div><div><dt>处理结果</dt><dd>${escape(i.normalized)}</dd></div><div><dt>处理依据</dt><dd>${escape(i.handling)}</dd></div><div><dt>内容版本</dt><dd class="quality-hash">${escape(i.contentHash)}</dd></div></dl><label class="quality-state-label">人工处理状态<select id="qualityMarkState">${Object.entries(states).map(([k,v])=>`<option value="${k}"${issueState(i)===k?' selected':''}>${v}</option>`).join('')}</select></label><p class="quality-note">标记状态不修改原始岗位；修复数据后需检查更新。</p><div class="quality-dialog-actions">${i.url?`<a class="secondary" href="${escape(i.url)}" target="_blank" rel="noopener noreferrer">查看原岗位</a>`:''}<button type="button" class="primary" data-quality-save>保存状态</button></div>`;
      q('#qualityIssueDialog').showModal();
    }
    if(target.hasAttribute('data-quality-save')&&selectedIssue){
      target.disabled=true;
      try{const result=await api('/api/knowledge/quality/state',{method:'POST',body:JSON.stringify({reportId:current.id,issueId:selectedIssue.id,state:q('#qualityMarkState').value})});annotations[selectedIssue.id]=result.state;renderIssues();q('#qualityIssueDialog').close();toast('处理状态已保存');}
      catch(error){toast(error.message,true);}finally{target.disabled=false;}
    }
  });
  q('#qualityExport').addEventListener('click',()=>{if(!current)return;const blob=new Blob([JSON.stringify({...current,issueStates:annotations},null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`数据质量报告-${current.id.slice(0,8)}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
  installed={load};await load();
}
