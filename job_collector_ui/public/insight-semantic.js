const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function installSemanticCloud({api,toast,onApply}){
  const parent=document.querySelector('#insightClassifier');if(!parent)return;
  const root=document.createElement('section');root.className='classifier-settings';root.id='semanticCloudControls';parent.append(root);
  root.innerHTML=`<h3>词云语义抽取</h3><div class="classifier-controls"><label>抽样条数<input data-sem-count type="number" min="30" max="1000" value="200"></label><label>本轮预算（元）<input data-sem-budget type="number" min="0.01" max="20" step="0.1" value="2"></label><button type="button" class="primary" data-sem-start disabled>模型提取词云</button><button type="button" class="ghost" data-sem-cancel hidden>停止词云抽取</button><button type="button" class="secondary" data-sem-apply hidden>应用词云并生成分析</button></div><p class="classifier-muted" data-sem-status role="status">仅使用模型语义标签，不回退规则；抽样统计不代表全量。</p>`;
  const $=s=>root.querySelector(s),source=()=>document.querySelector('#insightForm input[name="inputFile"]')?.value||'';
  const resume=document.createElement('button');resume.type='button';resume.className='secondary';resume.textContent='继续词云抽取';resume.hidden=true;root.querySelector('.classifier-controls').append(resume);
  let state=null,loading=false;
  const post=(action,body)=>api('/api/insights/semantic/'+action,{method:'POST',body:JSON.stringify(body)});
  function render(){
    const run=state?.run,running=state?.busy,ready=document.querySelector('#runInsight')?.dataset.supervisedReady==='true'&&document.querySelector('#runInsight')?.dataset.classifierSource===source();
    $('[data-sem-start]').disabled=!ready||running;
    $('[data-sem-cancel]').hidden=!running;
    $('[data-sem-apply]').hidden=run?.status!=='completed';
    resume.hidden=!run||!['failed','cancelled','interrupted'].includes(run.status)||!!run.unknownUsageRequests;
    $('[data-sem-status]').innerHTML=run?`${escape(run.message||run.status)} · ${run.processed||0}/${run.sampled||run.sampleCount} 条 · 语义符合 ${run.accepted||0}／不符 ${run.excluded||0}／不确定 ${run.uncertain||0}<br>输入 ${Number(run.promptTokens).toLocaleString('zh-CN')} / 输出 ${Number(run.completionTokens).toLocaleString('zh-CN')} Token · 估算 ¥${Number(run.costEstimate).toFixed(4)} / 预算 ¥${run.budget}（输入0.2／输出0.8元每百万Token估算，非账单）`:'仅使用Qwen语义标签和原文证据，不回退规则；抽样统计不代表全量。';
  }
  async function refresh(){if(loading)return;loading=true;const inputFile=source();try{const s=await api('/api/insights/semantic?inputFile='+encodeURIComponent(inputFile));if(inputFile===source()){state=s;render();}}catch(e){$('[data-sem-status]').textContent=e.message;}finally{loading=false;}}
  $('[data-sem-start]').onclick=async()=>{const inputFile=source(),sampleCount=Number($('[data-sem-count]').value),budget=Number($('[data-sem-budget]').value);if(!confirm(`对当前岗位监督筛选后的最多${sampleCount}条抽样岗位，使用Qwen3.7-Flash提取技能、职责、业务方向与行业（脱敏原文）。估算预算¥${budget}，非账单；只报告抽样频次，不外推全库。确认开始？`))return;try{$('[data-sem-start]').disabled=true;await post('start',{inputFile,sampleCount,budget});toast('词云语义抽取已启动');await refresh();}catch(e){toast(e.message,true);render();}};
  $('[data-sem-cancel]').onclick=async()=>{try{await post('cancel',{});await refresh();}catch(e){toast(e.message,true);}};
  $('[data-sem-apply]').onclick=()=>onApply?.();
  resume.onclick=async()=>{if(!confirm('复用已付费响应，按原样本及原费用预算继续剩余语义抽取，不自动重复请求用量不明的响应。确认继续？'))return;try{resume.disabled=true;await post('resume',{id:state.run.id});await refresh();}catch(e){toast(e.message,true);}finally{resume.disabled=false;}};
  document.querySelector('#insightDataset')?.addEventListener('change',()=>{state=null;render();void refresh();});
  setInterval(()=>{if(!document.hidden&&!document.querySelector('#insightsView').classList.contains('hidden'))void refresh();},3000);
  return {refresh};
}
