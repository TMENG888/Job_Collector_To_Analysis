const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number=value=>Number(value||0).toLocaleString('zh-CN');
const pct=value=>value==null?'—':(value*100).toFixed(1)+'%';
const busyStatuses=['preparing','labeling','training'];
export function renderClassifierMetrics(run,active){
  if(!run)return '<p class="classifier-muted">尚无标注记录</p>';
  const e=run.evaluation,metric=(title,m)=>`<div class="classifier-evaluation"><h4>${title}</h4>${m?`<dl><div><dt>样本</dt><dd>${number(m.n)}</dd></div><div><dt>准确率</dt><dd>${pct(m.accuracy)}</dd></div><div><dt>精确率</dt><dd>${pct(m.precision)}</dd></div><div><dt>召回率</dt><dd>${pct(m.recall)}</dd></div><div><dt>F1</dt><dd>${pct(m.f1)}</dd></div></dl><small>TP ${m.tp} · FP ${m.fp} · FN ${m.fn} · TN ${m.tn}</small>`:'<p class="classifier-muted">尚无人工核验数据，不报告真实准确率／召回率</p>'}</div>`;
  return `<div class="classifier-progress" role="status"><strong>${escape(run.role)} · ${escape(active?.id===run.id?'已采用监督分类器；后续分析直接使用本地TF-IDF＋逻辑回归':run.message)}</strong><progress max="${run.sampled||run.requestedSamples||1}" value="${run.labeled||0}"></progress></div>
    <dl class="classifier-counters"><div><dt>已标注／抽样</dt><dd>${number(run.labeled)} / ${number(run.sampled)}</dd></div><div><dt>正例／负例／待核</dt><dd>${number(run.positive)} / ${number(run.negative)} / ${number(run.review)}</dd></div><div><dt>输入／输出 Token</dt><dd>${number(run.promptTokens)} / ${number(run.completionTokens)}</dd></div><div><dt>费用估算／预算</dt><dd>¥${Number(run.costEstimate||0).toFixed(4)} / ¥${run.budget}</dd></div></dl>
    <p class="classifier-muted">总Token ${number(run.totalTokens)} · 缓存输入 ${number(run.cachedTokens)} · 请求 ${number(run.requestsCompleted)} / ${number(run.requestsStarted)}${run.unknownUsageRequests?` · ${number(run.unknownUsageRequests)}次用量待核对`:''}。按设定单价估算，非实际账单；未扣代金券、缓存折扣。</p>
    ${e?`<p class="classifier-muted">训练 ${e.counts.train.n} · 验证 ${e.counts.validation.n} · 测试 ${e.counts.test.n}；公司与近重复隔离。以下仅代表本次定向抽样，不代表全库准确率。</p><div class="classifier-evaluations">${metric('留出测试 · 对Qwen标签的一致性（代理指标）',e.test)}${metric('人工复核 · 当前已核验测试子集',e.human_metrics)}</div>`:''}
    ${active?`<p class="classifier-active">当前筛选：Qwen标签训练的本地TF-IDF＋逻辑回归 · 不回退规则</p>`:''}`;
}
export function installInsightClassifier({api,toast,onActivated}){
  const root=document.querySelector('#insightClassifier');if(!root)return;
  root.innerHTML=`<header class="classifier-header"><div><h2>大模型辅助分类</h2><span data-ml-model>Qwen3.7-Flash → TF-IDF＋逻辑回归</span></div><button type="button" class="ghost" data-ml-refresh>刷新</button></header>
    <div class="classifier-controls"><label>抽样条数<input data-ml-count type="number" value="400" min="120" max="2000" step="20"></label><label>本轮预算（元）<input data-ml-budget type="number" value="2" min="0.01" max="20" step="0.1"></label><button type="button" class="primary" data-ml-start disabled>Qwen 标注并训练</button><button type="button" class="ghost" data-ml-cancel hidden>停止</button><button type="button" class="secondary" data-ml-activate hidden>使用分类器生成分析</button></div>
    <p data-ml-notice class="classifier-muted" role="status" aria-live="polite">选择具体岗位数据集后可启动；每次调用均需点击确认。</p>
    <div data-ml-results></div>
    <details class="classifier-settings"><summary>密钥与费用估算设置</summary><form data-ml-settings><label>新 API Key<input name="apiKey" type="password" autocomplete="off" maxlength="512" placeholder="本机加密保存，保存后清空"></label><button class="secondary" type="submit">保存密钥</button><span data-ml-credential></span></form><div class="classifier-price-controls"><label>输入单价（元／百万Token）<input data-ml-input-price type="number" min="0.001" max="100" step="0.01" value="0.2"></label><label>输出单价（元／百万Token）<input data-ml-output-price type="number" min="0.001" max="100" step="0.01" value="0.8"></label></div><small>默认采用公开短上下文估算价；请按当前百炼业务空间计价调整。调用只发送脱敏的岗位标题和职责。</small></details>
    <details data-ml-review-wrap hidden><summary>人工核验独立测试样本</summary><p class="classifier-muted">请阅读原文自行判断。留空不计分；核验标签不会回流本轮训练或调阈值。</p><div data-ml-review></div><div class="classifier-review-pages"><button class="ghost" type="button" data-ml-prev>上一页</button><span data-ml-page></span><button class="ghost" type="button" data-ml-next>下一页</button></div></details>`;
  const $=q=>root.querySelector(q),source=()=>document.querySelector('#insightForm input[name="inputFile"]')?.value||'';
  let state=null,loading=false,serial=0,reviewRows=[],reviewPage=0,reviewId=null;
  const post=(action,body)=>api('/api/insights/classifier/'+action,{method:'POST',body:JSON.stringify(body)});
  function render(){
    if(!state)return;
    const run=state.run,running=run&&busyStatuses.includes(run.status),selected=source().startsWith('kb://task/');
    $('[data-ml-start]').disabled=!selected||!state.credentials.configured||state.busy;
    $('[data-ml-cancel]').hidden=!running;
    const ready=state.screening?.ready===true;
    $('[data-ml-activate]').hidden=!ready;
    const analysisButton=document.querySelector('#runInsight');
    if(analysisButton){analysisButton.dataset.classifierSource=source();analysisButton.dataset.supervisedReady=String(ready);const analyzing=!!document.querySelector('#insightStatus .insight-run-state.running');analysisButton.disabled=!ready||analyzing;analysisButton.textContent=analyzing?'分析运行中…':ready?'生成全量分析':'请先训练分类器';}
    $('[data-ml-credential]').textContent=state.credentials.configured?'已配置 · Windows当前用户加密':'尚未配置';
    $('[data-ml-notice]').textContent=running?'训练通过验收后自动采用；不会自动追加付费标注。':ready?'岗位筛选仅使用监督分类器；Qwen代理评测不等于人工准确率。':state.screening?.error||'请选择具体岗位数据集，先标注并训练监督分类器。';
    const html=renderClassifierMetrics(run,state.activeModel)+(state.totals?.runs>1?`<p class="classifier-muted">此数据集累计 ${number(state.totals.runs)} 轮 · 输入 ${number(state.totals.promptTokens)} / 输出 ${number(state.totals.completionTokens)} Token · 估算 ¥${state.totals.costEstimate.toFixed(4)}（包含失败轮次）</p>`:'');if($('[data-ml-results]').innerHTML!==html)$('[data-ml-results]').innerHTML=html;
    $('[data-ml-review-wrap]').hidden=!run?.evaluation;
    if(reviewId!==run?.id){reviewId=run?.id;reviewRows=[];reviewPage=0;$('[data-ml-review]').replaceChildren();}
  }
  async function refresh(){
    if(loading)return;loading=true;const inputFile=source(),request=++serial;
    try{const data=await api('/api/insights/classifier?inputFile='+encodeURIComponent(inputFile));if(request===serial&&source()===inputFile){state=data;render();}}
    catch(e){$('[data-ml-notice]').textContent=e.message;}finally{loading=false;}
  }
  const guard=action=>async event=>{const button=event?.currentTarget;if(button?.tagName==='BUTTON')button.disabled=true;try{await action(event);}catch(e){toast(e.message,true);}finally{if(button?.tagName==='BUTTON')button.disabled=false;render();}};
  $('[data-ml-refresh]').onclick=guard(refresh);
  $('[data-ml-start]').onclick=guard(async()=>{
    const inputFile=source(),sampleCount=Number($('[data-ml-count]').value),budget=Number($('[data-ml-budget]').value),inputPrice=Number($('[data-ml-input-price]').value),outputPrice=Number($('[data-ml-output-price]').value);
    const label=document.querySelector('#insightDataset option:checked')?.textContent||inputFile;
    if(!confirm(`对「${label}」及部分背景负例抽取最多${sampleCount}条，发送脱敏标题和职责给Qwen3.7-Flash，训练本地分类器。本轮费用估算预算¥${budget}（实际以账单为准）。通过验收后自动采用本地监督分类器，不回退规则。确认开始？`))return;
    await post('start',{inputFile,sampleCount,budget,inputPrice,outputPrice});toast('标注已启动');await refresh();
  });
  $('[data-ml-cancel]').onclick=guard(async()=>{await post('cancel',{});await refresh();});
  $('[data-ml-activate]').onclick=guard(async()=>{
    await onActivated?.();
  });
  $('[data-ml-settings]').onsubmit=guard(async event=>{event.preventDefault();const input=event.currentTarget.elements.apiKey;try{await post('settings',{apiKey:input.value.trim()});toast('密钥已加密保存');await refresh();}finally{input.value='';}});
  function renderReview(){
    $('[data-ml-review]').innerHTML=reviewRows.slice(reviewPage*10,reviewPage*10+10).map(r=>`<article class="classifier-review-item"><h4>${escape(r.title)}</h4><p>${escape(r.body)}</p><small>Qwen：${escape(r.label)} · 分类器：${escape(r.prediction)}</small><label>你的判断<select data-ml-gold="${escape(r.id)}"><option value="clear" ${!r.human?'selected':''}>未核验</option><option value="include" ${r.human==='include'?'selected':''}>属于目标岗位</option><option value="exclude" ${r.human==='exclude'?'selected':''}>不属于目标岗位</option></select></label></article>`).join('');
    $('[data-ml-page]').textContent=`${reviewPage+1} / ${Math.max(1,Math.ceil(reviewRows.length/10))} · ${reviewRows.length}条`;
    $('[data-ml-prev]').disabled=reviewPage===0;$('[data-ml-next]').disabled=(reviewPage+1)*10>=reviewRows.length;
  }
  $('[data-ml-review-wrap]').ontoggle=guard(async()=>{if(!$('[data-ml-review-wrap]').open||!state?.run?.evaluation)return;const r=await api('/api/insights/classifier/review?id='+state.run.id);reviewRows=r.rows;renderReview();});
  $('[data-ml-review]').onchange=guard(async event=>{const input=event.target;if(!input.matches('[data-ml-gold]'))return;await post('review',{id:state.run.id,sampleId:input.dataset.mlGold,decision:input.value});const row=reviewRows.find(r=>r.id===input.dataset.mlGold);row.human=input.value==='clear'?'':input.value;await refresh();});
  $('[data-ml-prev]').onclick=()=>{reviewPage--;renderReview();};$('[data-ml-next]').onclick=()=>{reviewPage++;renderReview();};
  document.querySelector('#insightDataset')?.addEventListener('change',()=>{state=null;serial++;const button=document.querySelector('#runInsight');if(button){button.dataset.supervisedReady='false';button.disabled=true;}void refresh();});
  setInterval(()=>{if(!document.hidden&&!document.querySelector('#insightsView').classList.contains('hidden'))void refresh();},3000);
  return {refresh};
}
