const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const statuses={queued:'待启动',drafting:'扩展检索词',retrieving:'全库选样',labeling:'Qwen标注',training:'训练与评测',completed:'已通过验收',rejected:'未通过验收',needs_samples:'待补样',failed:'执行失败',cancelled:'已取消',cancelling:'停止中',interrupted:'服务中断',invalid:'模型不可用'};
const running=['drafting','retrieving','labeling','training','cancelling'];
export function renderTrainingProgress(job,{run=null,error='',pending=false}={}){
  if(!job)return '';
  if(run?.id!==job.runId)run=null;
  const number=value=>Number(value||0).toLocaleString('zh-CN'),busy=running.includes(job.status);
  const steps=[['drafting','扩展检索词'],['retrieving','全库选样'],['labeling','Qwen 标注'],['training','训练与评测']],stage=steps.findIndex(([key])=>key===job.status);
  const sampled=Number(run?.sampled||run?.requestedSamples||job.sampleCount||0),labeled=Number(run?.labeled||0),percent=sampled?Math.min(100,Math.round(labeled/sampled*100)):0;
  const totalBudget=Number(job.schemaBudget||0)+Number(job.labelBudget||0),cost=Number(job.schemaEstimate||0)+Number(run?.costEstimate??job.labelEstimate??0);
  const updated=run?.updatedAt||job.updatedAt,time=updated?new Date(updated).toLocaleTimeString('zh-CN',{hour12:false}):'—';
  return `<div class="training-live-head"><strong>${escape(job.role)} · ${escape(statuses[job.status]||job.status)}</strong><span>状态更新 ${escape(time)}</span></div><ol class="training-live-steps">${steps.map(([key,title],index)=>`<li data-state="${index===stage?'current':stage>index||job.status==='completed'||job.status==='rejected'?'done':'pending'}"${index===stage?' aria-current="step"':''}>${escape(title)}</li>`).join('')}</ol>${run?`<div class="training-live-labels"><span>已标注 <strong>${number(labeled)} / ${number(sampled)}</strong></span><span>${percent}% · 标注进度</span></div><progress max="${sampled||1}" value="${Math.min(labeled,sampled)}" aria-label="Qwen 标注进度"></progress><div class="training-live-counts"><span>正例 <strong>${number(run.positive)}</strong></span><span>负例 <strong>${number(run.negative)}</strong></span><span>待核 <strong>${number(run.review)}</strong></span><span>估算 ¥${cost.toFixed(4)} / ¥${totalBudget.toFixed(2)}</span></div>`:`<p>${escape(job.message||'正在读取执行状态…')}</p>${job.library?`<p>全库扫描 ${number(job.library.scannedRows)} 条 · 目标候选 ${number(job.library.targetHits)} 条</p>`:''}`}${job.status==='training'?'<p>标注已完成，正在本机训练与隔离评测。</p>':''}${!busy?`<p>${escape(job.message)}</p>`:''}${error?`<p class="training-live-error" role="alert">${escape(error)}；保留上次进度，5 秒后重新读取。</p>`:''}<div class="training-live-footer"><small>${busy?'每 5 秒刷新；100% 仅代表标注完成。':'本轮已结束；结果见训练记录。'} 费用为估算，非账单。</small>${busy?`<button type="button" class="ghost" data-training-cancel="${escape(job.id)}"${pending?' disabled':''}>停止本轮</button>`:''}</div>`;
}
export function renderRoleOptions(catalog){
  const ready=catalog.roles.filter(r=>r.status==='ready');
  return '<option value="">选择目标岗位</option>'+ready.map(r=>`<option value="${escape(r.role)}">${escape(r.role)}</option>`).join('');
}
export function renderClassifierManager(catalog,{pending=false,busy=false}={}){
  return catalog.roles.length?'<ul class="classifier-manage-list">'+catalog.roles.map(item=>`<li><div><strong>${escape(item.role)}</strong><small>${escape(item.status==='ready'?'可用':statuses[item.status]||'候选')} · ${escape(item.source==='bundled'?'内置模型':item.source==='trained'?'已训练模型':'训练候选')}${item.version?' · '+escape(item.version):''}</small></div><button type="button" class="ghost" data-classifier-delete="${escape(item.role)}" aria-label="删除${escape(item.role)}分类器" ${pending||busy||running.includes(item.status)?'disabled':''}>删除</button></li>`).join('')+'</ul>':'<p class="classifier-muted">暂无分类器，可通过“新增岗位”训练。</p>';
}
export function renderTrainingJobs(jobs,{pending=false,busy=false,supported=true}={}){
  return jobs.length?`<ul class="training-jobs">${jobs.map(j=>`<li class="training-job" data-status="${escape(j.status)}"><div><strong>${escape(j.role)}</strong><small>${escape(j.label)}</small></div><div class="training-job-progress"><strong>${escape(statuses[j.status]||j.status)}</strong><small>${escape(j.message)}</small>${j.library?`<small>全库扫描 ${Number(j.library.scannedRows).toLocaleString('zh-CN')} 条 · 命中 ${Number(j.library.targetHits).toLocaleString('zh-CN')} 条候选</small>`:''}${j.retrieval?`<details><summary>扩展检索词</summary><p>${escape([...j.retrieval.title_keywords,...j.retrieval.duty_keywords,...(j.retrieval.skill_keywords||[]),...(j.retrieval.business_keywords||[])].join('、'))}</p></details>`:''}</div><div class="training-job-actions"><button type="button" class="ghost" data-training-view="${escape(j.id)}">查看</button>${j.status==='queued'||running.includes(j.status)?`<details class="training-job-menu"><summary>更多</summary><div>${j.status==='queued'?`<button type="button" class="ghost" data-training-start="${escape(j.id)}" ${pending||busy||!supported?'disabled':''}>${j.inputFile==='kb://all'?'启动训练':'按全库训练'}</button>`:''}<button type="button" class="ghost" data-training-cancel="${escape(j.id)}" ${pending?'disabled':''}>${j.status==='queued'?'取消任务':'停止训练'}</button></div></details>`:''}</div></li>`).join('')}</ul>`:'<p class="classifier-muted">还没有训练记录。</p>';
}
export function installInsightTrainingQueue({api,toast}){
  const root=document.querySelector('#insightTrainingQueue'),picker=document.querySelector('#insightRole');if(!root||!picker)return;
  root.innerHTML=`<p class="workflow-service-warning" data-workflow-warning role="status" hidden></p><details class="training-panel" data-training-panel><summary>新增或更新分类器 <span data-training-panel-status>输入岗位名称，自动扩词并选样训练</span></summary><div class="training-panel-body"><form data-training-form><div class="training-entry"><label>岗位名称<input data-training-keywords type="text" required minlength="2" maxlength="240" placeholder="例如：爬虫工程师" aria-describedby="trainingKeywordHint"></label><button type="submit" class="secondary" data-training-create>确认并训练</button></div><p id="trainingKeywordHint" class="classifier-muted">DeepSeek 扩词 → 全库初筛 → Qwen 打标 → 本机训练；规则命中仅作为候选。</p><details class="training-settings"><summary>抽样与预算 <span data-training-budget-summary>最多400条 · 上限¥2.00</span></summary><div class="classifier-controls"><label>抽样条数<input data-training-count type="number" min="120" max="2000" value="400" required></label><label>DeepSeek预算（元）<input data-training-schema type="number" min="0.05" max="0.5" step="0.05" value="0.1" required></label><label>Qwen预算（元）<input data-training-budget type="number" min="0.01" max="20" step="0.01" value="1.9" required></label></div></details></form><p class="classifier-muted training-notice" data-training-notice role="status" aria-live="polite" hidden></p></div></details><div class="workflow-secondary-tools"><div data-discovery-slot></div><details class="training-history"><summary>训练记录 <span data-training-record-count></span></summary><div data-training-list></div><div class="training-pagination"><button type="button" class="ghost" data-training-prev>上一页</button><span data-training-page></span><button type="button" class="ghost" data-training-next>下一页</button></div></details></div>`;
  root.querySelector('.workflow-secondary-tools').insertAdjacentHTML('beforeend','<details class="classifier-manager"><summary>管理分类器 <span data-classifier-manager-count></span></summary><p class="classifier-muted">删除后该方向需重新训练。原始岗位和模型文件归档保留。</p><p class="training-notice" data-classifier-manager-notice role="status" aria-live="polite" hidden></p><div data-classifier-manager-list></div></details>');
  root.querySelector('[data-training-panel]').insertAdjacentHTML('afterend','<section class="training-live" data-training-live aria-label="当前分类器训练进度" aria-live="polite" hidden></section>');
  const $=s=>root.querySelector(s),refreshButton=document.querySelector('[data-workflow-refresh]');
  let state={jobs:[]},catalog={roles:[]},page=0,loading=false,pending=false,signature='',error='',loaded=false,suggested='';
  let progressJobId='',progressRun=null,progressError='';
  function suggestName(){const input=$('[data-training-keywords]');if(!input.value||input.value===suggested){input.value=picker.value;suggested=picker.value;}}
  function render(){
    const supported=state.workflow==='keyword-training-v1';
    $('[data-training-create]').disabled=pending||state.busy||!supported;
    $('[data-training-create]').textContent=pending?'正在提交…':state.busy?'训练中…':'确认并训练';
    $('[data-training-keywords]').disabled=pending||state.busy;if(refreshButton)refreshButton.disabled=loading||pending;
    const total=Math.max(1,Math.ceil(state.jobs.length/6));page=Math.min(page,total-1);
    $('[data-training-prev]').disabled=page===0;$('[data-training-next]').disabled=page>=total-1;
    $('.training-pagination').hidden=state.jobs.length<=6;$('[data-training-page]').textContent=`${page+1}/${total} 页`;
    $('[data-training-record-count]').textContent=state.jobs.length?'（'+state.jobs.length+'）':'';
    const active=state.jobs.find(j=>running.includes(j.status));
    const progressJob=active||state.jobs.find(j=>j.id===progressJobId),live=$('[data-training-live]');
    live.hidden=!progressJob;
    const progressHtml=renderTrainingProgress(progressJob,{run:progressRun,error:progressError||error,pending});
    if(live.innerHTML!==progressHtml)live.innerHTML=progressHtml;
    $('[data-training-notice]').textContent=error||(active?active.role+'：'+active.message:'');$('[data-training-notice]').hidden=!$('[data-training-notice]').textContent;
    $('[data-training-panel-status]').textContent=active?active.role+' · '+(statuses[active.status]||active.status):'输入岗位名称，自动扩词并选样训练';
    const warning=$('[data-workflow-warning]');warning.textContent=loaded&&!supported?'后台仍为旧版，新岗位训练与方向发现暂不可用；重启8788后台后刷新。已有分类器可照常分析。':'';warning.hidden=!warning.textContent;
    $('[data-discovery-slot]').dataset.workflowSupported=String(supported);
    document.dispatchEvent(new CustomEvent('insight-training-capability',{detail:{supported,loaded}}));
    const html=renderTrainingJobs(state.jobs.slice(page*6,page*6+6),{pending,busy:state.busy,supported});
    if($('[data-training-list]').innerHTML!==html)$('[data-training-list]').innerHTML=html;
    const next=renderRoleOptions(catalog);
    if(next!==signature){const previous=picker.value;picker.innerHTML=next;picker.value=catalog.roles.some(r=>r.role===previous&&r.status==='ready')?previous:'';signature=next;if(previous!==picker.value)picker.dispatchEvent(new Event('change',{bubbles:true}));suggestName();}
    const manager=$('[data-classifier-manager-list]'),managerHtml=renderClassifierManager(catalog,{pending,busy:state.busy});if(manager.innerHTML!==managerHtml)manager.innerHTML=managerHtml;
    $('[data-classifier-manager-count]').textContent=`（${catalog.roles.length}）`;
    $('[data-classifier-manager-notice]').textContent=error;$('[data-classifier-manager-notice]').hidden=!error;
    const status=document.querySelector('#insightRoleCatalogStatus');if(status)status.textContent=`可用 ${catalog.readyCount||0} 类 · 没有目标岗位？点击“新增岗位”`;
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
      if(job?.runId){
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
  async function action(fn){if(pending)return;pending=true;error='';render();try{await fn();await refresh();}catch(e){error=e.message;toast(e.message,true);}finally{pending=false;render();}}
  function params(){
    const sampleCount=Number($('[data-training-count]').value),schemaBudget=Number($('[data-training-schema]').value),labelBudget=Number($('[data-training-budget]').value);
    if(!Number.isInteger(sampleCount)||sampleCount<120||sampleCount>2000||!Number.isFinite(schemaBudget)||schemaBudget<.05||schemaBudget>.5||!Number.isFinite(labelBudget)||labelBudget<=0||labelBudget>20)throw Error('抽样须为120–2000条，DeepSeek预算0.05–0.50元，Qwen预算大于0且不超过20元');
    return {sampleCount,schemaBudget,labelBudget};
  }
  function confirmTraining(p,keywords){return window.confirm(`目标：${keywords}\nDeepSeek扩展职称、技术检索词及分类边界，校验后从全岗位库选样；Qwen标注最多${p.sampleCount}条脱敏公开JD，再本机训练与隔离评测。\nDeepSeek上限¥${p.schemaBudget.toFixed(2)}，Qwen上限¥${p.labelBudget.toFixed(2)}，合计¥${(p.schemaBudget+p.labelBudget).toFixed(2)}（估算非账单）。不发送简历，不自动付费重试；未达标不替换合格模型。继续？`);}
  function selectJob(job){
    if(job){picker.value=catalog.roles.some(r=>r.role===job.role)?job.role:'';picker.dispatchEvent(new Event('change',{bubbles:true}));}
  }
  async function start(job,p){if(state.workflow!=='keyword-training-v1')throw Error('后台尚未加载新版训练流程，请先重启后台');await api('/api/insights/training/start',{method:'POST',body:JSON.stringify({id:job.id,confirmed:true,...p})});await refresh();selectJob(job);$('.training-history').open=true;toast('已启动全库选样与分类器训练');}
  async function createAndStart(keywords,p){if(state.workflow!=='keyword-training-v1')throw Error('后台尚未加载新版训练流程，请先重启后台');const {job}=await api('/api/insights/training/create',{method:'POST',body:JSON.stringify({taskId:'all',keywords})});if(job.status!=='queued')throw Error('该任务正在运行，请查看训练记录');await start(job,p);}
  $('[data-training-form]').addEventListener('submit',event=>{event.preventDefault();void action(async()=>{
    const keywords=$('[data-training-keywords]').value.trim(),p=params();if(keywords.length<2||keywords.length>240)throw Error('请输入2–240字的岗位名称');
    if(!confirmTraining(p,keywords))return;await createAndStart(keywords,p);
  });});
  $('[data-training-form]').addEventListener('input',()=>{const count=Number($('[data-training-count]').value),budget=Number($('[data-training-schema]').value)+Number($('[data-training-budget]').value);$('[data-training-budget-summary]').textContent=`最多${count||0}条 · 上限¥${Number.isFinite(budget)?budget.toFixed(2):'—'}`;});
  root.addEventListener('click',event=>{
    const target=event.target.closest('button');if(!target)return;
    if(target.dataset.classifierDelete)return void action(async()=>{
      const role=target.dataset.classifierDelete;
      if(!window.confirm(`删除“${role}”的分类器？\n该方向现有模型和旧训练记录将从可用目录移除，后续分析需要重新训练。\n原始岗位、已生成报告、标注及模型文件归档保留；不会产生模型费用。`))return;
      const result=await api('/api/insights/classifiers/delete',{method:'POST',body:JSON.stringify({role,confirmed:true})});toast(result.message||'分类器已删除');
      document.dispatchEvent(new Event('insight-classifier-updated'));
    });
    if(target.hasAttribute('data-training-prev')){page--;render();return;}if(target.hasAttribute('data-training-next')){page++;render();return;}
    if(target.dataset.trainingView){selectJob(state.jobs.find(j=>j.id===target.dataset.trainingView));document.querySelector('.classifier-result-details')?.setAttribute('open','');return;}
    if(target.dataset.trainingStart)return void action(async()=>{const job=state.jobs.find(j=>j.id===target.dataset.trainingStart),p=params();if(job&&confirmTraining(p,job.keywords||job.role)){if(job.inputFile==='kb://all')await start(job,p);else await createAndStart(job.keywords||job.role,p);}});
    if(target.dataset.trainingCancel)return void action(()=>api('/api/insights/training/cancel',{method:'POST',body:JSON.stringify({id:target.dataset.trainingCancel})}));
  });
  picker.addEventListener('change',suggestName);
  document.querySelector('[data-open-training]')?.addEventListener('click',()=>{$('[data-training-panel]').open=true;$('[data-training-keywords]').focus();});
  refreshButton?.addEventListener('click',()=>document.dispatchEvent(new Event('insight-workflow-refresh')));
  document.addEventListener('insight-workflow-refresh',()=>void refresh());
  document.addEventListener('job-workspace-view',event=>{if(event.detail.view==='insights')void refresh();});
  setInterval(()=>{if(!document.hidden&&!document.querySelector('#insightsView')?.classList.contains('hidden'))void refresh();},5000);
  void refresh();return {refresh};
}
