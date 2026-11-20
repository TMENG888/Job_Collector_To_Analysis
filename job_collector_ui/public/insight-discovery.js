const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function directions(run){
  const clusters=(run?.clusters||[]).filter(c=>c.interpretation?.name),covered=new Set();
  const grouped=(run?.suggestions||[]).map(s=>{
    const members=clusters.filter(c=>s.clusterIds?.includes(c.id)&&c.interpretation?.status==='coherent');
    if(!members.length)return null;
    members.forEach(c=>covered.add(c.id));
    return {...members[0],count:s.count,share:s.share,interpretation:{...members[0].interpretation,name:s.name},representatives:members.flatMap(c=>c.representatives||[])};
  }).filter(Boolean);
  return [...grouped,...clusters.filter(c=>!covered.has(c.id))].sort((a,b)=>b.count-a.count);
}
export function renderDiscoveredRoles(run,query=''){
  const needle=query.trim().toLocaleLowerCase(),rows=directions(run).filter(c=>[c.interpretation?.name,...(c.representatives||[]).map(r=>r.title),...(c.terms||[])].join(' ').toLocaleLowerCase().includes(needle));
  if(!rows.length)return '<p class="discovery-empty">'+(needle?'没有匹配的岗位方向':['clustering','naming'].includes(run?.status)?'识别结果将陆续显示':'暂无识别结果')+'</p>';
  return '<ol class="discovered-roles">'+rows.map(c=>{
    const label=c.interpretation,ready=label?.status==='coherent',titles=[...new Set((c.representatives||[]).map(r=>r.title).filter(Boolean))].slice(0,3);
    return `<li><div class="discovery-role-heading"><strong>${escape(label.name)}</strong><span>${Number(c.count||0).toLocaleString('zh-CN')} 条候选 · ${(Number(c.share||0)*100).toFixed(1)}%</span></div><ul class="discovery-role-titles">${titles.map(title=>`<li>${escape(title)}</li>`).join('')}</ul><div class="discovery-role-footer"><span class="discovery-state">${ready?'可选择':label.status==='mixed'?'方向混杂':'待确认'}</span><button type="button" class="ghost" data-discovery-use="${escape(c.id)}" ${ready?'':'disabled'}>选择岗位</button></div></li>`;
  }).join('')+'</ol>';
}
export function installInsightDiscovery({api,toast}){
  const slot=document.querySelector('[data-discovery-slot]');if(!slot)return;
  slot.innerHTML='<section class="training-discovery" aria-label="发现岗位方向"><div class="discovery-toolbar"><strong>岗位方向</strong><button type="button" class="secondary" data-discovery-start disabled>发现岗位方向</button><button type="button" class="ghost" data-discovery-view disabled aria-haspopup="dialog">查看岗位</button><button type="button" class="ghost" data-discovery-cancel hidden>停止</button></div><p data-discovery-status role="status" aria-live="polite" class="classifier-muted" hidden></p></section>';
  const dialog=document.createElement('dialog');dialog.className='discovery-dialog';dialog.setAttribute('aria-labelledby','discovery-dialog-title');
  dialog.innerHTML='<header class="discovery-dialog-head"><div><h2 id="discovery-dialog-title">岗位发现结果</h2><span data-discovery-count></span></div><button type="button" class="ghost" data-discovery-close aria-label="关闭岗位方向弹窗">关闭</button></header><p class="discovery-dialog-progress" data-discovery-progress role="status" aria-live="polite" hidden></p><div class="discovery-dialog-filter" data-discovery-filter><input type="search" data-discovery-search aria-label="搜索岗位方向" placeholder="搜索岗位或代表标题"></div><div class="discovery-dialog-results" data-discovery-results></div><footer class="discovery-dialog-actions" data-discovery-actions hidden><button type="button" class="secondary" data-discovery-dialog-start>发现岗位方向</button></footer>';
  document.body.append(dialog);
  const $=s=>slot.querySelector(s),$$=s=>dialog.querySelector(s);let state=null,pending=false,error='',actionError='',loading=false,authorized=null,opener=null,selectionTarget=null;
  const unsupported=()=>slot.dataset.workflowSupported==='false';
  function renderResults(){
    if(!dialog.open)return;
    const run=state?.run,rows=directions(run),named=(run?.clusters||[]).filter(c=>c.interpretation?.name).length,busy=!!state?.busy||pending||!!authorized;
    $$('[data-discovery-count]').textContent=`${rows.length} 个岗位聚类${run?.clusters?.length?` · 已识别 ${named}/${run.clusters.length} 组`:''}`;
    $$('[data-discovery-filter]').hidden=!rows.length;
    const status=$('[data-discovery-status]').textContent;
    $$('[data-discovery-progress]').textContent=status;$$('[data-discovery-progress]').hidden=!status;
    $$('[data-discovery-actions]').hidden=busy||!!rows.length&&!['partial','failed','interrupted','cancelled'].includes(run?.status);
    $$('[data-discovery-dialog-start]').disabled=$('[data-discovery-start]').disabled;
    $$('[data-discovery-dialog-start]').textContent=$('[data-discovery-start]').textContent;
    const html=renderDiscoveredRoles(run,$$('[data-discovery-search]').value),results=$$('[data-discovery-results]');
    if(results.dataset.signature!==html){results.innerHTML=html;results.dataset.signature=html;}
  }
  function render(){
    const run=state?.run,busy=!!state?.busy||pending||!!authorized;
    $('[data-discovery-start]').disabled=busy||!state?.capability||!state?.model?.configured||unsupported();
    $('[data-discovery-start]').textContent=run?.status==='clustering'?'聚类中…':run?.status==='naming'?'识别中…':run?.status==='partial'?'继续发现岗位方向':'发现岗位方向';
    $('[data-discovery-cancel]').hidden=!state?.busy&&!authorized;
    const count=directions(run).length;
    $('[data-discovery-view]').disabled=!state?.capability||unsupported();
    $('[data-discovery-view]').textContent=count?`查看结果 (${count})`:'查看结果';
    const named=(run?.clusters||[]).filter(c=>c.interpretation?.name).length;
    const status=unsupported()?'':error||(['failed','interrupted','cancelled'].includes(run?.status)?run.message||'任务已停止':busy?(run?.status==='naming'?`正在识别岗位方向 · ${named}/${run?.clusters?.length||0} 组`:'正在聚类…'):run?.status==='partial'?'部分方向待识别':'');
    const usage=run?.usage,detail=usage?`输入 ${Number(usage.input||0).toLocaleString()} / 输出 ${Number(usage.output||0).toLocaleString()} Token · 估算 ¥${Number(usage.estimate||0).toFixed(4)}（非账单）`:'';
    $('[data-discovery-status]').textContent=[status,detail].filter(Boolean).join(' · ');$('[data-discovery-status]').hidden=!status&&!detail;
    renderResults();
  }
  async function refresh(){
    if(loading||unsupported()){render();return;}loading=true;
    try{state=await api('/api/insights/discovery');error=actionError;render();}catch(e){error=e.message;render();}finally{loading=false;}
    if(authorized&&state?.run?.id===authorized.runId){
      if(state.run.status==='clustered'&&!pending){authorized=null;await post('name',{confirmed:true});await refresh();}
      else if(['failed','cancelled','interrupted'].includes(state.run.status))authorized=null;
    }else if(authorized&&state?.run?.id&&state.run.id!==authorized.runId)authorized=null;
    render();
  }
  async function post(action,body={}){pending=true;error='';actionError='';render();let result;try{result=await api('/api/insights/discovery/'+action,{method:'POST',body:JSON.stringify(body)});if(action==='scan'||action==='name')state={...state,busy:true,run:{...state?.run,...(action==='scan'?result:{}),status:action==='scan'?'clustering':'naming'}};}catch(e){actionError=error=e.message;authorized=null;toast(e.message,true);}finally{pending=false;render();}return result;}
  function openResults(){
    if(!dialog.open){opener=document.activeElement;dialog.showModal();}
    renderResults();($$('[data-discovery-filter]').hidden?$$('[data-discovery-close]'):$$('[data-discovery-search]')).focus();
  }
  async function startDiscovery(){
    if(pending||state?.busy||authorized||unsupported())return;
    $$('[data-discovery-search]').value='';openResults();
    if(['clustered','partial'].includes(state?.run?.status)){await post('name',{confirmed:true});await refresh();}
    else {const run=await post('scan');if(run?.id){authorized={runId:run.id};await refresh();}}
  }
  $('[data-discovery-start]').onclick=startDiscovery;
  $$('[data-discovery-dialog-start]').onclick=startDiscovery;
  $('[data-discovery-cancel]').onclick=async()=>{authorized=null;await post('cancel');await refresh();};
  $('[data-discovery-view]').onclick=()=>{openResults();void refresh();};
  $$('[data-discovery-close]').onclick=()=>dialog.close();
  dialog.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();dialog.close();}});
  $$('[data-discovery-search]').oninput=()=>{renderResults();$$('[data-discovery-results]').scrollTop=0;};
  dialog.addEventListener('close',()=>{const target=selectionTarget||opener;selectionTarget=null;if(target?.isConnected&&!target.disabled)target.focus();});
  dialog.addEventListener('click',event=>{
    const button=event.target.closest('[data-discovery-use]');if(!button||button.disabled)return;
    const cluster=state?.run?.clusters?.find(c=>String(c.id)===button.dataset.discoveryUse),label=cluster?.interpretation;
    if(label?.status!=='coherent')return;
    const input=document.querySelector('[data-training-keywords]');if(!input||input.disabled)return;
    input.value=label.name;input.dispatchEvent(new Event('input',{bubbles:true}));
    const panel=document.querySelector('[data-training-panel]');if(panel)panel.open=true;
    selectionTarget=input;dialog.close();input.focus();input.scrollIntoView({block:'center',behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});toast('已选择 '+label.name);
  });
  document.addEventListener('insight-training-capability',()=>render());
  document.addEventListener('insight-workflow-refresh',()=>void refresh());
  setInterval(()=>{if(!document.hidden&&(dialog.open||slot.getClientRects().length)&&!pending)void refresh();},5000);
  void refresh();
}
