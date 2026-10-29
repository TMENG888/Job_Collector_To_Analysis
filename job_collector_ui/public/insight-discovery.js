const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function renderClusterCards(clusters){return '<ol class="discovered-roles">'+clusters.map(c=>{const label=c.interpretation,ready=label?.status==='coherent';return `<li><div class="discovery-role-heading"><strong>${escape(label?.name||'待识别簇 '+c.id)}</strong><span>${Number(c.count).toLocaleString('zh-CN')} 条 · ${(c.share*100).toFixed(1)}%</span></div><div class="discovery-share" aria-hidden="true"><span style="width:${Math.min(100,Math.max(0,c.share*100))}%"></span></div><p>${escape(label?.summary||c.representatives?.slice(0,3).map(r=>r.title).join('、')||'暂无代表岗位')}</p><div class="discovery-role-footer"><span class="discovery-state">${!label?'待 DeepSeek 识别':ready?'候选方向较集中':label.status==='mixed'?'混杂簇，不自动训练':'方向待确认'}</span><button type="button" class="ghost" data-discovery-use="${escape(c.id)}" ${ready?'':'disabled'}>选择此方向</button></div><details><summary>代表岗位与边界样本</summary>${[...(c.representatives||[]),...(c.boundary||[])].map(r=>`<p><strong>${escape(r.title)}</strong><br>${escape(r.body)}</p>`).join('')}</details></li>`;}).join('')+'</ol>';}
export function renderDiscoveredRoles(run){
  if(!run?.clusters?.length)return '';
  const clusters=run.clusters.slice().sort((a,b)=>b.count-a.count),suggestions=run.suggestions||[];
  const grouped=suggestions.length?`<div class="discovery-directions"><strong>可选岗位方向 · 同名簇合并，混杂簇不计入</strong><div>${suggestions.slice(0,10).map(r=>`<button type="button" class="ghost" data-discovery-use="${escape(r.clusterIds[0])}">${escape(r.name)} <small>${Number(r.count).toLocaleString('zh-CN')} 条候选 · ${(r.share*100).toFixed(1)}%</small></button>`).join('')}</div></div>`:'';
  return `<p class="classifier-muted">全库 ${Number(run.total).toLocaleString('zh-CN')} 条 · ${Number(run.clusterCount)} 个候选簇；簇占比不是已确认职位占比。</p>${grouped}<details class="discovery-evidence"><summary>查看聚类与代表岗位</summary>${renderClusterCards(clusters.slice(0,6))}${clusters.length>6?`<details><summary>其余 ${clusters.length-6} 个簇</summary>${renderClusterCards(clusters.slice(6))}</details>`:''}</details>`;
}
export function installInsightDiscovery({api,toast}){
  const slot=document.querySelector('[data-discovery-slot]');if(!slot)return;
  slot.innerHTML='<details class="training-discovery"><summary>发现岗位方向 <span>不知道分析什么岗位时使用</span></summary><div class="discovery-controls"><label>识别预算（元）<input data-discovery-budget type="number" min="0.05" max="0.50" step="0.05" value="0.50"></label><button type="button" class="secondary" data-discovery-name disabled>发现岗位方向</button><button type="button" class="ghost" data-discovery-cancel hidden>停止</button></div><p data-discovery-status role="status" aria-live="polite" class="classifier-muted"></p><div data-discovery-results></div><details class="discovery-local-settings"><summary>本地聚类选项</summary><button type="button" class="ghost" data-discovery-scan>仅做本地聚类（不调用AI）</button></details></details>';
  const $=s=>slot.querySelector(s);let state=null,pending=false,error='',actionError='',loading=false,authorized=null;
  const unsupported=()=>slot.dataset.workflowSupported==='false';
  function render(){
    const run=state?.run,busy=!!state?.busy||pending;
    $('[data-discovery-scan]').disabled=busy||!state?.capability||unsupported();
    $('[data-discovery-name]').disabled=busy||!state?.capability||!state?.model?.configured||unsupported();
    $('[data-discovery-name]').textContent=run?.status==='clustering'?'聚类中…':run?.status==='naming'?'识别中…':run?.status==='partial'?'识别剩余方向':run?.status==='clustered'?'识别岗位方向':run?.status==='completed'?'重新发现岗位方向':'发现岗位方向';
    $('[data-discovery-budget]').disabled=busy;$('[data-discovery-cancel]').hidden=!state?.busy&&!authorized;
    $('[data-discovery-status]').textContent=unsupported()?'':error||run?.message||(!state?.capability?'正在读取岗位方向…':'确认一次预算后完成本地聚类与AI识别；选择方向不会自动训练。');
    const html=renderDiscoveredRoles(run);if($('[data-discovery-results]').dataset.signature!==html){$('[data-discovery-results]').innerHTML=html;$('[data-discovery-results]').dataset.signature=html;}
  }
  async function refresh(){
    if(loading||unsupported()){render();return;}loading=true;
    try{state=await api('/api/insights/discovery');error=actionError;render();}catch(e){error=e.message;render();}finally{loading=false;}
    if(authorized&&state?.run?.id===authorized.runId){
      if(state.run.status==='clustered'&&!pending){const consent=authorized;authorized=null;await post('name',{confirmed:true,budget:consent.budget});await refresh();}
      else if(['failed','cancelled','interrupted'].includes(state.run.status))authorized=null;
    }else if(authorized&&state?.run?.id&&state.run.id!==authorized.runId)authorized=null;
  }
  async function post(action,body={}){pending=true;error='';actionError='';render();let result;try{result=await api('/api/insights/discovery/'+action,{method:'POST',body:JSON.stringify(body)});if(action==='scan'||action==='name')state={...state,busy:true,run:{...state?.run,...(action==='scan'?result:{}),status:action==='scan'?'clustering':'naming'}};}catch(e){actionError=error=e.message;authorized=null;toast(e.message,true);}finally{pending=false;render();}return result;}
  $('[data-discovery-scan]').onclick=async()=>{if(window.confirm('只在本机聚类全岗位库，不调用AI，不收费。继续？')){authorized=null;await post('scan');await refresh();}};
  $('[data-discovery-name]').onclick=async()=>{
    if(pending||state?.busy||unsupported())return;const budget=Number($('[data-discovery-budget]').value);
    if(!Number.isFinite(budget)||budget<.05||budget>.5){toast('识别预算须为0.05–0.50元',true);return;}
    if(!window.confirm('使用已有聚类或先在本机聚类，再向DeepSeek发送少量脱敏公开JD识别岗位方向。本轮估算上限¥'+budget.toFixed(2)+'，不发送简历，不自动付费重试，不启动分类器训练。继续？'))return;
    if(['clustered','partial'].includes(state?.run?.status)){await post('name',{confirmed:true,budget});await refresh();}
    else {const run=await post('scan');if(run?.id){authorized={runId:run.id,budget};await refresh();}}
  };
  $('[data-discovery-cancel]').onclick=async()=>{authorized=null;await post('cancel');await refresh();};
  slot.addEventListener('click',event=>{const button=event.target.closest('[data-discovery-use]');if(!button||button.disabled)return;const cluster=state?.run?.clusters.find(c=>c.id===button.dataset.discoveryUse),label=cluster?.interpretation;if(label?.status!=='coherent')return;const input=document.querySelector('[data-training-keywords]');if(!input||input.disabled)return;input.value=label.name;input.dispatchEvent(new Event('input',{bubbles:true}));const panel=document.querySelector('[data-training-panel]');if(panel)panel.open=true;input.focus();input.scrollIntoView({block:'center',behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});toast('已填入岗位名称；确认训练预算后才会执行');});
  slot.querySelector('details').addEventListener('toggle',()=>{if(slot.querySelector('details').open)void refresh();});
  document.addEventListener('insight-training-capability',()=>render());
  document.addEventListener('insight-workflow-refresh',()=>{if(slot.querySelector('details').open)void refresh();});
  setInterval(()=>{if(!document.hidden&&slot.querySelector('details').open&&!pending)void refresh();},5000);
}
