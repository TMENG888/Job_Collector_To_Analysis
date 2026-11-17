(() => {
  const api=window.jobDesktop,$=id=>document.getElementById(id);
  let state=null;
  const invoke=async(name,value={})=>{try{return await api.command(name,value);}catch(error){$('status').textContent=error.message;throw error;}};
  const safeRun=fn=>()=>{Promise.resolve().then(fn).catch(()=>{});};
  function render(next){
    state=next;
    $('workspaceRecovery').hidden=state.workspaceStatus!=='error';
    $('workspaceError').textContent=state.workspaceError||'';
    document.querySelectorAll('[data-route]').forEach(button=>button.classList.toggle('active',button.dataset.route===state.workspaceRoute));
    $('status').textContent=state.workspaceStatus==='ready'?`本地工作台 · ${Math.round((state.zoomFactor||1)*100)}%`:state.workspaceError||'正在加载本地页面…';
  }
  document.querySelectorAll('[data-route]').forEach(button=>button.onclick=safeRun(()=>invoke('workspace',{route:button.dataset.route})));
  $('workspaceRetry').onclick=safeRun(()=>invoke('workspace',{route:state?.workspaceRoute||'insights',retry:true}));
  api.onState(render);
  safeRun(async()=>render(await invoke('state')))();
})();
