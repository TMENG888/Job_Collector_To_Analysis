import {confirmAction} from './confirmation-dialog.js?v=20261112-clear-prompts';
const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const statuses={queued:'待启动',drafting:'扩展检索词',retrieving:'全库选样',labeling:'Qwen标注',training:'训练与评测',completed:'已通过验收',rejected:'未通过验收',needs_samples:'待补样',failed:'执行失败',cancelled:'已取消',cancelling:'停止中',interrupted:'服务中断',invalid:'模型不可用'};
const running=['drafting','retrieving','labeling','training','cancelling'];
export function renderTrainingProgress(job,{run=null,error='',pending=false}={}){
  if(!job||job.status==='completed')return '';
  if(run?.id!==job.runId)run=null;
  if(run&&['failed','interrupted','cancelled','needs_samples','completed'].includes(run.status))job={...job,status:run.status==='completed'?(run.eligible?'completed':'rejected'):run.status,message:run.message};
  if(job.status==='completed')return '';
  const number=value=>Number(value||0).toLocaleString('zh-CN'),busy=running.includes(job.status);
  const steps=[['drafting','扩展检索词'],['retrieving','全库选样'],['labeling','Qwen 标注'],['training','训练与评测']],stage=steps.findIndex(([key])=>key===job.status);
  const sampled=Number(run?.sampled||run?.requestedSamples||job.sampleCount||0),labeled=Number(run?.labeled||0),processed=labeled+Number(run?.skipped||0),percent=sampled?Math.min(100,Math.round(processed/sampled*100)):0;
  const cost=Number(job.schemaEstimate||0)+Number(run?.costEstimate??job.labelEstimate??0);
  const updated=run?.updatedAt||job.updatedAt,time=updated?new Date(updated).toLocaleTimeString('zh-CN',{hour12:false}):'—';
  return `<div class="training-live-head"><strong>${escape(job.role)} · ${escape(statuses[job.status]||job.status)}</strong><span>状态更新 ${escape(time)}</span></div><ol class="training-live-steps">${steps.map(([key,title],index)=>`<li data-state="${index===stage?'current':stage>index||job.status==='completed'||job.status==='rejected'?'done':'pending'}"${index===stage?' aria-current="step"':''}>${escape(title)}</li>`).join('')}</ol>${run?`<div class="training-live-labels"><span>已标注 <strong>${number(labeled)} / ${number(sampled)}</strong></span><span>${percent}% · 处理进度</span></div><progress max="${sampled||1}" value="${Math.min(processed,sampled)}" aria-label="Qwen 标注进度"></progress><div class="training-live-counts"><span>正例 <strong>${number(run.positive)}</strong></span><span>负例 <strong>${number(run.negative)}</strong></span><span>待核 <strong>${number(run.review)}</strong></span><span>并发 <strong>${number(run.effectiveConcurrency||run.requestConcurrency||1)}</strong> 路</span><span>重试 <strong>${number(run.retryRequests)}</strong> 次 · 跳过 <strong>${number(run.skipped)}</strong> 条</span><span>输入 ${number(Number(job.schemaUsage?.input||0)+Number(run?.promptTokens??job.labelUsage?.input??0))} / 输出 ${number(Number(job.schemaUsage?.output||0)+Number(run?.completionTokens??job.labelUsage?.output??0))} Token · 估算 ¥${cost.toFixed(4)}（非账单）${run?.unknownUsageRequests?' · 部分用量待核':''}</span></div>`:`<p>${escape(job.message||'正在读取执行状态…')}</p>${job.library?`<p>全库扫描 ${number(job.library.scannedRows)} 条 · 目标候选 ${number(job.library.targetHits)} 条</p>`:''}`}${job.status==='training'?'<p>标注完成，正在训练</p>':''}${!busy?`<p>${escape(job.message)}</p>`:''}${error?`<p class="training-live-error" role="alert">${escape(error)}；保留上次进度，5 秒后重新读取。</p>`:''}<div class="training-live-footer">${busy?`<button type="button" class="ghost" data-training-cancel="${escape(job.id)}"${pending?' disabled':''}>停止本轮</button>`:run?.resumable?`<button type="button" class="secondary" data-training-resume="${escape(job.id)}"${pending?' disabled':''}>继续本轮</button>`:''}</div>`;
}
export function renderRoleOptions(catalog){
  const ready=catalog.roles.filter(r=>r.status==='ready');
  return '<option value="">选择目标岗位</option>'+ready.map(r=>`<option value="${escape(r.role)}">${escape(r.role)}</option>`).join('');
}
export function renderClassifierManager(catalog,{pending=false,busy=false,selectable=false,selectedRole=''}={}){
  const roles=catalog.roles.filter(item=>item.status==='ready');
  return roles.length?'<ul class="classifier-manage-list">'+roles.map(item=>{
    const ready=item.status==='ready',selected=ready&&item.role===selectedRole;
    const label=`<strong>${escape(item.role)}${selected?'<span class="classifier-choice-status">当前</span>':''}</strong>`;
    return `<li${selected?' data-selected="true"':''}>${selectable&&ready?`<button type="button" class="classifier-option" data-classifier-select="${escape(item.role)}" aria-label="选择${escape(item.role)}分类器" aria-pressed="${selected}"${pending?' disabled':''}>${label}</button>`:`<div class="classifier-option-label">${label}</div>`}<button type="button" class="ghost classifier-option-delete" data-classifier-delete="${escape(item.role)}" aria-label="删除${escape(item.role)}分类器" ${pending||busy||running.includes(item.status)?'disabled':''}>删除</button></li>`;
  }).join('')+'</ul>':'<p class="classifier-muted">暂无分类器，可通过“新增岗位”训练。</p>';
}
export function renderTrainingJobs(jobs,{pending=false,busy=false,supported=true}={}){
  return jobs.length?`<ul class="training-jobs">${jobs.map(j=>`<li class="training-job" data-status="${escape(j.status)}"><div><strong>${escape(j.role)}</strong><small>${escape(j.label)}</small></div><div class="training-job-progress"><strong>${escape(statuses[j.status]||j.status)}</strong><small>${escape(j.message)}</small>${j.library?`<small>全库扫描 ${Number(j.library.scannedRows).toLocaleString('zh-CN')} 条 · 命中 ${Number(j.library.targetHits).toLocaleString('zh-CN')} 条候选</small>`:''}${j.retrieval?`<details><summary>扩展检索词</summary><p>${escape([...j.retrieval.title_keywords,...j.retrieval.duty_keywords,...(j.retrieval.skill_keywords||[]),...(j.retrieval.business_keywords||[])].join('、'))}</p></details>`:''}</div><div class="training-job-actions"><button type="button" class="ghost" data-training-view="${escape(j.id)}">查看</button>${j.runId&&['failed','interrupted','cancelled'].includes(j.status)?`<button type="button" class="ghost" data-training-resume="${escape(j.id)}" title="复用已保存标签，从原轮次断点继续" ${pending||busy?'disabled':''}>继续本轮</button>`:''}${j.status==='queued'||running.includes(j.status)?`<details class="training-job-menu"><summary>更多</summary><div>${j.status==='queued'?`<button type="button" class="ghost" data-training-start="${escape(j.id)}" ${pending||busy||!supported?'disabled':''}>${j.inputFile==='kb://all'?'启动训练':'按全库训练'}</button>`:''}<button type="button" class="ghost" data-training-cancel="${escape(j.id)}" ${pending?'disabled':''}>${j.status==='queued'?'取消任务':'停止训练'}</button></div></details>`:''}</div></li>`).join('')}</ul>`:'<p class="classifier-muted">还没有训练记录。</p>';
}
export function installInsightTrainingQueue({api,toast}){
  const root=document.querySelector('#insightTrainingQueue'),picker=document.querySelector('#insightRole');if(!root||!picker)return;
  root.innerHTML=`<p class="workflow-service-warning" data-workflow-warning role="status" hidden></p><details class="training-panel" data-training-panel><summary>新增或更新分类器 <span data-training-panel-status hidden></span></summary><div class="training-panel-body"><form data-training-form><div class="training-entry"><label>岗位名称<input data-training-keywords type="text" required minlength="2" maxlength="240" placeholder="例如：爬虫工程师"></label><button type="submit" class="secondary" data-training-create>确认并训练</button></div></form><p class="classifier-muted training-notice" data-training-notice role="status" aria-live="polite" hidden></p></div></details><p class="classifier-muted" data-training-usage role="status" hidden></p><div class="workflow-secondary-tools"><div data-discovery-slot></div></div>`;
  root.querySelector('[data-training-panel]').insertAdjacentHTML('afterend','<section class="training-live" data-training-live aria-label="当前分类器训练进度" aria-live="polite" hidden></section>');
  const pickerMenu=document.querySelector('[data-classifier-picker]'),pickerList=document.querySelector('[data-classifier-picker-list]');
  const $=s=>root.querySelector(s),refreshButton=document.querySelector('[data-workflow-refresh]');
  let state={jobs:[]},catalog={roles:[]},loading=false,pending=false,signature='',error='',loaded=false,suggested='';
  let progressJobId='',progressRun=null,progressError='';
  function suggestName(){const input=$('[data-training-keywords]');if(!input.value||input.value===suggested){input.value=picker.value;suggested=picker.value;}}
  function render(){
    const supported=state.workflow==='keyword-training-v1';
    $('[data-training-create]').disabled=pending||state.busy||!supported;
    $('[data-training-create]').textContent=pending?'正在提交…':state.busy?'训练中…':'确认并训练';
    $('[data-training-keywords]').disabled=pending||state.busy;if(refreshButton)refreshButton.disabled=loading||pending;
    const active=state.jobs.find(j=>running.includes(j.status));
    const progressJob=active||state.jobs.find(j=>j.id===progressJobId),live=$('[data-training-live]');
    const progressHtml=renderTrainingProgress(progressJob,{run:progressRun,error:progressError||error,pending});live.hidden=!progressHtml;
    if(live.innerHTML!==progressHtml)live.innerHTML=progressHtml;
    const latest=state.jobs.find(j=>j.schemaUsage||j.labelUsage),usage=$('[data-training-usage]');
    usage.hidden=!latest||!!active;
    usage.textContent=latest?`${latest.role} · 输入 ${Number((latest.schemaUsage?.input||0)+(latest.labelUsage?.input||0)).toLocaleString()} / 输出 ${Number((latest.schemaUsage?.output||0)+(latest.labelUsage?.output||0)).toLocaleString()} Token · 估算 ¥${Number((latest.schemaEstimate||0)+(latest.labelEstimate||0)).toFixed(4)}（非账单）${latest.labelUsage?.unknown?' · 部分用量待核':''}`:'';
    $('[data-training-notice]').textContent=error;$('[data-training-notice]').hidden=!error;
    $('[data-training-panel-status]').textContent=active?active.role+' · '+(statuses[active.status]||active.status):'';
    $('[data-training-panel-status]').hidden=!active;
    const warning=$('[data-workflow-warning]');warning.textContent=loaded&&!supported?'后台仍为旧版，新岗位训练与方向发现暂不可用；重启8788后台后刷新。已有分类器可照常分析。':'';warning.hidden=!warning.textContent;
    $('[data-discovery-slot]').dataset.workflowSupported=String(supported);
    document.dispatchEvent(new CustomEvent('insight-training-capability',{detail:{supported,loaded}}));
    const next=renderRoleOptions(catalog);
    if(next!==signature){const previous=picker.value;picker.innerHTML=next;picker.value=catalog.roles.some(r=>r.role===previous&&r.status==='ready')?previous:'';signature=next;if(previous!==picker.value)picker.dispatchEvent(new Event('change',{bubbles:true}));suggestName();}
    const pickerHtml=renderClassifierManager(catalog,{pending,busy:state.busy,selectable:true,selectedRole:picker.value});
    if(pickerList.innerHTML!==pickerHtml)pickerList.innerHTML=pickerHtml;
    document.querySelector('#classifierPickerValue').textContent=picker.value||'选择目标岗位';
    pickerMenu.setAttribute('aria-busy',String(pending));
    const status=document.querySelector('#insightRoleCatalogStatus');if(status)status.textContent=error||`${catalog.readyCount||0} 个可用分类器`;
    root.setAttribute('aria-busy',String(pending));
  }
  async function refresh(){
    if(loading)return;loading=true;
    try{
      const [catalogResult,queueResult]=await Promise.allSettled([api('/api/insights/classifiers'),api('/api/insights/training')]);
      if(queueResult.status==='rejected')throw queueResult.reason;
      state=queueResult.value;loaded=true;error='';
      if(catalogResult.status==='fulfilled')catalog=catalogResult.value;
      else error='分类器目录读取失败：'+catalogResult.reason.message;
      const active=state.jobs.find(j=>running.includes(j.status));
      const observed=active||(!progressJobId?state.jobs.find(j=>j.runId&&j.status!=='queued'):null);
      if(observed&&observed.id!==progressJobId){progressJobId=observed.id;progressRun=null;progressError='';}
      render();
      const job=active||state.jobs.find(j=>j.id===progressJobId);
      if(job?.runId&&job.status!=='completed'){
        try{
          const result=await api('/api/insights/classifier?inputFile='+encodeURIComponent(job.inputFile)+'&role='+encodeURIComponent(job.role));
          if(result.run?.id!==job.runId)throw Error('后台返回的训练记录与当前任务不一致');
          progressRun=result.run;progressError='';
        }catch(e){progressError='进度刷新失败：'+e.message;}
        render();
      }
    }catch(e){error='读取失败：'+e.message;render();}
    finally{loading=false;if(refreshButton)refreshButton.disabled=pending;}
  }
  async function action(fn){if(pending)return;const focusedRole=document.activeElement?.dataset.classifierDelete;pending=true;error='';render();try{await fn();await refresh();}catch(e){error=e.message;toast(e.message,true);}finally{pending=false;render();if(focusedRole){const button=[...pickerList.querySelectorAll('[data-classifier-delete]')].find(item=>item.dataset.classifierDelete===focusedRole);(button||pickerMenu.querySelector('summary')).focus();}}}
  function params(){return {sampleCount:500};}
  function selectJob(job){
    if(job&&catalog.roles.some(r=>r.role===job.role&&r.status==='ready')){picker.value=job.role;picker.dispatchEvent(new Event('change',{bubbles:true}));}
  }
  async function start(job,p){if(state.workflow!=='keyword-training-v1')throw Error('后台尚未加载新版训练流程，请先重启后台');await api('/api/insights/training/start',{method:'POST',body:JSON.stringify({id:job.id,confirmed:true,...p})});await refresh();toast('已启动全库选样与分类器训练');}
  async function createAndStart(keywords,p){if(state.workflow!=='keyword-training-v1')throw Error('后台尚未加载新版训练流程，请先重启后台');const {job}=await api('/api/insights/training/create',{method:'POST',body:JSON.stringify({taskId:'all',keywords})});if(job.status!=='queued')throw Error('该任务正在运行，请查看当前训练进度');await start(job,p);}
  $('[data-training-form]').addEventListener('submit',event=>{event.preventDefault();void action(async()=>{
    const keywords=$('[data-training-keywords]').value.trim(),p=params();if(keywords.length<2||keywords.length>240)throw Error('请输入2–240字的岗位名称');
    await createAndStart(keywords,p);
  });});
  document.querySelector('#insightWorkflow').addEventListener('click',event=>{
    const target=event.target.closest('button');if(!target)return;
    if(target.dataset.classifierSelect){picker.value=target.dataset.classifierSelect;picker.dispatchEvent(new Event('change',{bubbles:true}));pickerMenu.open=false;pickerMenu.querySelector('summary').focus();return;}
    if(target.dataset.classifierDelete)return void action(async()=>{
      const role=target.dataset.classifierDelete;
      if(!await confirmAction('删除'+role+'分类器',`确定删除“${role}”分类器吗？`))return;
      const result=await api('/api/insights/classifiers/delete',{method:'POST',body:JSON.stringify({role,confirmed:true})});toast(result.message||'分类器已删除');
      document.dispatchEvent(new Event('insight-classifier-updated'));
    });
    if(target.dataset.trainingView){selectJob(state.jobs.find(j=>j.id===target.dataset.trainingView));document.querySelector('.classifier-result-details')?.setAttribute('open','');return;}
    if(target.dataset.trainingStart)return void action(async()=>{const job=state.jobs.find(j=>j.id===target.dataset.trainingStart),p=params();if(job){if(job.inputFile==='kb://all')await start(job,p);else await createAndStart(job.keywords||job.role,p);}});
    if(target.dataset.trainingResume)return void action(async()=>{const result=await api('/api/insights/training/resume',{method:'POST',body:JSON.stringify({id:target.dataset.trainingResume,confirmed:true})});progressJobId=result.job.id;progressRun=null;toast('已从断点继续');});
    if(target.dataset.trainingCancel)return void action(()=>api('/api/insights/training/cancel',{method:'POST',body:JSON.stringify({id:target.dataset.trainingCancel})}));
  });
  picker.addEventListener('change',()=>{suggestName();render();});
  document.addEventListener('click',event=>{if(!event.composedPath().includes(pickerMenu))pickerMenu.open=false;});
  pickerMenu.addEventListener('keydown',event=>{if(event.key==='Escape'){pickerMenu.open=false;pickerMenu.querySelector('summary').focus();event.preventDefault();}});
  document.querySelector('[data-open-training]')?.addEventListener('click',()=>{$('[data-training-panel]').open=true;$('[data-training-keywords]').focus();});
  refreshButton?.addEventListener('click',()=>document.dispatchEvent(new Event('insight-workflow-refresh')));
  document.addEventListener('insight-workflow-refresh',()=>void refresh());
  document.addEventListener('job-workspace-view',event=>{if(event.detail.view==='insights')void refresh();});
  setInterval(()=>{if(!document.hidden&&!document.querySelector('#insightsView')?.classList.contains('hidden'))void refresh();},5000);
  void refresh();return {refresh};
}
