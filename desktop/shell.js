/* Trusted desktop chrome only. Remote websites never receive jobDesktop. */
(() => {
  const api=window.jobDesktop, $=id=>document.getElementById(id);
  let state=null, detail=null, readGeneration=null, modelBusy=false;
  const message=text=>{$('status').textContent=text;};
  const invoke=async(name,value={})=>{try{return await api.command(name,value);}catch(error){message(error.message);throw error;}};
  const safeRun=fn=>()=>{Promise.resolve().then(fn).catch(()=>{});};
  function render(next) {
    const previous=state;state=next;
    const browser=state.mode==='browser',tab=state.tabs.find(t=>t.id===state.selectedId);
    $('workspaceRecovery').hidden=browser||state.workspaceStatus!=='error';
    $('workspaceError').textContent=state.workspaceError||'';
    $('browserChrome').hidden=!browser;$('tools').hidden=!browser;$('empty').hidden=!browser||!!tab;
    const unsupported=!!tab?.error&&!/^https:\/\//.test(tab?.url||'');
    $('pageError').hidden=!browser||!unsupported;$('pageErrorText').textContent=unsupported?tab.error:'';$('recoverBack').disabled=!tab?.back;
    document.querySelectorAll('[data-route]').forEach(e=>e.classList.toggle('active',!browser&&e.dataset.route===state.workspaceRoute));
    $('browserMode').classList.toggle('active',browser);
    $('tabs').replaceChildren();
    state.tabs.forEach(t=>{
      const wrap=document.createElement('div');wrap.className='tab'+(t.id===state.selectedId?' active':'');
      const select=document.createElement('button');select.className='select';select.textContent=(t.loading?'◌ ':'')+t.title;select.title=t.title;select.setAttribute('role','tab');select.setAttribute('aria-selected',String(t.id===state.selectedId));select.onclick=safeRun(()=>invoke('select',{id:t.id}));
      const close=document.createElement('button');close.className='close';close.textContent='×';close.title='关闭标签';close.setAttribute('aria-label','关闭 '+t.title);close.onclick=safeRun(()=>invoke('close',{id:t.id}));wrap.append(select,close);$('tabs').append(wrap);
    });
    if(document.activeElement!==$('address'))$('address').value=tab?.url||'';
    $('back').disabled=!tab?.back;$('forward').disabled=!tab?.forward;$('reload').disabled=!tab;
    $('reload').textContent=tab?.loading?'×':'↻';$('reload').title=tab?.loading?'停止加载':'刷新';
    $('detail').disabled=$('list').disabled=!tab||tab.loading||state.reading||unsupported;
    $('transport').textContent=browser?'原生网页 · 独立会话':'本地工作台';
    if(!browser&&state.workspaceStatus!=='ready')message(state.workspaceError||'正在加载本地页面…');else if(state.notice)message(state.notice);else message(tab?.error||(browser?(tab?.loading?'页面加载中…':tab?'原生网页，可直接操作':'选择招聘网站'):'本地工作台'));
    if(previous?.selectedId!==state.selectedId||tab?.loading||readGeneration?.url!==tab?.url){detail=null;readGeneration=null;$('results').replaceChildren();$('classification').textContent='';}
    updateClassify();
  }
  function updateClassify(){const tab=state?.tabs.find(t=>t.id===state.selectedId);$('classify').disabled=!detail||!$('models').value||modelBusy||tab?.loading;}
  async function read(plugin) {
    detail=null;updateClassify();$('readStatus').textContent='读取可见岗位内容…';
    try {
      const result=await invoke('read',{plugin});readGeneration={url:result.url};detail=result.rows.length===1&&result.rows[0].description.length>=30?result.rows[0]:null;
      $('results').replaceChildren();$('classification').textContent='';
      result.rows.forEach(row=>{
        const card=document.createElement('article');card.className='job';const title=document.createElement('h3');title.textContent=row.title;
        const meta=document.createElement('p');meta.textContent=[row.company,row.city,row.salary].filter(Boolean).join(' · ');card.append(title,meta);
        if(row.description){const details=document.createElement('details'),summary=document.createElement('summary'),description=document.createElement('p');summary.textContent='岗位原文';description.textContent=row.description;details.append(summary,description);card.append(details);}
        else {const button=document.createElement('button');button.className='job-link';button.textContent='打开详情';button.onclick=safeRun(()=>invoke('navigate',{url:row.url}));card.append(button);}
        $('results').append(card);
      });
      $('readStatus').textContent=`已读取 ${result.rows.length} 条 · 未翻页、未发送`;updateClassify();
    } catch { $('readStatus').textContent='读取未完成，请查看底部原因'; }
  }
  async function loadModels(){try{const value=await invoke('models');$('models').replaceChildren();for(const model of value.models){const option=document.createElement('option');option.value=model.id;option.textContent=model.role+' · 语义参照';$('models').append(option);}if(!value.models.length){const option=document.createElement('option');option.value='';option.textContent='尚无已启用语义参照';$('models').append(option);}updateClassify();}catch{$('models').replaceChildren(new Option('语义参照读取失败',''));}}
  document.querySelectorAll('[data-route]').forEach(button=>button.onclick=safeRun(()=>invoke('workspace',{route:button.dataset.route})));
  $('workspaceRetry').onclick=safeRun(()=>invoke('workspace',{route:state.workspaceRoute,retry:true}));
  $('browserMode').onclick=safeRun(async()=>{await invoke('browser');await loadModels();});
  $('back').onclick=safeRun(()=>invoke('back'));$('forward').onclick=safeRun(()=>invoke('forward'));
  $('recoverBack').onclick=safeRun(()=>invoke('back'));
  $('reload').onclick=safeRun(()=>invoke(state.tabs.find(t=>t.id===state.selectedId)?.loading?'stop':'reload'));
  $('navigation').onsubmit=event=>{event.preventDefault();safeRun(()=>invoke(state?.selectedId?'navigate':'open',{url:$('address').value.trim()}))();};
  $('detail').onclick=safeRun(()=>read('read-detail'));$('list').onclick=safeRun(()=>read('collect-page'));
  $('models').onchange=updateClassify;
  $('newTab').onclick=safeRun(()=>invoke('open',{site:$('sitePicker').value}));
  $('classify').onclick=safeRun(async()=>{
    modelBusy=true;updateClassify();
    try{const {result}=await invoke('classify',{modelId:$('models').value});const labels={include:'纳入',exclude:'非目标',review:'待复核'};$('classification').textContent=`${labels[result.decision]||result.decision} · ${result.role}\n语义相似度 ${result.score===null?'未计算':Number(result.score).toFixed(3)}${result.winner?' · 最近参照：'+result.winner:''}\n${result.reason}\n相似度不是简历匹配度或录用概率。`;}finally{modelBusy=false;updateClassify();}
  });
  api.onState(render);
  safeRun(async()=>{render(await invoke('state'));state.sites.forEach(site=>{const button=document.createElement('button');button.textContent=site.name;button.onclick=safeRun(()=>invoke('open',{site:site.id}));$('sites').append(button);$('sitePicker').append(new Option(site.name,site.id));});await loadModels();})();
})();
