import {classifierAnalysisState} from './insight-classifier-state.js?v=20261027-stratified';
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
  const legacyShortage=run.status==='failed'&&/正负样本不足|有效正负标签不足/.test(run.message||'');
  const message=active?.id&&active.id===run.id?'本轮模型已启用':busy?'联合标注与训练中':run.status==='completed'?'本轮标注完成':legacyShortage?`标签已保留：正例 ${number(run.positive)}、负例 ${number(run.negative)}；隔离后样本不足，请更新检索词或补充不同公司岗位后再标注。`:run.message||run.status;
  return `<div class="classifier-progress"><strong>${escape(message)}</strong>${busy?`<progress max="${run.sampled||run.requestedSamples||1}" value="${(run.labeled||0)+(run.skipped||0)}" aria-label="联合标注进度"></progress>`:''}</div>
    <dl class="classifier-counters"><div><dt>已标注／抽样</dt><dd>${number(run.labeled)} / ${number(run.sampled)}</dd></div><div><dt>正例／负例／待核</dt><dd>${number(run.positive)} / ${number(run.negative)} / ${number(run.review)}</dd></div><div><dt>测试 F1 · 对 Qwen 标签</dt><dd>${pct(e?.test?.f1)}</dd></div><div><dt>Token 用量与费用</dt><dd>输入 ${number(run.promptTokens)} / 输出 ${number(run.completionTokens)} Token · 估算 ¥${Number(run.costEstimate||0).toFixed(4)}（非账单）</dd></div></dl>
    ${run.retryRequests||run.skipped?`<p class="classifier-muted">重试 ${number(run.retryRequests)} 次 · 跳过 ${number(run.skipped)} 条</p>`:''}`;
}
export function installInsightClassifier({api,toast}){
  const root=document.querySelector('#insightClassifier');if(!root)return;
  root.classList.add('supervised-screening');root.dataset.screeningMode='supervised';
  root.innerHTML='<div class="classifier-current"><strong data-ml-current>正在读取分类器…</strong><span class="classifier-muted" data-ml-version></span></div><p id="insightAnalysisNotice" class="insight-analysis-notice classifier-muted" role="status" hidden></p><button type="button" class="ghost" data-ml-cancel hidden>停止本轮标注</button><details class="classifier-result-details" hidden><summary>标注结果与技术标签 <span data-ml-summary></span></summary><div class="classifier-workspace" hidden><section class="classifier-training-results" hidden aria-label="标注与训练结果"><div data-ml-results></div></section><div data-semantic-slot></div></div></details>';
  const $=s=>root.querySelector(s),source=()=>document.querySelector('#insightForm input[name="inputFile"]')?.value||'',role=()=>document.querySelector('#insightRole')?.value||'';
  let state=null,epoch=0,loading=null,queued=false,error='',pending=false;
  function render(){
    const chooseRole=(source()==='kb://all'||source().startsWith('kb://processed/'))&&!role(),analysis=chooseRole?{kind:'choose',title:'请选择目标岗位',reason:'选择已有岗位可直接分析；新增方向请展开训练。'}:!state&&error?{kind:'error',title:'分类器状态读取失败',reason:''}:classifierAnalysisState(state),ready=!chooseRole&&state?.screening?.ready===true,run=state?.run;
    root.dataset.readiness=analysis.kind;
    $('[data-ml-current]').textContent=analysis.title;
    $('[data-ml-version]').textContent=error||['choose','loading','ready','pending'].includes(analysis.kind)?'':analysis.kind==='trial'?'试分析 · 候选未通过验收':analysis.reason;
    $('#insightAnalysisNotice').textContent=error;$('#insightAnalysisNotice').hidden=!error;
    $('[data-ml-summary]').textContent=run?.evaluation?.test?`测试 F1 ${pct(run.evaluation.test.f1)}`:'';
    $('[data-ml-cancel]').hidden=!run||!runningStatuses.includes(run.status)||!state?.busy;
    $('[data-ml-cancel]').disabled=pending;
    const html=renderClassifierMetrics(run,state?.activeModel);
    if($('[data-ml-results]').dataset.signature!==html){$('[data-ml-results]').innerHTML=html;$('[data-ml-results]').dataset.signature=html;}
    $('.classifier-training-results').hidden=!run;
    $('.classifier-workspace').hidden=!run&&root.querySelector('#semanticCloudControls')?.hidden!==false;
    $('.classifier-result-details').hidden=$('.classifier-workspace').hidden;
    const button=document.querySelector('#runInsight');
    if(button){
      const canAnalyze=!error&&(analysis.kind==='ready'||analysis.kind==='trial'),trial=analysis.kind==='trial';
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
      catch(e){if(request===epoch&&inputFile===source()){error='分类器状态读取失败：'+e.message+'；'+(state?'保留上次状态，':'')+'5 秒后重新读取。';render();}}
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
