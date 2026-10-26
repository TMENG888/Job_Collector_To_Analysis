import {classifierAcceptanceIssues,classifierAnalysisState} from './insight-classifier-state.js?v=20261023-trial-workflow';
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
  const message=active?.id&&active.id===run.id?'本轮模型已启用':busy?'联合标注与训练中':run.status==='completed'?'本轮标注完成':run.message||run.status;
  const issues=run.status==='completed'&&run.eligible===false?classifierAcceptanceIssues(e):[];
  return `<div class="classifier-progress"><strong>${escape(message)}</strong>${busy?`<progress max="${run.sampled||run.requestedSamples||1}" value="${run.labeled||0}" aria-label="联合标注进度"></progress>`:''}</div>
    <dl class="classifier-counters"><div><dt>已标注／抽样</dt><dd>${number(run.labeled)} / ${number(run.sampled)}</dd></div><div><dt>正例／负例／待核</dt><dd>${number(run.positive)} / ${number(run.negative)} / ${number(run.review)}</dd></div><div><dt>测试 F1 · 对 Qwen 标签</dt><dd>${pct(e?.test?.f1)}</dd></div><div><dt>估算费用／预算</dt><dd>¥${Number(run.costEstimate||0).toFixed(4)} / ¥${Number(run.budget||0)}</dd></div></dl>
    <details class="classifier-metric-details"><summary>评测与用量${issues.length?' · '+issues.length+' 项未达标':''}</summary>
    ${issues.length?`<p class="classifier-gate"><strong>未通过正式发布验收</strong><span>${escape(issues.join('；'))}</span></p>`:''}
    ${e?`<p class="classifier-muted">训练 ${number(counts?.train?.n)} · 验证 ${number(counts?.validation?.n)} · 测试 ${number(counts?.test?.n)}；公司与近重复隔离。${targeted?'本轮新增 '+number(run.labeled)+' 条；旧测试 '+number(e.excluded_rows)+' 条不参与训练或调参。':''}以下是对 Qwen 标签的一致性，非人工准确率。</p><div class="classifier-evaluations">${metric(targeted?'新留出测试':'留出测试',e.test)}${metric('验证集',e.validation)}</div>${comparisons}`:''}
    <p class="classifier-muted">输入 ${number(run.promptTokens)} / 输出 ${number(run.completionTokens)} Token · 缓存输入 ${number(run.cachedTokens)} · 请求 ${number(run.requestsCompleted)} / ${number(run.requestsStarted)}${run.unknownUsageRequests?' · 用量待核 '+number(run.unknownUsageRequests)+' 次':''}。费用为估算，非实际账单。</p></details>`;
}
export function installInsightClassifier({api,toast}){
  const root=document.querySelector('#insightClassifier');if(!root)return;
  root.classList.add('supervised-screening');root.dataset.screeningMode='supervised';
  root.innerHTML=`<header class="classifier-header"><div><h2>AI 联合标注</h2><span>岗位类别＋技术／职责／业务／行业 · Qwen3.7-Flash</span></div><button type="button" class="ghost" data-ml-refresh>刷新</button></header>
    <section class="classifier-schema" aria-label="第一步：DeepSeek 标注规范"><div class="classifier-step-heading"><h3><span class="classifier-step-number">1</span> 标注规范 <small>DeepSeek</small></h3><span data-schema-status>正在读取…</span></div><div class="classifier-controls"><label>起草预算（元）<input data-schema-budget type="number" min="0.05" max="0.5" step="0.05" value="0.1"></label><button type="button" class="ghost" data-schema-draft>起草规范</button><button type="button" class="ghost" data-schema-approve disabled>确认规范</button></div><details class="classifier-schema-editor"><summary>查看或编辑规范 JSON</summary><textarea data-schema-json rows="8" maxlength="20000" aria-label="岗位标注规范 JSON" spellcheck="false"></textarea><p class="classifier-muted" data-schema-usage></p></details></section>
    <section class="classifier-labeling" aria-label="第二步：Qwen 联合标注"><div class="classifier-step-heading"><h3><span class="classifier-step-number">2</span> 联合标注 <small>Qwen</small></h3></div><div class="classifier-controls classifier-joint-controls"><label>抽样条数<input data-ml-count type="number" value="400" min="120" max="2000" step="20"></label><label>预算（元）<input data-ml-budget type="number" value="2" min="0.01" max="20" step="0.1"></label><button type="button" class="primary" data-ml-start aria-describedby="classifierTrainingNotice" disabled>联合标注并训练</button><button type="button" class="ghost" data-ml-cancel hidden>停止本轮</button></div></section>
    <p data-ml-notice class="classifier-muted" role="status" aria-live="polite" hidden></p>
    <div class="classifier-current"><strong data-ml-current>正在读取分类器…</strong><span class="classifier-muted" data-ml-version></span></div>
    <div class="classifier-workspace" hidden><section class="classifier-training-results" hidden aria-label="联合标注与训练结果"><div data-ml-results></div></section><div data-semantic-slot></div></div>
    `;
  root.querySelector('[data-ml-notice]').id='classifierTrainingNotice';
  const $=selector=>root.querySelector(selector),source=()=>document.querySelector('#insightForm input[name="inputFile"]')?.value||'';
  const post=(action,body)=>api('/api/insights/classifier/'+action,{method:'POST',body:JSON.stringify(body),timeoutMs:90000});
  let state=null,schema=null,epoch=0,loading=null,queued=false,pending='',error='',schemaSignature='';
  function schemaRender(){
    const approved=state?.annotationSchema?.approved,draft=schema?.draft,confirmed=schema?.approved,doc=confirmed?.parentDraftId===draft?.id?confirmed:draft||confirmed;
    const newDraft=state?.annotationSchema?.draft&&approved?.parentDraftId!==state.annotationSchema.draft.id;
    $('[data-schema-status]').textContent=approved&&!newDraft?'已确认 v'+approved.version:'需先确认';
    const signature=doc?.id||'';
    if(signature!==schemaSignature){schemaSignature=signature;$('[data-schema-json]').value=doc?JSON.stringify(doc.schema,null,2):'';}
    const unchanged=!!confirmed&&confirmed.parentDraftId===draft?.id&&$('[data-schema-json]').value===JSON.stringify(confirmed.schema,null,2);
    $('[data-schema-approve]').disabled=!!pending||!!state?.busy||!draft||unchanged;
    $('[data-schema-approve]').textContent=unchanged?'已确认':'确认规范';
    $('[data-schema-draft]').textContent=approved||draft?'重新起草':'起草规范';
    $('[data-schema-draft]').disabled=!!pending||!!state?.busy||state?.capabilities?.annotationSchemas!==true||!source().startsWith('kb://task/');
    const usage=doc?.usage;
    $('[data-schema-usage]').textContent=usage?'本次起草估算 ¥'+Number(usage.estimate||0).toFixed(4)+'（非账单）':'';
  }
  function render(){
    const ready=state?.screening?.ready===true,run=state?.run;
    const analysis=classifierAnalysisState(state);
    root.dataset.readiness=analysis.kind;
    $('[data-ml-current]').textContent=analysis.title;
    $('[data-ml-version]').textContent=ready?'专用 TF-IDF＋LR · '+analysis.reason:analysis.kind==='trial'?'专用 TF-IDF＋LR · 未达标候选':analysis.reason;
    const blocker=classifierStartBlocker({state,inputFile:source(),pending,semanticBusy:root.dataset.semanticBusy==='true'});
    $('[data-ml-notice]').textContent=error||blocker;
    $('[data-ml-notice]').hidden=!$('[data-ml-notice]').textContent;
    $('[data-ml-start]').disabled=!!blocker;
    $('[data-ml-start]').title=blocker||'使用已确认规范，确认预算后启动 Qwen 联合标注与训练';
    $('[data-ml-start]').setAttribute('aria-disabled',String(!!blocker));
    $('[data-ml-start]').textContent=pending==='start'?'正在启动…':'联合标注并训练';
    $('[data-ml-cancel]').hidden=!run||!runningStatuses.includes(run.status)||!state?.busy;
    $('[data-ml-cancel]').disabled=!!pending;
    $('[data-ml-refresh]').disabled=!!pending||!!loading;
    const html=renderClassifierMetrics(run,state?.activeModel);
    if($('[data-ml-results]').dataset.signature!==html){const open=$('.classifier-metric-details')?.open;$('[data-ml-results]').innerHTML=html;if(open&&$('.classifier-metric-details'))$('.classifier-metric-details').open=true;$('[data-ml-results]').dataset.signature=html;}
    $('.classifier-training-results').hidden=!run;
    $('.classifier-workspace').hidden=!run&&root.querySelector('#semanticCloudControls')?.hidden!==false;
    const button=document.querySelector('#runInsight');
    if(button){const analysisReady=analysis.kind==='ready'||analysis.kind==='trial';button.dataset.classifierSource=source();button.dataset.screeningMode='supervised';button.dataset.supervisedReady=String(ready);button.dataset.analysisReady=String(analysisReady);button.dataset.classifierMode=analysis.kind==='trial'?'candidate-trial':'qualified';button.dataset.classifierRunId=analysis.kind==='trial'?state.analysis.runId:'';const analyzing=!!document.querySelector('#insightStatus .insight-run-state.running')||button.dataset.submitting==='true';button.disabled=!analysisReady||analyzing;button.textContent=analyzing?'分析运行中…':analysis.kind==='trial'?'生成全量试分析':'生成全量分析';button.title=analysis.reason;const notice=document.querySelector('#insightAnalysisNotice');if(notice){notice.textContent=error||(analysis.kind==='trial'?analysis.reason:!analysisReady?analysis.reason:'');notice.hidden=!notice.textContent;}}
    schemaRender();
    root.dispatchEvent(new CustomEvent('insight-annotation-state',{detail:{inputFile:source(),state:state||{}}}));
  }
  async function refresh(){
    if(loading){queued=true;return loading;}
    loading=(async()=>{do{queued=false;const inputFile=source(),request=epoch;
      try{
        const next=await api('/api/insights/classifier?inputFile='+encodeURIComponent(inputFile));
        const nextSchema=inputFile.startsWith('kb://task/')&&next.capabilities?.annotationSchemas?await api('/api/insights/classifier/schema?inputFile='+encodeURIComponent(inputFile)):null;
        if(request===epoch&&inputFile===source()){state=next;schema=nextSchema;error='';render();}
      }catch(e){if(request===epoch&&inputFile===source()){state=null;error='分类器读取失败：'+e.message;render();}}
      if(request!==epoch||inputFile!==source())queued=true;
    }while(queued);})();
    try{await loading;}finally{loading=null;$('[data-ml-refresh]').disabled=!!pending;}
  }
  const action=(name,fn)=>async()=>{if(pending)return;pending=name;error='';render();try{await fn();await refresh();}catch(e){error=e.message;toast(e.message,true);}finally{pending='';render();}};
  $('[data-ml-refresh]').onclick=()=>void refresh();
  $('[data-schema-json]').addEventListener('input',()=>schemaRender());
  $('[data-schema-draft]').onclick=action('schema',async()=>{
    const inputFile=source(),request=epoch,budget=Number($('[data-schema-budget]').value);
    if(!Number.isFinite(budget)||budget<.05||budget>.5)throw Error('起草预算须为0.05–0.50元');
    if(!confirm('向DeepSeek发送岗位名称和通用边界，起草标注规范，预算上限¥'+budget+'；不发送简历，不自动付费重试。继续？'))return;
    const draft=await post('schema-draft',{inputFile,budget,shareConfirmed:true});
    if(request===epoch&&inputFile===source()){schema={...schema,draft};schemaSignature='';schemaRender();}
  });
  $('[data-schema-approve]').onclick=action('approve',async()=>{
    if(!schema?.draft)return;
    let value;try{value=JSON.parse($('[data-schema-json]').value);}catch{throw Error('规范不是有效JSON，请检查后确认');}
    await post('schema-approve',{id:schema.draft.id,inputFile:source(),schema:value,confirmed:true});
    toast('岗位标注规范已确认');
  });
  $('[data-ml-start]').onclick=action('start',async()=>{
    const inputFile=source(),sampleCount=Number($('[data-ml-count]').value),budget=Number($('[data-ml-budget]').value);
    if(!Number.isInteger(sampleCount)||sampleCount<120||sampleCount>2000||!Number.isFinite(budget)||budget<=0||budget>20)throw Error('抽样须为120–2000条，预算须大于0且不超过20元');
    if(!confirm('向Qwen发送最多'+sampleCount+'条脱敏岗位，联合标注岗位类别与四类语义，训练专用TF-IDF＋LR。预算上限¥'+budget+'（估算非账单），通过验收才采用，不自动付费重试。继续？'))return;
    await post('start',{inputFile,sampleCount,budget,jointAnnotations:true});toast('联合标注并训练已启动');
  });
  $('[data-ml-cancel]').onclick=action('cancel',()=>post('cancel',{}));
  root.addEventListener('insight-semantic-visibility',()=>{$('.classifier-workspace').hidden=!state?.run&&root.querySelector('#semanticCloudControls')?.hidden!==false;});
  document.querySelector('#insightDataset')?.addEventListener('change',()=>{epoch++;state=null;schema=null;schemaSignature='';error='';$('[data-schema-json]').value='';render();void refresh();});
  setInterval(()=>{if(!document.hidden&&!document.querySelector('#insightsView')?.classList.contains('hidden'))void refresh();},5000);
  render();return {refresh};
}
