import {requirementCoverage,coverageRankedJobs} from './resume-coverage.js?v=20261113-requirements';
const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const matchingScore=value=>Number.isFinite(value)?value.toFixed(2):'—';
export const matchingPercentage=value=>Number.isFinite(value)&&value>=0&&value<=100?value.toFixed(1)+'%':'—';
export const educationMinimum=s=>/不限|无要求/.test(s)?0:/高中|中专|初中|小学/.test(s)?1:/大专|专科/.test(s)?2:/本科|学士/.test(s)?3:/硕士|研究生/.test(s)?4:/博士/.test(s)?5:null;
export function experienceMinimum(s){if(/不限|无需经验|无经验|应届|在校|以内|以下|不足/.test(s))return 0;const n=String(s||'').match(/\d+(?:\.\d+)?/);return n?Number(n[0]):null;}
export function filterMatchingJobs(jobs,{education='all',experience='all',city='all',search='',keepUnknown=true}={}){
  const pass=(s,v,parse)=>v==='all'||(parse(s||'')===null?keepUnknown:parse(s||'')<=Number(v));
  return jobs.filter(j=>pass(j.education,education,educationMinimum)&&pass(j.experience,experience,experienceMinimum)&&(city==='all'||j.city===city)&&(!search||(j.job_name+' '+j.company).toLowerCase().includes(search.toLowerCase())));
}
const sourceLink=j=>{try{const u=new URL(j.url);return /^https?:$/.test(u.protocol)?`<a href="${escape(u.href)}" target="_blank" rel="noopener noreferrer">招聘原页</a>`:'';}catch{return '';}};
const modelScoreHelp='匹配度＝明确符合的能力要求项数÷岗位主要能力要求项数。每项等权，部分符合与未体现不计分；加分项单列，学历、城市和工作年限另行筛选。';
export function matchingJobCard(j,review,assessment,displayRank=j.rank){
  const coverage=requirementCoverage(assessment),percentage=coverage?.percentage;
  const status={met:'符合',partial:'部分符合',not_evidenced:'未体现'};
  const requirementDetail=coverage?`<p class="rm-verdict">符合 ${coverage.matched} / ${coverage.total} 项<span>${escape(assessment.summary)}</span></p><details class="rm-review"><summary>逐项要求与简历证据</summary><p class="rm-muted">部分符合 ${coverage.partial} 项 · 未体现 ${coverage.notEvidenced} 项 · 加分项 ${coverage.optional} 项（不计分）</p><ol class="rm-requirements">${assessment.items.map(r=>`<li><header><strong>${escape(r.requirement)}</strong><span class="rm-requirement-state" data-state="${r.status}">${r.optional?'加分项 · ':''}${status[r.status]}</span></header><p>${escape(r.reason)}</p><blockquote>JD：${escape(r.jd_evidence)}${r.resume_evidence?`<br>简历：${escape(r.resume_evidence)}`:''}</blockquote></li>`).join('')}</ol></details>`:'';

  const legacyDetail=review?`<p class="rm-verdict">${escape(review.verdict)}<span>${escape(review.summary)}</span></p><details class="rm-review"><summary>匹配依据与待核条件</summary><div class="rm-evidence-grid"><section><h4>匹配依据</h4>${review.matches.map(m=>`<p>${escape(m.reason)}</p><blockquote>JD：${escape(m.jd_evidence)}<br>简历：${escape(m.resume_evidence)}</blockquote>`).join('')}</section><section><h4>待补证据</h4>${review.gaps.length?review.gaps.map(g=>`<p>${escape(g.requirement)}</p><blockquote>${escape(g.jd_evidence)}</blockquote>`).join(''):'<p>未列出明确缺口</p>'}<p class="rm-muted">${escape(review.conditions_note)}</p></section></div></details>`:'<p class="rm-unreviewed">尚未逐岗精评</p>';
  const detail=requirementDetail||legacyDetail;
  return `<article class="rm-job" data-match-key="${escape(j.key)}" data-match-rank="${j.rank}"><span class="rm-rank">${displayRank}</span><div class="rm-job-content"><header class="rm-job-head"><div><h3>${escape(j.job_name)}</h3><p class="rm-company">${escape(j.company)}</p></div><div class="rm-score" title="${modelScoreHelp}${coverage?'':' 尚未完成逐项核验，不能用检索原始分换算。'}" aria-label="匹配度 ${matchingPercentage(percentage)}${coverage?`，符合${coverage.matched}项，共${coverage.total}项`:'，待逐项评估'}"><span>匹配度</span><strong${Number.isFinite(percentage)?'':' class="rm-score-pending"'}>${Number.isFinite(percentage)?matchingPercentage(percentage):coverage?'无明确要求':'待评估'}</strong>${coverage?`<small>${coverage.matched} / ${coverage.total} 项符合</small>`:''}</div></header><div class="rm-meta"><span>${escape(j.city||'地区未注明')}</span><span>${escape(j.salary_raw||'薪资未注明')}</span><span>${escape(j.education||'学历未注明')}</span><span>${escape(j.experience||'经验未注明')}</span><span>${escape(j.platform)}</span></div>${detail}<details class="rm-jd"><summary>查看完整 JD</summary>${sourceLink(j)}<p class="rm-muted">初筛相关分 ${matchingScore(j.rerank_score)} · BM25 ${matchingScore(j.bm25_score)} · 向量 ${matchingScore(j.vector_similarity)} · 初筛第 ${j.recall_rank} 名</p><div class="rm-body">${escape(j.description)}</div></details></div></article>`;
}
const usageText=u=>u?`输入 ${Number(u.input||0).toLocaleString()} / 输出 ${Number(u.output||0).toLocaleString()} Token · 估算 ¥${Number(u.estimate||0).toFixed(4)}（非账单）${u.unknown||u.inFlight?' · 部分用量待核':''}`:'';
let workspace;
export function matchingConversationHtml(memory){
  return (memory?.messages||[]).map(message=>`<article class="rm-message rm-message-${message.role==='user'?'user':'assistant'}"><header>${message.role==='user'?'我':'DeepSeek'}<small>画像 v${Number(message.revision)||1}</small></header><div>${escape(message.text)}</div>${message.usage?`<small>${usageText(message.usage)}</small>`:''}${message.attachments?.length?`<ul>${message.attachments.map(name=>`<li>${escape(name)}</li>`).join('')}</ul>`:''}</article>`).join('');
}
export async function loadResumeMatching({api,toast}){
  if(workspace)return workspace.refresh();
  const root=document.querySelector('#matchingView');
  root.innerHTML=`<section class="card rm-workspace"><header class="rm-heading"><div><h2 data-rm-title>匹配结果</h2><p data-rm-source class="rm-muted"></p></div><div class="rm-actions"><select data-rm-history aria-label="选择目标岗位会话" hidden></select><button type="button" class="primary" data-rm-new>新建匹配</button></div></header><section data-rm-progress class="rm-progress" role="status" aria-live="polite" hidden></section><p data-rm-error class="rm-error" role="alert" hidden></p><div class="rm-split"><aside class="rm-memory" data-rm-memory hidden><header class="rm-memory-head"><h3>人才画像</h3><span data-rm-profile-version></span></header><details open data-rm-profile class="rm-profile" hidden><summary>查看当前能力</summary><div data-rm-skills></div></details><section class="rm-conversation" aria-label="画像补充对话"><h3>补充对话</h3><div data-rm-messages class="rm-messages" role="log" aria-live="polite" aria-relevant="additions"></div><form data-rm-message-form class="rm-composer"><label for="rmMessage">补充经历或调整画像</label><textarea id="rmMessage" data-rm-message rows="3" maxlength="12000" placeholder="例如：补充我用 Docker 部署过的项目；把某项技能改为基础了解"></textarea><div data-rm-documents class="rm-documents"></div><div class="rm-composer-tools"><button type="button" class="ghost" data-rm-attach>添加资料</button><input type="file" data-rm-attachment multiple accept=".pdf,.docx,.txt,.md" hidden><button type="submit" class="primary" data-rm-send>发送并更新</button></div><p class="rm-composer-status" data-rm-compose-status role="status"></p></form></section></aside><section class="rm-matches" aria-label="目标岗位匹配列表"><div class="rm-filters" data-rm-filters hidden><label>最低学历<select data-rm-education><option value="all">不限</option><option value="2">大专及以下</option><option value="3">本科及以下</option><option value="4">硕士及以下</option><option value="5">博士及以下</option></select></label><label>最低工作年限<select data-rm-experience><option value="all">不限</option><option value="0">应届／无需经验</option><option value="1">不超过1年</option><option value="3">不超过3年</option><option value="5">不超过5年</option></select></label><label>地区<select data-rm-city><option value="all">全部地区</option></select></label><label class="rm-search">搜索<input data-rm-search type="search" placeholder="公司或岗位"></label><label class="rm-checkbox"><input data-rm-unknown type="checkbox" checked>保留条件未注明</label><button type="button" class="ghost" data-rm-reset>清空</button></div><div class="rm-result-heading"><p data-rm-count role="status" aria-live="polite"></p><div class="rm-assess-actions"><span class="rm-score-help" title="${modelScoreHelp}" data-rm-budget></span><button type="button" class="ghost" data-rm-assess>逐项评估本页</button></div></div><div data-rm-results><div class="rm-empty">正在读取匹配记录…</div></div><nav class="rm-pagination" data-rm-pagination aria-label="匹配结果分页" hidden><button type="button" class="ghost" data-rm-prev>上一页</button><span data-rm-page></span><button type="button" class="ghost" data-rm-next>下一页</button></nav></section></div></section><dialog class="rm-dialog" data-rm-dialog aria-labelledby="rmDialogTitle"><form data-rm-form><header><h2 id="rmDialogTitle">新建岗位匹配会话</h2><button type="button" class="ghost" data-rm-close aria-label="关闭简历匹配">×</button></header><div class="rm-form-row"><label>目标岗位<select name="role" required></select></label></div><div class="rm-upload"><button type="button" class="ghost" data-rm-upload>上传简历</button><span data-rm-filename class="rm-muted">PDF、DOCX 或文本</span><input type="file" accept=".txt,.md,.pdf,.docx" data-rm-file hidden></div><label>简历正文<textarea name="resume" rows="8" maxlength="40000" minlength="40" required placeholder="上传后自动填入，也可以粘贴文字"></textarea></label><label class="rm-checkbox rm-consent"><input name="shareConfirmed" type="checkbox" required>允许 DeepSeek 解析脱敏资料、维护会话画像并核对岗位要求</label><p class="rm-error" data-rm-form-error role="alert" hidden></p><footer><button type="button" class="ghost" data-rm-close>取消</button><button type="submit" class="primary" data-rm-start>开始匹配</button></footer></form></dialog>`;
  const $=s=>root.querySelector(s),dialog=$('[data-rm-dialog]'),form=$('[data-rm-form]');
  let memory=null,memoryRevision='',memoryId='',sending=false,attaching=false,turnRequest=null;
  const drafts=new Map();
  let status=null,result=null,resultRevision='',assessing=false,assessmentRequest=null,resultId='',selectedId='',loading=false,submitting=false,uploading=false,filename='',page=1,requestId='',requestBody='';
  const count=10;
  function showError(message){$('[data-rm-error]').textContent=message;$('[data-rm-error]').hidden=!message;}
  function draft(){const id=memory?.run.sessionId||selectedId;if(!drafts.has(id))drafts.set(id,{message:'',documents:[]});return drafts.get(id);}
  function renderMemory(changed=false){
    $('[data-rm-memory]').hidden=!memory;$('.rm-split').classList.toggle('has-memory',!!memory);
    if(!memory)return;
    $('[data-rm-profile]').hidden=!memory.profile;
    $('[data-rm-profile-version]').textContent=`v${memory.profileRevision}`;
    const p=memory.profile;
    $('[data-rm-skills]').innerHTML=p?`<p>${escape(p.summary)}</p><div class="rm-skills">${p.skills.map(s=>`<span title="${escape(s.evidence)}">${escape(s.name)}</span>`).join('')}</div>${(p.projects||[]).length?`<details class="rm-projects"><summary>项目与业务经历</summary>${[...(p.projects||[]),...(p.business_experience||[])].map(item=>`<p><strong>${escape(item.name)}</strong><br>${escape(item.evidence)}</p>`).join('')}</details>`:''}`:'<p class="rm-muted">正在识别简历能力…</p>';
    const messages=$('[data-rm-messages]'),bottom=messages.scrollHeight-messages.scrollTop-messages.clientHeight<50;
    const html=matchingConversationHtml(memory);if(messages.innerHTML!==html){messages.innerHTML=html;if(changed||bottom)messages.scrollTop=messages.scrollHeight;}
    if(changed){$('[data-rm-message]').value=draft().message;}
    renderComposer();
  }
  function renderComposer(){
    const unavailable=!memory?.profile||!!status?.busy||sending||attaching;
    $('[data-rm-send]').disabled=unavailable;
    $('[data-rm-send]').textContent=sending?'正在发送…':'发送并更新';
    $('[data-rm-attach]').disabled=unavailable;
    $('[data-rm-message]').disabled=sending;
    $('[data-rm-history]').disabled=sending||attaching;
    $('[data-rm-documents]').innerHTML=(memory?draft().documents:[]).map((d,i)=>`<span>${escape(d.name)}<button type="button" data-rm-remove="${i}" aria-label="移除 ${escape(d.name)}"${sending?' disabled':''}>×</button></span>`).join('');
    $('[data-rm-compose-status]').textContent=attaching?'正在本机读取资料…':status?.busy?'本轮处理中，草稿会保留。':'DeepSeek · 资料和对话仅用于当前岗位会话';
  }
  async function sendMessage(event){
    event.preventDefault();if(sending||attaching||status?.busy||!memory?.profile)return;
    const d=draft(),message=$('[data-rm-message]').value.trim();
    if(!message&&!d.documents.length){$('[data-rm-message]').focus();return;}
    const payload={id:selectedId,message,documents:d.documents,shareConfirmed:true},signature=JSON.stringify(payload);
    if(turnRequest?.signature!==signature)turnRequest={signature,id:crypto.randomUUID()};
    sending=true;renderComposer();
    try{
      const reply=await api('/api/resume-matching/message',{method:'POST',headers:{'Idempotency-Key':turnRequest.id},body:JSON.stringify({...payload,requestId:turnRequest.id}),timeoutMs:30000});
      selectedId=reply.run.id;d.message='';d.documents=[];$('[data-rm-message]').value='';turnRequest=null;memoryRevision='';
      result=null;resultId='';renderResults();await refresh();
    }catch(error){toast(error.message,true);}
    finally{sending=false;renderComposer();}
  }
  $('[data-rm-message-form]').addEventListener('submit',sendMessage);
  $('[data-rm-message]').addEventListener('input',event=>{draft().message=event.target.value;});
  $('[data-rm-attachment]').addEventListener('change',async event=>{
    const files=[...event.target.files];event.target.value='';if(!files.length||!memory)return;
    const d=draft();if(d.documents.length+files.length>3){toast('每轮最多添加3份资料',true);return;}
    attaching=true;renderComposer();
    try{
      const parsed=[];
      for(const file of files){
        if(file.size>3*1024*1024)throw Error('每份资料不能超过3MB');
        const bytes=new Uint8Array(await file.arrayBuffer());let binary='';
        for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
        const value=await api('/api/assistant/attachment',{method:'POST',body:JSON.stringify({filename:file.name,base64:btoa(binary)}),timeoutMs:30000});
        if(value.text.length<40)throw Error('资料正文至少需要40字，可直接用对话补充短内容');
        parsed.push({name:file.name,text:value.text});
      }
      if([...d.documents,...parsed].reduce((n,x)=>n+x.text.length,0)>60000)throw Error('本轮资料合计不能超过60000字');
      d.documents.push(...parsed);
    }catch(error){toast(error.message,true);}finally{attaching=false;renderComposer();}
  });
  function filters(){return {education:$('[data-rm-education]').value,experience:$('[data-rm-experience]').value,city:$('[data-rm-city]').value,search:$('[data-rm-search]').value.trim(),keepUnknown:$('[data-rm-unknown]').checked};}
  function renderResults(){
    $('[data-rm-filters]').hidden=!result;$('[data-rm-pagination]').hidden=!result;
    $('.rm-assess-actions').hidden=!result;
    if(!result){$('[data-rm-title]').textContent=status?.runs?.find(r=>r.id===selectedId)?.role||'匹配结果';$('[data-rm-count]').textContent='';$('[data-rm-results]').innerHTML=selectedId?'<div class="rm-empty"><h3>当前版本的岗位匹配尚未完成</h3><p>画像与对话已保留，完成后在这里显示新结果。</p></div>':'<div class="rm-empty"><h3>上传简历，建立你的目标岗位会话</h3><button type="button" class="primary" data-rm-empty-start>新建匹配</button></div>';return;}
    const jobs=filterMatchingJobs(coverageRankedJobs(result.jobs,result.coverage),filters()),pages=Math.max(1,Math.ceil(jobs.length/count));page=Math.min(page,pages);
    $('[data-rm-title]').textContent=result.role;$('[data-rm-source]').textContent=`分类器岗位池 ${Number(result.sourceRows).toLocaleString()} 条 · ${result.jobs.length} 个候选已重排`;
    $('[data-rm-count]').textContent=`${jobs.length} 个岗位 · ${jobs.filter(j=>Number.isFinite(requirementCoverage(result.coverage?.[j.key])?.percentage)).length} 个已逐项评估`;
    $('[data-rm-results]').innerHTML=jobs.length?jobs.slice((page-1)*count,page*count).map((j,i)=>matchingJobCard(j,result.reviews?.[j.key],result.coverage?.[j.key],(page-1)*count+i+1)).join(''):'<div class="rm-empty"><h3>没有符合当前条件的候选</h3><p>放宽学历、年限或地区再查看。</p><button type="button" class="ghost" data-rm-empty-reset>清空筛选</button></div>';
    $('[data-rm-assess]').disabled=!!status?.busy||assessing||!jobs.length;
    const run=status?.runs?.find(r=>r.id===selectedId);$('[data-rm-budget]').textContent=usageText(run?.operationUsage||run?.usage||result.usage);
    $('[data-rm-page]').textContent=`${page} / ${pages}`;$('[data-rm-prev]').disabled=page===1;$('[data-rm-next]').disabled=page===pages;
  }
  function renderProgress(){
    const run=status?.active||status?.runs?.find(r=>r.id===selectedId),busy=status?.busy;
    const progress=$('[data-rm-progress]');progress.hidden=!busy&&!run?.warning&&!['failed','interrupted','cancelled'].includes(run?.status);
    if(!progress.hidden){const p=run?.progress,text=busy?(p?.message||run?.message||'正在准备匹配'):run?.warning||run?.message;progress.innerHTML=`<div><strong>${escape(text)}</strong>${p?.total?`<span>${Number(p.done||0).toLocaleString()} / ${Number(p.total).toLocaleString()}</span><progress max="${Number(p.total)}" value="${Number(p.done||0)}"></progress>`:''}${run?.usage?`<span>${usageText(run.usage||{estimate:run.estimate})}</span>`:''}</div>${busy?'<button type="button" class="ghost" data-rm-cancel>停止匹配</button>':run&&(!run.imported||run.phase==='coverage')&&['failed','interrupted','cancelled'].includes(run.status)?'<button type="button" class="ghost" data-rm-resume>继续原轮次</button>':''}`;}
    $('[data-rm-new]').disabled=!!busy;$('[data-rm-assess]').disabled=!!busy||assessing||!result;
    const history=$('[data-rm-history]'),signature=JSON.stringify(status?.runs?.map(r=>[r.id,r.status,r.revision]));
    if(history.dataset.signature!==signature){history.innerHTML=(status?.runs||[]).map(r=>`<option value="${escape(r.id)}">${escape(r.role)} · v${r.revision||1} · ${new Date(r.createdAt).toLocaleDateString('zh-CN')} ${r.status==='completed'?'已完成':r.status==='failed'?'失败':r.status==='interrupted'?'已中断':r.status==='cancelled'?'已停止':'进行中'}</option>`).join('');history.dataset.signature=signature;}
    history.hidden=!status?.runs?.length;if(selectedId)history.value=selectedId;
  }
  async function refresh(){
    if(loading)return;loading=true;
    try{
      status=await api('/api/resume-matching');showError('');
      if(!selectedId)selectedId=status.active?.id||status.runs?.[0]?.id||'';
      if(memory?.run){const latest=status.runs?.find(r=>r.sessionId===memory.run.sessionId);if(latest&&selectedId===memory.run.id&&latest.id!==selectedId)selectedId=latest.id;}
      const memoryRun=status.runs?.find(r=>r.id===selectedId);
      if(memoryRun&&(memoryId!==selectedId||memoryRevision!==memoryRun.updatedAt)){
        const requested=selectedId,data=await api('/api/resume-matching/conversation?id='+encodeURIComponent(requested),{timeoutMs:30000});
        if(requested===selectedId){const changed=memory?.run.sessionId!==data.run.sessionId;memory=data;memoryId=requested;memoryRevision=memoryRun.updatedAt;renderMemory(changed);}
      }
      renderComposer();
      renderProgress();const selected=status.runs?.find(r=>r.id===selectedId);
      if(selected?.resultAvailable&&(resultId!==selectedId||resultRevision!==selected.updatedAt)){
        const requested=selectedId,data=await api('/api/resume-matching/result?id='+encodeURIComponent(requested),{timeoutMs:30000});
        if(requested===selectedId){if(resultId!==requested)page=1;result=data;resultRevision=selected.updatedAt;resultId=requested;const previous=$('[data-rm-city]').value;$('[data-rm-city]').innerHTML='<option value="all">全部地区</option>'+[...new Set(result.jobs.map(j=>j.city).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'zh-CN')).map(c=>`<option>${escape(c)}</option>`).join('');$('[data-rm-city]').value=[...$('[data-rm-city]').options].some(o=>o.value===previous)?previous:'all';renderResults();}
      }else if(!selected?.resultAvailable){result=null;resultId='';$('[data-rm-source]').textContent='';renderResults();}
    }catch(e){showError(/不存在|未找到|404/.test(e.message)?'后台尚未加载简历匹配接口，请重启后台后刷新。':e.message);if(!result)renderResults();}
    finally{loading=false;}
  }
  async function openDialog(){
    dialog.showModal();$('[data-rm-form-error]').hidden=true;
    try{const catalog=await api('/api/insights/classifiers'),roles=catalog.roles.filter(r=>r.status==='ready');form.elements.role.innerHTML='<option value="">选择已训练的岗位分类器</option>'+roles.map(r=>`<option>${escape(r.role)}</option>`).join('');if(roles.some(r=>r.role===result?.role))form.elements.role.value=result.role;if(!roles.length)throw Error('暂无已训练成功的分类器，请先在岗位洞察中新增岗位');}
    catch(e){$('[data-rm-form-error]').hidden=false;$('[data-rm-form-error]').textContent=e.message;}
  }
  async function assessPage(){
    if(assessing||status?.busy||!result)return;
    const jobs=filterMatchingJobs(coverageRankedJobs(result.jobs,result.coverage),filters()).slice((page-1)*count,page*count),keys=jobs.filter(j=>!requirementCoverage(result.coverage?.[j.key])).map(j=>j.key);
    if(!keys.length){toast('本页已完成逐项评估');return;}
    const signature=JSON.stringify([selectedId,keys]);if(assessmentRequest?.signature!==signature)assessmentRequest={signature,id:crypto.randomUUID()};
    assessing=true;$('[data-rm-assess]').disabled=true;
    try{await api('/api/resume-matching/assess',{method:'POST',headers:{'Idempotency-Key':assessmentRequest.id},body:JSON.stringify({id:selectedId,keys,shareConfirmed:true,requestId:assessmentRequest.id}),timeoutMs:30000});assessmentRequest=null;await refresh();}
    catch(error){toast(error.message,true);}finally{assessing=false;$('[data-rm-assess]').disabled=!!status?.busy;}
  }
  const reset=()=>{for(const s of ['education','experience','city'])$(`[data-rm-${s}]`).value='all';$('[data-rm-search]').value='';$('[data-rm-unknown]').checked=true;page=1;renderResults();};
  root.addEventListener('click',async e=>{
    if(e.target.closest('[data-rm-attach]'))$('[data-rm-attachment]').click();
    const remove=e.target.closest('[data-rm-remove]');if(remove&&!sending){draft().documents.splice(Number(remove.dataset.rmRemove),1);renderComposer();}
    if(e.target.closest('[data-rm-assess]'))void assessPage();
    if(e.target.closest('[data-rm-new],[data-rm-empty-start]'))void openDialog();
    if(e.target.closest('[data-rm-close]')&&!submitting)dialog.close();
    if(e.target.closest('[data-rm-upload]'))$('[data-rm-file]').click();
    if(e.target.closest('[data-rm-reset],[data-rm-empty-reset]'))reset();
    if(e.target.closest('[data-rm-cancel]')){try{await api('/api/resume-matching/cancel',{method:'POST',body:'{}'});await refresh();}catch(error){toast(error.message,true);}}
    if(e.target.closest('[data-rm-resume]')){try{await api('/api/resume-matching/resume',{method:'POST',body:JSON.stringify({id:selectedId,shareConfirmed:true}),timeoutMs:30000});await refresh();}catch(error){toast(error.message,true);}}
  });
  $('[data-rm-file]').addEventListener('change',async e=>{
    const file=e.target.files?.[0];e.target.value='';if(!file)return;uploading=true;$('[data-rm-start]').disabled=true;$('[data-rm-filename]').textContent='正在本机解析…';
    try{if(file.size>3*1024*1024)throw Error('简历附件不能超过3MB');const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));const parsed=await api('/api/assistant/attachment',{method:'POST',body:JSON.stringify({filename:file.name,base64:btoa(binary)}),timeoutMs:30000});form.elements.resume.value=parsed.text;filename=file.name;$('[data-rm-filename]').textContent=filename;form.elements.shareConfirmed.checked=false;requestId='';$('[data-rm-form-error]').hidden=true;}
    catch(error){$('[data-rm-form-error]').hidden=false;$('[data-rm-form-error]').textContent=error.message;$('[data-rm-filename]').textContent='解析失败，可粘贴文字';}
    finally{uploading=false;$('[data-rm-start]').disabled=false;}
  });
  form.addEventListener('submit',async e=>{
    e.preventDefault();if(submitting||uploading||!form.reportValidity())return;
    const payload={role:form.elements.role.value,resume:form.elements.resume.value,filename,shareConfirmed:form.elements.shareConfirmed.checked},signature=JSON.stringify(payload);if(signature!==requestBody){requestId=crypto.randomUUID();requestBody=signature;}
    submitting=true;$('[data-rm-start]').disabled=true;$('[data-rm-start]').textContent='正在启动…';
    try{const reply=await api('/api/resume-matching/start',{method:'POST',body:JSON.stringify({...payload,requestId}),headers:{'content-type':'application/json','Idempotency-Key':requestId},timeoutMs:30000});selectedId=reply.run.id;requestBody='';requestId='';form.elements.resume.value='';form.elements.shareConfirmed.checked=false;filename='';$('[data-rm-filename]').textContent='PDF、DOCX 或文本';dialog.close();await refresh();}
    catch(error){$('[data-rm-form-error]').hidden=false;$('[data-rm-form-error]').textContent=error.message;}
    finally{submitting=false;$('[data-rm-start]').disabled=false;$('[data-rm-start]').textContent='开始匹配';}
  });
  $('[data-rm-history]').addEventListener('change',async e=>{selectedId=e.target.value;memory=null;memoryId='';memoryRevision='';await refresh();});
  for(const s of ['education','experience','city','unknown'])$(`[data-rm-${s}]`).addEventListener('change',()=>{page=1;renderResults();});$('[data-rm-search]').addEventListener('input',()=>{page=1;renderResults();});
  $('[data-rm-prev]').onclick=()=>{page--;renderResults();};$('[data-rm-next]').onclick=()=>{page++;renderResults();};
  setInterval(()=>{if(!document.hidden&&document.body.dataset.view==='matching')void refresh();},2500);
  workspace={refresh};await refresh();return workspace;
}
