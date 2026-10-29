const labels={ready:'待启动',running:'采集中',completed:'采集完成',budget_paused:'已达本轮上限',blocked:'访问受阻',paused:'已暂停'};
const metricLabels={views:'浏览',likes:'点赞',favorites:'收藏',comments:'评论'};
const validDate=value=>value&&Number.isFinite(new Date(value).getTime());
const dateText=(value,time=false)=>validDate(value)?new Date(value)[time?'toLocaleString':'toLocaleDateString']('zh-CN'):'时间未知';

export function renderInterviewPanel(task,{number,escapeHtml}){
  const data=task.interviews||{},enabled=data.enabled===true,state=enabled?(data.status||'ready'):'disabled';
  const targetReached=data.status==='budget_paused'&&['post_target_reached','post_budget'].includes(data.reason);
  const diagnostic=data.diagnostic;
  const stateLabel=targetReached?'已达采集目标':data.status==='completed'&&data.candidates===0?'本轮无结果':diagnostic?.label||labels[state]||state;
  const detail=data.status==='running'?(data.phase==='detail'?'正在补全正文':'正在检索面经')+(data.currentKeyword?' · '+data.currentKeyword:''):diagnostic?.reason|| (data.status==='blocked'?'原因待核实，请查看本机执行日志。':targetReached?'已达到目标篇数；清空或提高目标后可从断点继续。':data.status==='budget_paused'?'已保存断点，可继续采集。':data.status==='paused'?'采集已停止，保留断点。':data.status==='ready'?'默认采集 · 沿用岗位关键词，与岗位渠道并发运行。':'面经独立保存，不计入岗位数量。');
  return `<section class="interview-panel" data-statistics-scope="interviews" data-state="${escapeHtml(state)}" aria-label="面经独立采集进度">
    <header><div><h3>牛客面经 <span class="interview-state" data-state="${escapeHtml(state)}">${enabled?escapeHtml(stateLabel):'未启用'}</span></h3></div>
      <div class="interview-actions"><button class="ghost" data-interview="configure" ${['running','stopping'].includes(task.status)?'disabled title="任务运行期间不可修改配置"':''}>高级设置</button><button class="ghost" data-interview="classifier">Qwen 标注与训练</button><button class="secondary" data-interview="ranking" ${data.candidates?'':'disabled title="采集到面经后可查看排行"'}>查看排行</button></div>
    </header>
    ${enabled?`<div class="interview-stats"><div><span>已发现</span><strong>${number(data.candidates||0)} <small>篇</small></strong></div><div><span>正文已保存</span><strong>${number(data.details||0)} <small>篇</small></strong></div><div><span>待补正文</span><strong>${number(Math.max(0,(data.candidates||0)-(data.details||0)))} <small>篇</small></strong></div></div>
    <div class="interview-panel-footer"><p class="interview-note">${escapeHtml(detail)}</p>${validDate(data.updated_at)?`<time datetime="${escapeHtml(data.updated_at)}">更新于 ${escapeHtml(new Date(data.updated_at).toLocaleTimeString('zh-CN'))}</time>`:''}</div>`:'<p class="interview-note">当前任务未启用面经，可在高级设置中恢复默认采集。</p>'}
    </section>`;
}

