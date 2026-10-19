// Optional model discovery never mutates an analysis report in place.
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const endpoint='/api/knowledge/skill-terms';
export function renderSkillTermCandidate(item){
  return `<article class="skill-term-candidate"><header><strong>${escape(item.term)}</strong><span>${escape(item.platform)} · ${escape(item.job_name)}</span></header><p>${escape(item.company)} · ${item.preferred?'优先／加分条件':'职责／任职要求'} · 模型分数 ${Number(item.score).toFixed(2)}（非准确率）</p><blockquote>${escape(item.quote)}</blockquote><small>岗位 ${escape(item.job_key)} · 正文版本 ${escape(item.content_hash?.slice(0,12))} · ${escape(item.model)}</small><div class="skill-term-actions">${item.state==='pending'?`<button type="button" class="secondary" data-term-id="${escape(item.id)}" data-term-decision="approved">批准此岗位的新词</button><button type="button" class="ghost" data-term-id="${escape(item.id)}" data-term-decision="rejected">拒绝</button>`:`<button type="button" class="ghost" data-term-id="${escape(item.id)}" data-term-decision="pending">${item.state==='approved'?'撤销批准，退回待审':'恢复待审'}</button>`}</div></article>`;
}
export function installSkillTermReview({api,toast}){
  const panel=document.querySelector('#skillTermReview');if(!panel)return;
  const notice=panel.querySelector('[data-term-notice]'),list=panel.querySelector('[data-term-list]'),status=panel.querySelector('[data-term-status]');
  const filter=panel.querySelector('[data-term-filter]'),scope=panel.querySelector('[data-term-scope]');
  let page=0,loading=false,working=false,generation=0;
  const fail=(error,source)=>{notice.textContent=error.message;notice.dataset.errorSource=source;};
  const recovered=source=>{if(notice.dataset.errorSource===source){notice.textContent='';delete notice.dataset.errorSource;}};
  const scopeId=()=>scope.value;
  async function scopes(){
    try{const data=await api('/api/knowledge/datasets');const previous=scope.value;scope.innerHTML='<option value="">全岗位知识库</option>'+data.datasets.map(d=>`<option value="${escape(d.taskId)}">${escape(d.role)}</option>`).join('');scope.value=[...scope.options].some(option=>option.value===previous)?previous:'';recovered('scopes');}catch(error){fail(error,'scopes');}
  }
  async function refresh(){
    if(loading||!panel.open)return;loading=true;const version=++generation;
    try{
      const query=new URLSearchParams({state:filter.value,taskId:scopeId(),offset:String(page*25),limit:'25'});
      const [data,scan]=await Promise.all([api(`${endpoint}?${query}`),api(`${endpoint}/status`)]);
      if(version!==generation)return;
      recovered('review');
      const run=scan.run;status.textContent=`待审 ${data.counts.pending||0} · 已批准 ${data.counts.approved||0} · 已拒绝 ${data.counts.rejected||0}`+(run?` ｜ 最近扫描：${({running:'运行中',completed:'完成',failed:'已停止',stopping:'等待旧进程退出',interrupted:'服务重启中断'})[run.status]||run.status} ${run.completed}/${run.total} 条岗位，新增 ${run.added} 个候选${run.message?'；'+run.message:''}`:'');
      panel.querySelector('[data-term-scan]').disabled=working||['running','stopping'].includes(run?.status)||!scan.model.available;
      if(!scan.model.available)notice.textContent='本机模型文件未安装完整；现有规则词云仍可正常使用。';
      const html=data.items.map(renderSkillTermCandidate).join('')||'<p>当前页没有候选；可扫描下一批，或切换审核状态。</p>';
      // Do not replace unchanged buttons while a reviewer is focused on them.
      if(list.dataset.html!==html){list.innerHTML=html;list.dataset.html=html;}
      panel.querySelector('[data-term-prev]').disabled=page===0;
      panel.querySelector('[data-term-next]').disabled=(page+1)*25>=(data.counts[filter.value]||0);
      panel.querySelector('[data-term-page]').textContent=`第 ${page+1} 页`;
    }catch(error){if(version===generation){fail(error,'review');if(!list.dataset.html)list.innerHTML='<p role="status">候选数据暂不可用</p>';}}finally{if(version===generation)loading=false;}
  }
  panel.addEventListener('toggle',()=>{if(panel.open){scopes();refresh();}});
  for(const select of [filter,scope])select.addEventListener('change',()=>{generation++;loading=false;page=0;refresh();});
  panel.addEventListener('click',async event=>{
    const button=event.target.closest('button');if(!button||working)return;
    if(button.hasAttribute('data-term-prev')){page=Math.max(0,page-1);refresh();return;}
    if(button.hasAttribute('data-term-next')){page++;refresh();return;}
    if(button.hasAttribute('data-term-refresh')){refresh();return;}
    if(!button.hasAttribute('data-term-scan')&&!button.dataset.termDecision)return;
    working=true;button.disabled=true;
    try{
      if(button.dataset.termDecision){
        await api(`${endpoint}/review`,{method:'POST',body:JSON.stringify({id:button.dataset.termId,decision:button.dataset.termDecision})});
        notice.textContent='复核已保存。助手后续查询可读取最新标签；词云需点击上方“生成全量分析”重新生成。已生成的历史报告保持不变。';toast('新词复核已保存');
      }else{
        const result=await api(`${endpoint}/scan`,{method:'POST',body:JSON.stringify({limit:20,taskId:scopeId()})});
        notice.textContent=result.message||'已启动本机CPU扫描，每批最多20条，完成后自动释放模型。候选不会自动进入词云。';
      }
    }catch(error){notice.textContent=error.message;toast(error.message,true);}finally{working=false;button.disabled=false;await refresh();}
  });
  setInterval(()=>{if(panel.open&&!document.hidden&&panel.closest('.app-view')?.classList.contains('hidden')===false)refresh();},5000);
}
