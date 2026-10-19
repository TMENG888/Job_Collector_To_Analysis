const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function confirmDeliveryPreview(root,preview,summary){
  const dialog=document.createElement('dialog');dialog.className='jb-confirm jb-batch-confirm';dialog.dataset.jbfAuthorize='';dialog.dataset.resumeRevision=preview.revision;
  dialog.innerHTML='<h2>核对原版式简历与本批发送范围</h2><p data-summary></p><div class="jb-batch-pages" data-pages tabindex="0"></div><label><input type="checkbox" data-consent disabled> 我已核对全部页面，同意将含原始个人信息的简历截图发送给本批匹配岗位的招聘方。</label><p data-preview-note>请滚动核对全部页面后勾选授权。</p><div class="jb-row"><button type="button" data-cancel>取消</button><button type="button" class="primary" data-confirm disabled>授权本批发送</button></div>';
  dialog.querySelector('[data-summary]').textContent=summary;
  const pages=dialog.querySelector('[data-pages]'),consent=dialog.querySelector('[data-consent]'),confirm=dialog.querySelector('[data-confirm]');
  for(const p of preview.pages){const label=document.createElement('p');label.textContent=`原始PDF第${p.page}页 / 共${preview.pages.length}页`;const image=document.createElement('img');image.src='data:'+p.mime+';base64,'+p.base64;image.alt=label.textContent;pages.append(label,image);}
  root.append(dialog);await Promise.all([...pages.querySelectorAll('img')].map(img=>img.decode()));dialog.showModal();
  const inspect=()=>{if(pages.scrollTop+pages.clientHeight>=pages.scrollHeight-10){consent.disabled=false;dialog.querySelector('[data-preview-note]').textContent='已到最后一页；请确认后勾选授权。';}};
  pages.addEventListener('scroll',inspect);requestAnimationFrame(inspect);consent.onchange=()=>{confirm.disabled=!consent.checked||consent.disabled;};
  return new Promise(resolve=>{let done=false;const invalidated=()=>finish(false);const finish=value=>{if(done)return;done=true;root.removeEventListener('job-browser-resume-invalidated',invalidated);dialog.close();dialog.remove();resolve(value);};root.addEventListener('job-browser-resume-invalidated',invalidated);dialog.querySelector('[data-cancel]').onclick=()=>finish(false);dialog.addEventListener('cancel',e=>{e.preventDefault();finish(false);});confirm.onclick=()=>{if(consent.checked&&!consent.disabled)finish(true);};});
}
export function installBrowserFinder({root,post,refresh,note}){
  const panel=document.createElement('section');panel.className='jb-panel jb-finder';panel.dataset.jbFinder='';
  panel.innerHTML='<h2>简历找岗位 <span class="jb-badge">BOSS</span></h2><button type="button" data-jbf-plan>从简历生成搜索词 · Qwen</button><div data-jbf-queries></div><div class="jb-row"><label>每批JD数<input data-jbf-count type="number" min="1" max="10" value="5"></label><label>证据覆盖阈值<input data-jbf-coverage type="number" min="50" max="100" value="70"><small>% · 非录用概率</small></label></div><div class="jb-row"><label>城市<input data-jbf-city placeholder="全国" maxlength="30"></label><label>匹配预算（元）<input data-jbf-budget type="number" min="0.05" max="2" step="0.05" value="0.2"></label></div><label class="jbf-delivery"><input type="checkbox" data-jbf-auto-send> 本批自动发送高匹配招呼＋原版式简历图片</label><div class="jb-row"><label>最多新岗位<input data-jbf-recipients type="number" min="1" max="5" value="2"></label><label>岗位间隔（秒）<input data-jbf-interval type="number" min="30" max="300" value="60"></label></div><div class="jb-row"><button type="button" class="primary" data-jbf-start disabled>开始搜索与筛选</button><button type="button" data-jbf-cancel disabled>停止</button></div><p data-jbf-state>上传简历后生成搜索方案；本批发送需单独授权。</p><div data-jbf-results></div>';
  root.querySelector('[data-jb-upload]').closest('section').after(panel);
  const $=s=>panel.querySelector(s);let state=null,planId=null,models=[],resultsHTML='',sending=false;
  const guard=fn=>async e=>{e.preventDefault();if(sending)return;sending=true;render(state);try{await fn(e);}catch(err){note(err.message,true);}finally{sending=false;await refresh();render(state);}};
  function render(next){
    if(!next)return;state=next;const finder=state.jobFinder||{},busy=finder.busy||finder.planning||state.matching||sending;
    $('[data-jbf-plan]').disabled=busy||!state.resume?.configured||!state.model?.configured;
    $('[data-jbf-start]').disabled=busy||!finder.plan||!state.running||state.mode!=='extension';
    $('[data-jbf-cancel]').disabled=!finder.busy&&!finder.planning;
    if(finder.plan?.id!==planId){
      planId=finder.plan?.id||null;
      $('[data-jbf-queries]').innerHTML=finder.plan?`<p>${esc(finder.plan.summary)}</p>`+finder.plan.queries.map((q,i)=>`<div class="jbf-query" data-jbf-query="${i}"><label>搜索词<input data-jbf-keyword value="${esc(q.keyword)}" maxlength="40"></label><label>监督分类器<select data-jbf-model>${models.map(m=>`<option value="${esc(m.id)}" ${m.id===q.modelId?'selected':''}>${esc(m.role)} · TF-IDF＋LR</option>`).join('')||`<option value="${esc(q.modelId)}">${esc(q.role)}</option>`}</select></label><small>简历依据：${esc(q.resume_evidence)}</small></div>`).join(''):'';
    }
    for(const el of panel.querySelectorAll('[data-jbf-queries] input,[data-jbf-queries] select,[data-jbf-count],[data-jbf-city],[data-jbf-budget],[data-jbf-coverage],[data-jbf-auto-send],[data-jbf-recipients],[data-jbf-interval]'))el.disabled=busy;
    const run=finder.run;
    $('[data-jbf-state]').textContent=finder.planning?'正在根据简历生成搜索方案…':run?`${run.step} · ${run.results.length}/${run.maxCandidates}条 · 匹配估算/预留 ¥${run.budget.spent.toFixed(4)} / ¥${run.budget.limit.toFixed(2)}`:finder.plan?'可修改搜索词和对应分类器；确认后开始。BOSS迁移效果尚未人工校准。':'上传简历后生成搜索方案。未授权的批次只生成草稿。';
    const html=(run?.results||[]).map(row=>`<article class="jbf-result"><h3>${esc(row.job.title||'正在读取岗位')}</h3><p>${esc(row.job.company||'')} ${esc(row.job.salary||'')}</p><span class="jb-badge">${esc(({reading:'读取中',matching:'匹配中',ready:'招呼待确认',sending:'已授权沟通中',sent:'网页确认发送',skipped:'已有记录跳过',quota:'授权名额已满','delivery-stopped':'沟通停止，需人工核对',excluded:'非对标岗位',review:'JD待复核','low-match':'证据不足',stopped:'已停止'})[row.state]||row.state)}</span>${row.screening?`<p>${esc(row.screening.role)} · ${esc(row.screening.method)} · 分类分数${row.screening.score==null?'待核':row.screening.score.toFixed(3)} / 阈值${row.screening.threshold}（非概率）</p>`:''}${row.coverage!=null?`<p>证据覆盖 ${(row.coverage*100).toFixed(0)}% · ${row.matches?.length||0}项匹配 / ${row.gaps?.length||0}项待确认</p>`:''}<p>${esc(row.message)}</p>${row.greeting?`<blockquote>${esc(row.greeting)}</blockquote><button type="button" data-jbf-use="${esc(row.id)}" ${busy?'disabled':''}>打开岗位并使用草稿</button>`:''}</article>`).join('');
    if(html!==resultsHTML){resultsHTML=html;$('[data-jbf-results]').innerHTML=html;}
  }
  async function generate(){
    if(!confirm('将脱敏简历发送给Qwen生成最多3组搜索词，会产生少量Token费用。不会搜索或发送招呼。继续？'))return;
    models=(await post('finder-models')).models;await post('finder-plan');note('搜索方案已生成，请核对岗位方向、搜索词和预算');
  }
  $('[data-jbf-plan]').onclick=guard(generate);
  $('[data-jbf-start]').onclick=guard(async()=>{
    const queries=[...panel.querySelectorAll('[data-jbf-query]')].map(row=>({keyword:row.querySelector('[data-jbf-keyword]').value,modelId:row.querySelector('[data-jbf-model]').value}));
    const enabled=$('[data-jbf-auto-send]').checked;let delivery=null;
    if(enabled){
      if(!state.resume?.screenshotReady)throw Error('自动发送前需上传原版式PDF；DOCX请先另存PDF');
      const preview=await post('resume-pages'),box=root.querySelector('[data-jb-document-preview]');box.replaceChildren();
      for(const page of preview.pages){const img=document.createElement('img');img.src='data:'+page.mime+';base64,'+page.base64;img.alt='待发送原始简历第'+page.page+'页';img.style.width='100%';box.append(img);}box.scrollIntoView({behavior:'smooth',block:'start'});
      // Images must finish rendering before the confirmation can authorize their disclosure.
      await Promise.all([...box.querySelectorAll('img')].map(img=>img.decode()));
      const max=Number($('[data-jbf-recipients]').value),interval=Number($('[data-jbf-interval]').value);
      if(!await confirmDeliveryPreview(root,preview,'搜索词：'+queries.map(q=>q.keyword).join('、')+'。最多尝试'+max+'个新岗位，间隔至少'+interval+'秒。先通过监督分类和证据覆盖门槛，再发送AI选取简历证据组成的招呼及全部原版式截图。网站“立即沟通”可能先发默认招呼。模型读取脱敏简历/JD并计费；结果不明即停，不自动重发。授权20分钟有效，可随时停止。'))return;
      delivery={enabled:true,confirmed:true,planId,resumeRevision:preview.revision,documentHash:preview.documentHash,maxRecipients:max,intervalSeconds:interval};
    }else if(!confirm('将在普通浏览器BOSS中自动搜索、读取本批JD，先监督分类、再付费匹配并生成草稿。不自动发送、投递或处理验证。继续？'))return;
    await post('finder-start',{planId,queries,delivery,maxCandidates:Number($('[data-jbf-count]').value),minCoverage:Number($('[data-jbf-coverage]').value)/100,city:$('[data-jbf-city]').value,budget:Number($('[data-jbf-budget]').value)});note('本批已启动；可停止，遇到验证或页面切换会停止');
  });
  $('[data-jbf-cancel]').onclick=async()=>{try{await post('finder-cancel');await refresh();}catch(e){note(e.message,true);}};
  $('[data-jbf-results]').onclick=guard(async e=>{const b=e.target.closest('[data-jbf-use]');if(!b)return;await post('finder-use',{id:b.dataset.jbfUse});note('已重开并核验同一JD，草稿已载入。请核对岗位并准备沟通，再逐次确认发送。');});
  return {render,generate};
}
