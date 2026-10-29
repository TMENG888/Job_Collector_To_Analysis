import {classifierAcceptanceIssues,classifierAnalysisState} from './insight-classifier-state.js?v=20261027-stratified';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number=value=>Number(value||0).toLocaleString('zh-CN');
const pct=value=>value==null?'—':(value*100).toFixed(1)+'%';
const runningStatuses=['preparing','labeling','training'];
export function classifierStartBlocker({state,inputFile='',pending='',semanticBusy=false}={}){
  if(pending)return pending==='start'?'正在启动联合标注…':'正在处理规范操作，请稍候。';
  if(!state)return '正在读取标注配置…';
  if(state.capabilities?.training!==true)return '后台尚未加载标注功能，请重启后台。';
  if(!inputFile.startsWith('kb://task/'))return '请选择具体岗位数据集后再启动联合标注。';
  if(!state.credentials?.configured)return '未读取到 Qwen 标注密钥，请检查分类器配置。';
  if(state.busy)return '联合标注、训练或规范操作正在进行中。';
  if(semanticBusy)return '词云标注正在进行中，请等待完成后再启动。';
  if(!state.annotationSchema?.approved)return '请先确认当前岗位的标注规范。';
  if(state.annotationSchema.draft&&state.annotationSchema.approved.parentDraftId!==state.annotationSchema.draft.id)return '请先确认新起草的标注规范。';
  return '';
}
export function renderClassifierMetrics(run,active){
  if(!run)return '';
  const e=run.evaluation,busy=runningStatuses.includes(run.status);
  const metric=(title,m)=>m?`<section class="classifier-evaluation"><h3>${escape(title)}</h3><dl><div><dt>样本</dt><dd>${number(m.n)}</dd></div><div><dt>准确率</dt><dd>${pct(m.accuracy)}</dd></div><div><dt>精确率</dt><dd>${pct(m.precision)}</dd></div><div><dt>召回率</dt><dd>${pct(m.recall)}</dd></div><div><dt>F1</dt><dd>${pct(m.f1)}</dd></div></dl><small>TP ${number(m.tp)} · FP ${number(m.fp)} · FN ${number(m.fn)} · TN ${number(m.tn)}</small></section>`:'';
  const targeted=run.targeted===true,counts=e?.counts;
  const comparisons=e?.comparison?.length?`<div class="classifier-comparison"><table><caption>同一批新测试样本对照</caption><thead><tr><th>方案</th><th>精确率</th><th>召回率</th><th>F1</th></tr></thead><tbody>${e.comparison.map(row=>`<tr><th>${escape(row.name)}</th><td>${pct(row.metrics?.precision)}</td><td>${pct(row.metrics?.recall)}</td><td>${pct(row.metrics?.f1)}</td></tr>`).join('')}</tbody></table></div>`:'';
  const legacyShortage=run.status==='failed'&&/正负样本不足|有效正负标签不足/.test(run.message||'');
  const message=active?.id&&active.id===run.id?'本轮模型已启用':busy?'联合标注与训练中':run.status==='completed'?'本轮标注完成':legacyShortage?`标签已保留：正例 ${number(run.positive)}、负例 ${number(run.negative)}；隔离后样本不足，请更新检索词或补充不同公司岗位后再标注。`:run.message||run.status;
  const issues=run.status==='completed'&&run.eligible===false?classifierAcceptanceIssues(e):[];
  const sampling=run.sampling,allocation=sampling?.allocations||{},readiness=run.trainingReadiness;
  return `<div class="classifier-progress"><strong>${escape(message)}</strong>${busy?`<progress max="${run.sampled||run.requestedSamples||1}" value="${run.labeled||0}" aria-label="联合标注进度"></progress>`:''}</div>
    <dl class="classifier-counters"><div><dt>已标注／抽样</dt><dd>${number(run.labeled)} / ${number(run.sampled)}</dd></div><div><dt>正例／负例／待核</dt><dd>${number(run.positive)} / ${number(run.negative)} / ${number(run.review)}</dd></div><div><dt>测试 F1 · 对 Qwen 标签</dt><dd>${pct(e?.test?.f1)}</dd></div><div><dt>估算费用／预算</dt><dd>¥${Number(run.costEstimate||0).toFixed(4)} / ¥${Number(run.budget||0)}</dd></div></dl>
    <details class="classifier-metric-details"><summary>评测与用量${issues.length?' · '+issues.length+' 项未达标':''}</summary>
    ${sampling?`<p class="classifier-muted">规范召回候选 ${number(sampling.targetCandidates)} 条；本轮目标候选 ${number((allocation.target_candidate||0)+(allocation.target_overflow||0))}、相近候选 ${number((allocation.related_candidate||0)+(allocation.related_overflow||0))}、随机 ${number(allocation.random_source)}、其他补位 ${number((allocation.source_fallback||0)+(allocation.background_fallback||0))}。候选不等于正例；富集抽样指标不代表全库准确率。</p>${(sampling.warnings||[]).map(w=>`<p class="classifier-muted">${escape(w)}</p>`).join('')}`:''}
    ${readiness?.ready===false?`<p class="classifier-muted">训练前检查：${readiness.counts?Object.entries(readiness.counts).map(([key,c])=>`${escape(({train:'训练',validation:'验证',test:'测试'})[key]||key)}正／负 ${number(c.positive)}／${number(c.negative)}`).join('；'):`至少还缺正例 ${number(readiness.deficits?.positive)}、负例 ${number(readiness.deficits?.negative)}、有效标签 ${number(readiness.deficits?.total)} 条`}。已完成标签保留，不自动追加费用。</p>`:''}
    ${issues.length?`<p class="classifier-gate"><strong>未通过正式发布验收</strong><span>${escape(issues.join('；'))}</span></p>`:''}
    ${e?`<p class="classifier-muted">训练 ${number(counts?.train?.n)} · 验证 ${number(counts?.validation?.n)} · 测试 ${number(counts?.test?.n)}；公司与近重复隔离。${targeted?'本轮新增 '+number(run.labeled)+' 条；旧测试 '+number(e.excluded_rows)+' 条不参与训练或调参。':''}以下是对 Qwen 标签的一致性，非人工准确率。</p><div class="classifier-evaluations">${metric(targeted?'新留出测试':'留出测试',e.test)}${metric('验证集',e.validation)}</div>${comparisons}`:''}
    <p class="classifier-muted">输入 ${number(run.promptTokens)} / 输出 ${number(run.completionTokens)} Token · 缓存输入 ${number(run.cachedTokens)} · 请求 ${number(run.requestsCompleted)} / ${number(run.requestsStarted)}${run.unknownUsageRequests?' · 用量待核 '+number(run.unknownUsageRequests)+' 次':''}。费用为估算，非实际账单。</p></details>`;
}
export function installInsightClassifier({api,toast}){
  const root=document.querySelector('#insightClassifier');if(!root)return;
  root.classList.add('supervised-screening');root.dataset.screeningMode='supervised';
  root.innerHTML='<div class="classifier-current"><strong data-ml-current>正在读取分类器…</strong><span class="classifier-muted" data-ml-version></span></div><p id="insightAnalysisNotice" class="insight-analysis-notice classifier-muted" role="status" hidden></p><button type="button" class="ghost" data-ml-cancel hidden>停止本轮标注</button><details class="classifier-result-details" hidden><summary>评测与技术标签 <span data-ml-summary></span></summary><div class="classifier-workspace" hidden><section class="classifier-training-results" hidden aria-label="标注与训练结果"><div data-ml-results></div></section><div data-semantic-slot></div></div></details>';
  const $=s=>root.querySelector(s),source=()=>document.querySelector('#insightForm input[name="inputFile"]')?.value||'',role=()=>document.querySelector('#insightRole')?.value||'';
  let state=null,epoch=0,loading=null,queued=false,error='',pending=false;
  function render(){
    const chooseRole=source()==='kb://all'&&!role(),analysis=chooseRole?{kind:'choose',title:'请选择目标岗位',reason:'选择已有岗位可直接分析；新增方向请展开训练。'}:classifierAnalysisState(state),ready=!chooseRole&&state?.screening?.ready===true,run=state?.run;
    root.dataset.readiness=analysis.kind;
    $('[data-ml-current]').textContent=analysis.title;
    $('[data-ml-version]').textContent=error?'':analysis.reason;
    $('#insightAnalysisNotice').textContent=error;$('#insightAnalysisNotice').hidden=!error;
    $('[data-ml-summary]').textContent=run?.evaluation?.test?`测试 F1 ${pct(run.evaluation.test.f1)}`:'';
    $('[data-ml-cancel]').hidden=!run||!runningStatuses.includes(run.status)||!state?.busy;
    $('[data-ml-cancel]').disabled=pending;
    const html=renderClassifierMetrics(run,state?.activeModel);
    if($('[data-ml-results]').dataset.signature!==html){const open=$('.classifier-metric-details')?.open;$('[data-ml-results]').innerHTML=html;if(open&&$('.classifier-metric-details'))$('.classifier-metric-details').open=true;$('[data-ml-results]').dataset.signature=html;}
    $('.classifier-training-results').hidden=!run;
    $('.classifier-workspace').hidden=!run&&root.querySelector('#semanticCloudControls')?.hidden!==false;
    $('.classifier-result-details').hidden=$('.classifier-workspace').hidden;
    const button=document.querySelector('#runInsight');
    if(button){
      const canAnalyze=analysis.kind==='ready'||analysis.kind==='trial',trial=analysis.kind==='trial';
      Object.assign(button.dataset,{classifierSource:source(),classifierRole:role(),screeningMode:'supervised',supervisedReady:String(ready),analysisReady:String(canAnalyze),classifierMode:trial?'candidate-trial':'qualified',classifierRunId:trial?state.analysis.runId:''});
      const analyzing=!!document.querySelector('#insightStatus .insight-run-state.running')||button.dataset.submitting==='true';
      button.disabled=!canAnalyze||analyzing;button.textContent=analyzing?'分析中…':trial?'生成试分析':'生成分析';button.title=analysis.reason;
    }
    root.dispatchEvent(new CustomEvent('insight-annotation-state',{detail:{inputFile:source(),state:state||{}}}));
  }
  async function refresh(){
    if(loading){queued=true;return loading;}
    loading=(async()=>{do{queued=false;const inputFile=source(),request=epoch;
      try{const next=await api('/api/insights/classifier?inputFile='+encodeURIComponent(inputFile)+'&role='+encodeURIComponent(role()));if(request===epoch&&inputFile===source()){state=next;error='';render();}}
      catch(e){if(request===epoch&&inputFile===source()){state=null;error='分类器读取失败：'+e.message;render();}}
      if(request!==epoch||inputFile!==source())queued=true;
    }while(queued);})();
    try{await loading;}finally{loading=null;}
  }
  document.addEventListener('insight-workflow-refresh',()=>void refresh());
  $('[data-ml-cancel]').onclick=async()=>{if(pending)return;pending=true;render();try{await api('/api/insights/classifier/cancel',{method:'POST',body:'{}'});await refresh();}catch(e){error=e.message;toast(e.message,true);}finally{pending=false;render();}};
  root.addEventListener('insight-semantic-visibility',()=>{$('.classifier-workspace').hidden=!state?.run&&root.querySelector('#semanticCloudControls')?.hidden!==false;$('.classifier-result-details').hidden=$('.classifier-workspace').hidden;});
  for(const id of ['#insightDataset','#insightRole'])document.querySelector(id)?.addEventListener('change',()=>{epoch++;state=null;error='';render();void refresh();});
  setInterval(()=>{if(!document.hidden&&!document.querySelector('#insightsView')?.classList.contains('hidden'))void refresh();},5000);
  render();void refresh();return {refresh};
}
