const names={preparing:'隔离样本',labeling:'Qwen标注中',training:'训练与评测',completed:'本轮完成',failed:'本轮未完成',cancelled:'已停止',interrupted:'已中断'};
let context=null,sequence=0,readSequence=0,timer=null,latest=null,posting=false,installed=false;
const dialog=()=>document.querySelector('#interviewClassifier');
const form=()=>document.querySelector('#interviewClassifierForm');
const errorNode=()=>document.querySelector('#interviewClassifierError');
const activeRun=()=>latest?.busy&&latest.busyTaskId===context?.taskId;
function controls(){
  const f=form();
  f.querySelector('[type="submit"]').disabled=posting||!latest||latest.busy||!latest.credentials.configured||!latest.benchmark.available||!f.elements.confirmed.checked;
  document.querySelector('#interviewClassifierCancel').disabled=posting||!activeRun();
  document.querySelector('#interviewClassifierPublish').disabled=posting||!latest?.run||latest.busy||!latest.run.sampled||latest.run.labeled!==latest.run.sampled||latest.publishedRun===latest.run.id;
  document.querySelector('#interviewClassifierActivate').disabled=posting||!latest?.run?.eligible||latest.busy||latest.activeModel?.id===latest.run.id;
}
function showError(message){errorNode().textContent=message;errorNode().hidden=false;}
function render(data){
  errorNode().hidden=true;errorNode().textContent='';
  latest=data;const {escapeHtml:e,number:n}=context,r=data.run;
  document.querySelector('#interviewClassifierScope').textContent=context.title+' · '+data.role;
  document.querySelector('#interviewClassifierCredential').textContent=data.credentials.configured?'复用岗位洞察 Qwen 密钥':'请先在岗位洞察配置 Qwen 密钥';
  const percent=value=>Number.isFinite(value)?(value*100).toFixed(1)+'%':'—';
  const metrics=(m,title)=>`<section><h4>${title}</h4><dl class="interview-classifier-metrics">${[['样本',m?.n??0],['准确率',percent(m?.accuracy)],['精确率',percent(m?.precision)],['召回率',percent(m?.recall)],['F1',percent(m?.f1)]].map(([label,value])=>`<div><dt>${label}</dt><dd>${value}</dd></div>`).join('')}</dl></section>`;
  const stats=r?`<div class="interview-classifier-facts"><span>已标注 <b>${n(r.labeled)} / ${n(r.sampled)}</b></span><span>目标 / 非目标 / 待核 <b>${n(r.positive)} / ${n(r.negative)} / ${n(r.review)}</b></span><span>输入 / 输出 Token <b>${n(r.promptTokens)} / ${n(r.completionTokens)}</b></span><span>估算费用 / 预算 <b>¥${r.costEstimate.toFixed(4)} / ¥${r.budget}</b></span></div>`:'';
  const evaluation=r?.evaluation;
  document.querySelector('#interviewClassifierResult').innerHTML=`<p class="interview-classifier-state" role="status">${r?e(names[r.status]||r.status):'尚未启动标注'}${data.busy&&!activeRun()?' · 其他任务运行中':''}</p><p>${e(r?.message||'仅处理已采集的公开面经，不启动采集。')}</p>${stats}${r?.unknownUsageRequests?`<p class="interview-error">${n(r.unknownUsageRequests)} 次请求用量不明，可能已计费；未自动重试。</p>`:''}${r?.referenceExcluded!=null?`<small>已隔离参考基准及同组材料 ${n(r.referenceExcluded)} 篇 · 可训练 ${n(r.available)} 篇</small>`:''}${r?.materialCounts?`<details class="interview-model"><summary>材料类型与技术标签</summary><p>面试自述 ${n(r.materialCounts.single_interview)} · 合集 ${n(r.materialCounts.interview_collection)} · 教程 ${n(r.materialCounts.reference_guide)} · 推广 ${n(r.materialCounts.promotion)} · 待核 ${n(r.materialCounts.uncertain)}；技术词 ${n(r.tagCount||0)} 条。</p></details>`:''}${evaluation?`<div class="interview-classifier-evaluation">${metrics(evaluation.validation,'Qwen 验证标签一致性')}${metrics(evaluation.test,'Codex 参考标签一致性')}</div><p class="interview-note">${e(evaluation.test_basis)}。阈值 ${evaluation.threshold}；${r.eligible?'通过验收，可手动启用':'未通过硬筛验收，不替换既有模型'}。</p>${evaluation.gate_reasons?.length?`<details class="interview-model"><summary>未通过原因</summary><ul>${evaluation.gate_reasons.map(reason=>`<li>${e(reason)}</li>`).join('')}</ul></details>`:''}`:''}`;
  document.querySelector('#interviewClassifierBenchmark').textContent=data.benchmark.available?`${data.benchmark.version} · ${data.benchmark.rows} 条原始参考记录；与训练及阈值选择隔离，去重后评测。不是人工金标准。`:data.benchmark.error;
  controls();
}
async function refresh(){
  const seq=sequence,readId=++readSequence,ctx=context;
  try{const result=await ctx.api('/api/interviews/classifier?taskId='+encodeURIComponent(ctx.taskId));if(seq!==sequence||readId!==readSequence||!dialog().open)return;render(result);if(result.busy)timer=setTimeout(refresh,3000);}
  catch(error){if(seq===sequence&&readId===readSequence&&dialog().open){showError(/404|接口不存在|Unexpected token/i.test(error.message)?'后台尚未加载面经标注接口，需要重启后台；本次未发起标注。':error.message);latest=null;document.querySelector('#interviewClassifierResult').textContent='后台连接失败，未启动标注。';document.querySelector('#interviewClassifierCredential').textContent='等待后台连接';document.querySelector('#interviewClassifierBenchmark').textContent='';controls();}}
}
async function post(action,payload){
  if(posting)return;
  posting=true;clearTimeout(timer);errorNode().hidden=true;controls();const seq=sequence,ctx=context;
  try{const result=await ctx.api('/api/interviews/classifier/'+action,{method:'POST',body:JSON.stringify({...payload,taskId:ctx.taskId})});if(seq!==sequence)return;if(result.message)ctx.toast(result.message);if(action==='start')form().elements.confirmed.checked=false;await refresh();}
  catch(error){if(seq===sequence)showError(error.message);}
  finally{posting=false;if(dialog().open)controls();}
}
export async function openInterviewClassifier(options){
  context=options;latest=null;sequence++;clearTimeout(timer);
  const d=dialog(),f=form();
  if(!installed){
    installed=true;
    d.addEventListener('close',()=>{if(!d.open){sequence++;clearTimeout(timer);}});
    d.addEventListener('cancel',event=>{if(posting)event.preventDefault();});
    d.querySelector('[data-classifier-close]').addEventListener('click',()=>{if(!posting)d.close();});
    f.elements.confirmed.addEventListener('change',controls);
    f.addEventListener('invalid',event=>{const details=event.target.closest('details');if(details)details.open=true;},true);
    f.addEventListener('submit',event=>{event.preventDefault();if(f.querySelector('[type="submit"]').disabled)return;void post('start',{sampleCount:Number(f.elements.sampleCount.value),budget:Number(f.elements.budget.value),inputPrice:Number(f.elements.inputPrice.value),outputPrice:Number(f.elements.outputPrice.value),confirmed:f.elements.confirmed.checked});});
    document.querySelector('#interviewClassifierRefresh').addEventListener('click',()=>{clearTimeout(timer);void refresh();});
    document.querySelector('#interviewClassifierCancel').addEventListener('click',()=>void post('cancel',{}));
    document.querySelector('#interviewClassifierPublish').addEventListener('click',()=>void post('publish-labels',{id:latest.run.id}));
    document.querySelector('#interviewClassifierActivate').addEventListener('click',()=>void post('activate',{id:latest.run.id}));
  }
  f.elements.confirmed.checked=false;errorNode().hidden=true;
  document.querySelector('#interviewClassifierResult').textContent='正在读取标注状态…';
  document.querySelector('#interviewClassifierScope').textContent=options.title;
  if(!d.open)d.showModal();d.scrollTop=0;controls();await refresh();
}