export function installInterviewTools({api,toast,refresh,getTask,escapeHtml,number}){
  const config=document.querySelector('#interviewConfig'),form=document.querySelector('#interviewConfigForm'),ranking=document.querySelector('#interviewRanking'),body=document.querySelector('#interviewRankingBody'),status=document.querySelector('#interviewRankingStatus'),formError=document.querySelector('#interviewConfigError');
  let taskId=null,rankingId=null,offset=0,total=0,requestSequence=0,saving=false;
  const renderPost=post=>{
    const inf=post.influence,validUrl=/^https:\/\/www\.nowcoder\.com\/(?:discuss\/\d+|feed\/main\/detail\/[a-f0-9]{32})$/.test(post.url);
    return `<tr><td><b class="interview-rank">${inf.rank==null?'未排名':'#'+inf.rank}</b><small class="interview-score">${inf.score==null?'评分不足':inf.score.toFixed(2)+' 分'}</small>${inf.relativeWeight==null?'':`<small>组内权重 ${(inf.relativeWeight*100).toFixed(1)}%</small>`}${inf.provisional?'<span class="interview-tag">暂定</span>':''}</td><td><details><summary>${escapeHtml(post.title)} <span class="interview-summary-hint">阅读正文</span></summary><p class="interview-post-content">${escapeHtml(post.content)}</p>${validUrl?`<a class="interview-post-link" href="${escapeHtml(post.url)}" target="_blank" rel="noopener noreferrer">查看牛客原帖 ↗</a>`:''}<p class="interview-post-meta">${post.content_status==='detail'?'完整正文':'搜索摘要'} · 互动快照 ${escapeHtml(dateText(post.metrics_at,true))}${inf.reason?' · '+escapeHtml(inf.reason):''}</p></details><small>发布于 ${escapeHtml(dateText(post.created_at))}</small></td><td><dl class="interview-engagement">${Object.entries(metricLabels).map(([key,label])=>`<div><dt>${label}</dt><dd>${post.metrics[key]==null?'未知':number(post.metrics[key])}</dd></div>`).join('')}</dl><small>互动字段覆盖 ${Math.round(inf.coverage*100)}%</small></td><td><span class="interview-decay">${inf.decay==null?'—':(inf.decay*100).toFixed(1)+'%'}</span><small>时效保留${inf.ageDays==null?'':` · ${Math.floor(inf.ageDays)} 天前`}</small></td></tr>`;
  };
  const renderPage=async({focus=false}={})=>{
    const request=++requestSequence,currentId=rankingId,currentOffset=offset;
    ranking.scrollTop=0;
    body.setAttribute('aria-busy','true');
    body.innerHTML='<div class="interview-loading">正在读取面经排行…<div class="interview-skeleton" aria-hidden="true"></div><div class="interview-skeleton" aria-hidden="true"></div></div>';
    status.textContent='正在读取面经排行';
    try{
      const result=await api(`/api/tasks/${encodeURIComponent(currentId)}/interviews?offset=${currentOffset}&limit=20`);
      if(request!==requestSequence||!ranking.open)return;
      total=result.total;
      if(total&&currentOffset>=total){offset=Math.floor((total-1)/20)*20;return renderPage({focus});}
      body.innerHTML=`<div class="interview-ranking-toolbar"><p><strong>${number(total)}</strong> 篇面经<small>${escapeHtml(result.scope)}${result.duplicateCount?' · 已合并 '+number(result.duplicateCount)+' 篇重复正文':''}</small></p><button type="button" class="ghost" data-interview="refresh-ranking">刷新排行</button></div>${result.posts.length?`<table class="interview-ranking-table"><caption class="interview-sr-only">按互动与时效综合权重降序排列，每页最多20篇。</caption><thead><tr><th scope="col" aria-sort="descending">排名 / 评分</th><th scope="col">面经 · 点击阅读正文</th><th scope="col">互动数据</th><th scope="col">时效</th></tr></thead><tbody>${result.posts.map(renderPost).join('')}</tbody></table><nav class="interview-pagination" aria-label="面经排行翻页"><button type="button" class="ghost" data-interview="prev" ${offset?'':'disabled'}>上一页</button><span>第 ${Math.floor(offset/20)+1} / ${Math.ceil(total/20)} 页</span><button type="button" class="ghost" data-interview="next" ${offset+20<total?'':'disabled'}>下一页</button></nav>`:'<div class="interview-empty"><strong>尚无可展示的面经</strong><span>请先在面经配置中启用，并启动任务采集。</span></div>'}<details class="interview-model"><summary>评分规则与数据说明</summary><p>浏览 15% · 点赞 20% · 收藏 40% · 评论 25%；互动计数经 log 压缩和同组归一化后，再按字段覆盖与帖龄衰减。半衰期 ${result.model.halfLifeDays} 天，三年前同等互动的面经保留约 ${(2**(-1095/result.model.halfLifeDays)*100).toFixed(2)}% 权重。</p><p>仅为本次搜索范围内的相对参考，不代表内容质量或全平台排名。搜索命中不等于已确认同岗；缺失互动标记为「未知」，缺日期或未来日期不排名；小样本或数据不全标记为「暂定」。刷新会按当前时间重算。</p></details>`;
      status.textContent=total?`已加载第 ${Math.floor(offset/20)+1} 页，共 ${number(total)} 篇面经`:'尚无面经数据';
    }catch(error){
      if(request!==requestSequence||!ranking.open)return;
      body.innerHTML=`<div class="interview-empty"><strong>排行暂时无法加载</strong><p class="interview-error">${escapeHtml(error.message)}</p><button type="button" class="secondary" data-interview="refresh-ranking">重新加载</button></div>`;
      status.textContent='面经排行加载失败，可点击重新加载';
    }finally{
      if(request===requestSequence){body.setAttribute('aria-busy','false');if(focus&&ranking.open)document.querySelector('#interviewRankingTitle').focus();}
    }
  };
  ranking.addEventListener('close',()=>{requestSequence++;body.setAttribute('aria-busy','false');});
  config.addEventListener('cancel',event=>{if(saving)event.preventDefault();});
  form.addEventListener('invalid',event=>{const disclosure=event.target.closest('details');if(disclosure)disclosure.open=true;},true);
  document.addEventListener('click',async event=>{
    const button=event.target.closest('[data-interview]');if(!button||button.disabled)return;
    const action=button.dataset.interview,task=getTask();
    if(action==='close-config'){if(!saving)config.close();return;}
    if(action==='close-ranking'){requestSequence++;ranking.close();return;}
    if(action==='prev'||action==='next'){offset=Math.max(0,offset+(action==='prev'?-20:20));await renderPage({focus:true});return;}
    if(action==='refresh-ranking'){await renderPage({focus:true});return;}
    if(!task)return;
    if(action==='classifier'){
      const {openInterviewClassifier}=await import('./interview-classifier.js?v=20261022-qwen-2');
      await openInterviewClassifier({api,toast,escapeHtml,number,taskId:task.id,title:task.label||task.primaryKeyword||'牛客面经'});return;
    }
    if(action==='configure'){
      taskId=task.id;const settings=task.interviews?.settings||{};
      formError.hidden=true;formError.textContent='';form.querySelector('.interview-advanced').open=false;
      form.elements.keywords.value=(settings.keywords?.length?settings.keywords:task.keywords||[task.primaryKeyword]).join('\n');
      form.elements.maxPosts.value=settings.maxPosts??'';form.elements.halfLifeDays.value=settings.halfLifeDays||180;
      form.elements.retryBlocked.checked=false;
      document.querySelector('#interviewRetry').hidden=task.interviews?.status!=='blocked';
      config.showModal();
    }
    if(action==='ranking'){rankingId=task.id;offset=0;ranking.showModal();await renderPage();}
  });
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(saving)return;
    const button=form.querySelector('[type="submit"]'),fields=form.querySelector('fieldset'),closeButtons=form.querySelectorAll('[data-interview="close-config"]');
    const payload={enabled:true,keywords:form.elements.keywords.value,maxPosts:form.elements.maxPosts.value.trim()===''?null:Number(form.elements.maxPosts.value),halfLifeDays:Number(form.elements.halfLifeDays.value),retryBlocked:form.elements.retryBlocked.checked};
    saving=true;button.disabled=true;fields.disabled=true;closeButtons.forEach(item=>item.disabled=true);button.textContent='正在保存…';formError.hidden=true;form.setAttribute('aria-busy','true');
    try{
      const data=await api(`/api/tasks/${encodeURIComponent(taskId)}/interviews`,{method:'POST',body:JSON.stringify(payload)});
      config.close();toast(data.message);await refresh();
    }catch(error){formError.textContent=error.message;formError.hidden=false;formError.focus();}
    finally{saving=false;button.disabled=false;fields.disabled=false;closeButtons.forEach(item=>item.disabled=false);button.textContent='保存配置';form.setAttribute('aria-busy','false');}
  });
}
