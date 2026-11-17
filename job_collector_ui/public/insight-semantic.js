const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function jointSemanticStatus(run,{classifierBusy=false,trialReady=false}={}){
  if(run.semanticStatus==='failed')return '语义标签发布失败';
  if(run.semanticStatus==='completed')return '技术与职责标签已保存';
  if(run.semanticStatus==='not-published')return trialReady?'语义标签已保存 · 可用于试分析':'语义标签已保存 · 待合格模型启用';
  if(['failed','cancelled','interrupted'].includes(run.status))return '已保留完成的语义标签';
  if(['preparing','labeling','training'].includes(run.status))return classifierBusy?'语义同步标注中':'已保留完成的语义标签';
  return '语义标签已保存 · 待同步';
}
export function installSemanticCloud({api,toast}){
  const parent=document.querySelector('#insightClassifier');if(!parent)return;
  const root=document.createElement('section');root.className='classifier-semantic-results';root.id='semanticCloudControls';root.hidden=true;
  (parent.querySelector('[data-semantic-slot]')||parent).append(root);
  root.innerHTML='<div data-sem-status role="status" aria-live="polite" class="classifier-muted"></div><div data-sem-labels></div><button type="button" class="ghost" data-sem-publish hidden>应用已保存标签</button><button type="button" class="ghost" data-sem-cancel hidden>停止提取</button>';
  const $=s=>root.querySelector(s),source=()=>document.querySelector('#insightForm input[name="inputFile"]')?.value||'';
  let state=null,loading=false,jointRun=null,classifierBusy=false,screeningReady=false,trialReady=false,publishing=false,cancelling=false,canPublishSaved=false,epoch=0;
  const selectedRole=()=>document.querySelector('#insightRole')?.value||'';
  const post=(action,body)=>api('/api/insights/semantic/'+action,{method:'POST',body:JSON.stringify(body),timeoutMs:90000});
  function render(){
    const run=state?.run,running=!!state?.busy;
    parent.dataset.semanticBusy=String(running);
    $('[data-sem-cancel]').hidden=!running;
    $('[data-sem-cancel]').disabled=cancelling;
    $('[data-sem-publish]').hidden=!canPublishSaved||!jointRun?.jointAnnotations||jointRun.status!=='completed'||jointRun.semanticStatus==='completed'||!screeningReady;
    $('[data-sem-publish]').disabled=publishing||classifierBusy||running;
    const newerSupplement=run&&!run.jointAnnotations&&(!jointRun||run.createdAt>=jointRun.createdAt);
    const reusedJoint=run?.jointAnnotations&&run.parentRunId!==jointRun?.id;
    const retainedSummary=reusedJoint?run.semanticSummary:jointRun?.semanticSummary;
    const supplementComplete=newerSupplement&&run.status==='completed'&&run.semanticSummary;
    const summary=supplementComplete||retainedSummary||run?.semanticSummary;
    const partialSupplement=newerSupplement&&run.status!=='completed'&&!retainedSummary;
    const previewTitle=partialSupplement?`本批标签 · ${Number(summary?.sampled||0)} 条`:`抽样标签 · ${Number(summary?.sampled||0)} 条`;
    const labels=summary?`<details class="classifier-label-preview"><summary>${previewTitle}</summary><div class="classifier-label-fields">${[['skills','技术与技能'],['tasks','工作职责']].map(([key,label])=>{const field=summary.fields?.[key];return `<section><h3>${label} <small>${Number(field?.unique||0)} 种 · 覆盖 ${Number(field?.taggedRows||0)} 条</small></h3><p>${field?.top?.length?field.top.map(tag=>`<span class="chip">${escape(tag.name)} · ${Number(tag.count)}</span>`).join(' '):'暂无标签'}</p></section>`;}).join('')}</div></details>`:'';
    if($('[data-sem-labels]').dataset.signature!==labels){const opened=$('[data-sem-labels] details')?.open;$('[data-sem-labels]').innerHTML=labels;if(opened&&$('[data-sem-labels] details'))$('[data-sem-labels] details').open=true;$('[data-sem-labels]').dataset.signature=labels;}
    const showingJoint=jointRun?.jointAnnotations&&!newerSupplement&&(classifierBusy||!run||run.parentRunId!==jointRun.id);
    root.hidden=!showingJoint&&!run;
    if(showingJoint){
      const label=jointSemanticStatus(jointRun,{classifierBusy,trialReady});
      $('[data-sem-status]').innerHTML=`<div class="classifier-semantic-line"><strong>${escape(label)}</strong><span>已标注 ${Number(jointRun.semanticProcessed||0)} 条 · 纳入 ${Number(jointRun.semanticAccepted||0)} 条</span></div>`;
    }else{
      const label=run?.status==='completed'?'标签已保存':({preparing:'准备中',labeling:'提取中',running:'提取中',failed:'提取失败',cancelled:'已停止',interrupted:'已中断'}[run?.status]||'标签待应用');
      const problem=['failed','interrupted'].includes(run?.status)?run.message:'';
      $('[data-sem-status]').innerHTML=run?`<div class="classifier-semantic-line"><strong>${label}</strong><span>已标注 ${Number(run.processed||0)} / ${Number(run.sampled??run.sampleCount??0)} 条${run.jointAnnotations?` · 纳入 ${Number(run.accepted||0)} · 待核 ${Number(run.uncertain||0)}`:` · 待补 ${Number(run.remainingRows||0)} · 估算 ¥${Number(run.costEstimate||0).toFixed(4)}`}</span></div>${problem?`<p role="alert">${escape(problem)}</p>`:''}`:'';
    }
    parent.dispatchEvent(new CustomEvent('insight-semantic-visibility'));
  }
  async function refresh(){if(loading)return;loading=true;const inputFile=source(),request=epoch;try{const s=await api('/api/insights/semantic?inputFile='+encodeURIComponent(inputFile)+'&role='+encodeURIComponent(selectedRole()));if(inputFile===source()&&request===epoch){state=s;render();}}catch(e){if(inputFile===source()&&request===epoch){root.hidden=false;$('[data-sem-status]').textContent=e.message;parent.dispatchEvent(new CustomEvent('insight-semantic-visibility'));}}finally{loading=false;if(source()!==inputFile||request!==epoch)void refresh();}}
  parent.addEventListener('insight-annotation-state',event=>{if(event.detail.inputFile!==source())return;const previous=jointRun;classifierBusy=!!event.detail.state.busy;screeningReady=event.detail.state.screening?.ready===true;trialReady=event.detail.state.analysis?.ready===true&&event.detail.state.analysis.mode==='candidate-trial';canPublishSaved=event.detail.state.capabilities?.savedAnnotations===true;jointRun=event.detail.state.run;render();if(previous?.id!==jointRun?.id||previous?.semanticStatus!==jointRun?.semanticStatus)void refresh();});
  document.addEventListener('insight-workflow-refresh',()=>void refresh());
  $('[data-sem-cancel]').onclick=async()=>{if(cancelling)return;cancelling=true;render();try{await post('cancel',{});await refresh();}catch(e){toast(e.message,true);}finally{cancelling=false;render();}};
  $('[data-sem-publish]').onclick=async()=>{if(publishing||!jointRun)return;publishing=true;render();const inputFile=source(),id=jointRun.id;try{const result=await api('/api/insights/classifier/publish-annotations',{method:'POST',body:JSON.stringify({id,inputFile})});toast(result.message);document.dispatchEvent(new Event('insight-workflow-refresh'));await refresh();}catch(e){toast(e.message,true);}finally{publishing=false;render();}};
  document.querySelector('#insightDataset')?.addEventListener('change',()=>{epoch++;state=null;jointRun=null;classifierBusy=false;screeningReady=false;trialReady=false;canPublishSaved=false;render();void refresh();});
  document.querySelector('#insightRole')?.addEventListener('change',()=>{epoch++;state=null;jointRun=null;classifierBusy=false;screeningReady=false;trialReady=false;canPublishSaved=false;render();void refresh();});
  setInterval(()=>{if(!document.hidden&&!document.querySelector('#insightsView')?.classList.contains('hidden'))void refresh();},3000);
  render();return {refresh};
}
