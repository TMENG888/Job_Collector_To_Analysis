const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function installSemanticCloud({api,toast}){
  const parent=document.querySelector('#insightClassifier');if(!parent)return;
  const root=document.createElement('section');root.className='classifier-semantic-results';root.id='semanticCloudControls';root.hidden=true;
  (parent.querySelector('[data-semantic-slot]')||parent).append(root);
  root.innerHTML='<div data-sem-status role="status" aria-live="polite" class="classifier-muted"></div><div data-sem-labels></div><div class="classifier-extract-controls" data-sem-extract><div><strong>补充技术词云</strong><small>仅补目标岗位缺失标签，具体技术名与上层类别分别保留。</small></div><label>本批上限<input data-sem-count type="number" min="1" max="1000" step="1" value="200"></label><label>预算（元）<input data-sem-budget type="number" min="0.01" max="20" step="0.01" value="0.50"></label><button type="button" class="ghost" data-sem-start>增量提取技术标签</button><small data-sem-hint></small></div><button type="button" class="ghost" data-sem-publish hidden>应用已保存标签（不重标）</button><button type="button" class="ghost" data-sem-cancel hidden>停止提取</button>';
  const $=s=>root.querySelector(s),source=()=>document.querySelector('#insightForm input[name="inputFile"]')?.value||'';
  let state=null,loading=false,jointRun=null,classifierBusy=false,screeningReady=false,trialReady=false,publishing=false,cancelling=false,starting=false,canPublishSaved=false,epoch=0,actionError='';
  const post=(action,body)=>api('/api/insights/semantic/'+action,{method:'POST',body:JSON.stringify(body),timeoutMs:90000});
  function render(){
    const run=state?.run,running=!!state?.busy;
    parent.dataset.semanticBusy=String(running||starting);
    const supported=state?.capabilities?.incrementalConcreteSkills===true,blocked=running||starting||classifierBusy||publishing;
    $('[data-sem-extract]').setAttribute('aria-busy',String(running||starting));
    $('[data-sem-start]').disabled=blocked||!supported||!screeningReady;
    $('[data-sem-start]').textContent=starting?'正在提交…':running?'正在提取…':'增量提取技术标签';
    $('[data-sem-count]').disabled=blocked;$('[data-sem-budget]').disabled=blocked;
    $('[data-sem-hint]').textContent=!state?'正在读取提取状态…':!supported?'后台需重启以加载增量提取接口；未发起付费请求。':!screeningReady?'请先启用岗位专用分类器。':'按内容缓存复用；点击后确认本轮模型发送与预算，完成后重新生成分析。';
    $('[data-sem-cancel]').hidden=!running;
    $('[data-sem-cancel]').disabled=cancelling;
    $('[data-sem-publish]').hidden=!canPublishSaved||!jointRun?.jointAnnotations||jointRun.status!=='completed'||jointRun.semanticStatus==='completed'||!screeningReady;
    $('[data-sem-publish]').disabled=publishing||classifierBusy||running||starting;
    const newerSupplement=run&&!run.jointAnnotations&&(!jointRun||run.createdAt>=jointRun.createdAt);
    const summary=newerSupplement?run.semanticSummary:jointRun?.semanticSummary;
    const labels=summary?`<details class="classifier-label-preview"><summary>查看 AI 标签 · ${summary.sampled} 条岗位已标注</summary><div class="classifier-label-fields">${[['skills','技术与技能'],['tasks','工作职责'],['domains','业务方向'],['industries','公司行业']].map(([key,label])=>{const field=summary.fields?.[key];return `<section><h3>${label} <small>${Number(field?.unique||0)} 种 · 覆盖 ${Number(field?.taggedRows||0)} 条</small></h3><p>${field?.top?.length?field.top.map(tag=>`<span class="chip">${escape(tag.name)} · ${Number(tag.count)}</span>`).join(' '):'原文无足够证据，未编造标签'}</p></section>`;}).join('')}</div><small>岗位类别用于分类训练；具体技术名用于词云。仅统计已覆盖岗位，不代表全库频率。</small></details>`:'';
    if($('[data-sem-labels]').dataset.signature!==labels){const opened=$('[data-sem-labels] details')?.open;$('[data-sem-labels]').innerHTML=labels;if(opened&&$('[data-sem-labels] details'))$('[data-sem-labels] details').open=true;$('[data-sem-labels]').dataset.signature=labels;}
    const showingJoint=jointRun?.jointAnnotations&&!newerSupplement&&(classifierBusy||!run||run.parentRunId!==jointRun.id);
    root.hidden=!showingJoint&&!run&&!screeningReady;
    if(showingJoint){
      const label=jointRun.semanticStatus==='failed'?'语义标签发布失败':jointRun.semanticStatus==='not-published'?trialReady?'语义标签已保存 · 可用于试分析':'语义标签已保存 · 待合格模型启用':classifierBusy?'语义同步标注中':['failed','cancelled','interrupted'].includes(jointRun.status)?'已保留完成的语义标签':'正在同步语义结果';
      $('[data-sem-status]').innerHTML=`<div class="classifier-semantic-line"><strong>${escape(label)}</strong><span>当前数据集已标注 ${Number(jointRun.semanticProcessed||0)} 条 · 纳入 ${Number(jointRun.semanticAccepted||0)} 条</span></div><small>共享本轮请求与费用，背景样本不计入词云。</small>`;
    }else{
      $('[data-sem-status]').innerHTML=run?`<div class="classifier-semantic-line"><strong>${run.jointAnnotations?'语义标注结果':'增量技术提取'}</strong><span>${escape(run.message||run.status)}</span></div><div class="classifier-semantic-line"><span>本批 ${Number(run.processed||0)} / ${Number(run.sampled??run.sampleCount??0)} 条</span><span>${run.jointAnnotations?`纳入 ${Number(run.accepted||0)} · 待核 ${Number(run.uncertain||0)}`:`复用 ${Number(run.reusedRows||0)} · 批外待补 ${Number(run.remainingRows||0)}`}</span></div><small>${run.jointAnnotations?'Token与费用已计入本轮总量，不重复计费；仅代表已标注抽样。':`输入 ${Number(run.promptTokens||0).toLocaleString('zh-CN')} / 输出 ${Number(run.completionTokens||0).toLocaleString('zh-CN')} Token · 估算 ¥${Number(run.costEstimate||0).toFixed(4)}（非账单）`}</small>`:'';
    }
    if(actionError)$('[data-sem-status]').textContent=actionError;
    parent.dispatchEvent(new CustomEvent('insight-semantic-visibility'));
  }
  async function refresh(){if(loading)return;loading=true;const inputFile=source(),request=epoch;try{const s=await api('/api/insights/semantic?inputFile='+encodeURIComponent(inputFile));if(inputFile===source()&&request===epoch){state=s;render();}}catch(e){if(inputFile===source()&&request===epoch){root.hidden=false;$('[data-sem-status]').textContent=e.message;parent.dispatchEvent(new CustomEvent('insight-semantic-visibility'));}}finally{loading=false;if(source()!==inputFile||request!==epoch)void refresh();}}
  parent.addEventListener('insight-annotation-state',event=>{if(event.detail.inputFile!==source())return;const previous=jointRun;classifierBusy=!!event.detail.state.busy;screeningReady=event.detail.state.screening?.ready===true;trialReady=event.detail.state.analysis?.ready===true&&event.detail.state.analysis.mode==='candidate-trial';canPublishSaved=event.detail.state.capabilities?.savedAnnotations===true;jointRun=event.detail.state.run;render();if(previous?.id!==jointRun?.id||previous?.semanticStatus!==jointRun?.semanticStatus)void refresh();});
  parent.querySelector('[data-ml-refresh]')?.addEventListener('click',()=>void refresh());
  $('[data-sem-start]').onclick=async()=>{
    if(starting||state?.busy||classifierBusy||!screeningReady||state?.capabilities?.incrementalConcreteSkills!==true)return;
    const count=$('[data-sem-count]'),budgetInput=$('[data-sem-budget]');
    if(!count.reportValidity()||!budgetInput.reportValidity())return;
    const sampleCount=Number(count.value),budget=Number(budgetInput.value),inputFile=source(),request=epoch;
    if(!window.confirm(`允许向Qwen发送专用分类器筛选后的脱敏公开JD，增量提取最多${sampleCount}条技术标签？本轮估算预算上限¥${budget.toFixed(2)}，不替换分类器、不自动付费重试。`))return;
    starting=true;actionError='';render();
    try{const result=await post('start',{inputFile,sampleCount,budget,shareConfirmed:true});if(request===epoch&&inputFile===source()){state={...state,...result,busy:true};await refresh();}}
    catch(e){toast(e.message,true);if(request===epoch&&inputFile===source()){actionError=e.message;void refresh();}}
    finally{starting=false;render();}
  };
  $('[data-sem-cancel]').onclick=async()=>{if(cancelling)return;cancelling=true;render();try{await post('cancel',{});await refresh();}catch(e){toast(e.message,true);}finally{cancelling=false;render();}};
  $('[data-sem-publish]').onclick=async()=>{if(publishing||!jointRun)return;publishing=true;render();const inputFile=source(),id=jointRun.id;try{const result=await api('/api/insights/classifier/publish-annotations',{method:'POST',body:JSON.stringify({id,inputFile})});toast(result.message);parent.querySelector('[data-ml-refresh]')?.click();await refresh();}catch(e){toast(e.message,true);}finally{publishing=false;render();}};
  document.querySelector('#insightDataset')?.addEventListener('change',()=>{epoch++;state=null;jointRun=null;classifierBusy=false;screeningReady=false;trialReady=false;canPublishSaved=false;actionError='';render();void refresh();});
  setInterval(()=>{if(!document.hidden&&!document.querySelector('#insightsView')?.classList.contains('hidden'))void refresh();},3000);
  render();return {refresh};
}
