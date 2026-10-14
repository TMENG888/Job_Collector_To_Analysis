import {fetchJsonWithTimeout} from './http-client.js';
import {setAssistantMarkdown,sourceAnchorId} from './assistant-markdown.js';
const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const k=v=>Number.isFinite(v)?`${v.toFixed(2)}K/月`:'样本不足／未提供';
const toolNames={knowledge_catalog:'知识库范围',compare_role_markets:'跨岗位薪资与技能比较',search_jobs:'岗位检索',market_statistics:'市场统计',match_resume:'简历技能匹配',compare_jobs:'岗位对比',prepare_plan:'准备计划'};
Object.assign(toolNames,{collection_tasks:'采集任务列表',collection_task_status:'采集进度',collection_task_logs:'采集日志',collection_prepare_action:'准备操作方案（未执行）'});
const channelNames={shixiseng:'实习僧',iguopin:'国聘',mohrss:'公共招聘网',jobonline:'就业在线',job51:'前程无忧',zhaopin:'智联招聘'};
const stateNames={pending:'等待确认',cancelled:'已取消',expired:'已过期',executing:'结果待核对',submitted:'请求已提交',completed:'已完成',partial:'部分完成',failed:'未确认成功'};
function collectionTaskCard(task){
  const channels=Object.entries(task.channel_counts||{}).filter(([name,count])=>Object.hasOwn(channelNames,name)||Number(count)>0);
  const statusLabel={running:'采集中',paused:'已暂停',partial:'未达目标',completed:'已完成',stopping:'暂停中'}[task.status]||task.status;
  return `<article class="assistant-collection-task">
    <div class="assistant-collection-head"><a href="/tasks/${encodeURIComponent(task.id)}" target="_blank" rel="noopener">${escape(task.label)} ↗</a><span>${escape(statusLabel)} · ${escape(task.stage||'待启动')}</span></div>
    <small>任务ID：${escape(task.id)}</small>
    <div class="assistant-metrics"><div><span>已发现候选</span><b>${Number(task.candidates||0).toLocaleString()} 条</b></div><div><span>去重入库</span><b>${Number(task.stored_rows||0).toLocaleString()} 条</b></div><div><span>目标</span><b>${Number(task.target_rows||0).toLocaleString()} 条</b></div></div>
    <p>${escape(task.message||'')}</p>${channels.length?`<div class="assistant-tags">${channels.map(([name,count])=>`<span>${escape(channelNames[name]||name)}：${escape(typeof count==='number'?count:JSON.stringify(count))}</span>`).join('')}</div>`:''}
    ${task.waiting_human?'<p class="assistant-warning">等待人工登录或验证；助手不会代为完成。</p>':''}
    <p class="assistant-muted">最终交付 ${Number(task.final_rows||0).toLocaleString()} 条 · 导出 ${escape({completed:'已完成',running:'进行中',failed:'失败'}[task.export_status]||task.export_status||'未提交')}<br>状态更新 ${escape(task.updated_at||'未提供')} · 计数刷新 ${escape(task.data_updated_at||'未提供')}<br>历史快照不自动代表当前状态</p>
    <button type="button" class="secondary" data-collection-query="${escape(task.id)}">查询最新进度</button></article>`;
}
function collectionActionCard(action){
  const c=action.config||action.task,expired=Date.now()>action.expires_at,status=expired&&action.status==='pending'?'expired':action.status;
  const parameters=c?`<dl><dt>岗位 / 目标</dt><dd>${escape(c.label)} · ${Number(c.target_rows).toLocaleString()} 条</dd><dt>关键词</dt><dd>${escape((c.keywords||[]).join('、'))}</dd><dt>城市</dt><dd>${escape((c.cities||[]).join('、'))}</dd><dt>渠道</dt><dd>${escape((c.platforms||[]).map(p=>channelNames[p]||p).join('、'))}</dd><dt>节奏</dt><dd>${escape({safe:'保守',balanced:'均衡',fast:'快速'}[c.pace]||c.pace)}</dd></dl>`:'';
  return `<article class="assistant-collection-action" data-action-card="${escape(action.id)}" data-action-state="${escape(status)}" data-action-expires="${action.expires_at}">
    <div class="assistant-collection-head"><h3>${escape(action.title)}</h3><span>${escape(stateNames[status]||status)}</span></div>
    ${action.task?`<small>任务ID：${escape(action.task.id)}</small>`:''}
    ${status==='pending'?parameters:`<details><summary>查看方案参数 · ${escape(c?.label||'采集任务')}</summary>${parameters}<p class="assistant-muted">${escape(action.warning)}</p></details>`}
    ${status==='pending'?`<p class="assistant-muted">${escape(action.warning)}</p>`:''}
    ${action.receipt?`<p role="status">${escape(action.receipt.message)}</p>`:''}
    ${status==='pending'?`<div class="assistant-collection-buttons"><button type="button" class="primary" data-collection-action="${escape(action.id)}" data-decision="confirm">确认执行</button><button type="button" class="secondary" data-collection-action="${escape(action.id)}" data-decision="cancel">取消</button><small>有效至 ${escape(new Date(action.expires_at).toLocaleTimeString())} · 尚未执行</small></div>`:''}</article>`;
}
function expireActionCards(){for(const card of document.querySelectorAll('[data-action-state="pending"]'))if(Date.now()>Number(card.dataset.actionExpires)){card.dataset.actionState='expired';card.querySelector('.assistant-collection-head>span').textContent='已过期，请重新准备';for(const button of card.querySelectorAll('[data-collection-action]'))button.disabled=true;}}
async function syncActionCards(){
  const record=await request('/api/assistant/session',{action:'read',id:conversationId}),latest=new Map();
  for(const row of record.turns)if(row.turn.result?.action)latest.set(row.turn.result.action.id,row.turn.result.action);
  for(const card of document.querySelectorAll('[data-action-card]')){const action=latest.get(card.dataset.actionCard);if(action)card.outerHTML=collectionActionCard(action);}
}
async function collectionAction(actionId,decision){
  if(busy||switching||uploading||!conversationId)return;
  busy=true;controls();notice(decision==='confirm'?'正在提交已确认方案…':'正在取消方案…');
  try{
    const turn=await request('/api/assistant/action',{conversationId,actionId,decision});
    bubble('user',decision==='confirm'?'确认执行采集方案':'取消采集方案');renderTurn(bubble('assistant',''),turn);
    await syncActionCards();await refreshSessions();notice('操作回执已返回；后台进度可继续查询。');
  }catch(error){bubble('assistant',`操作结果需要核对：${error.message}。请先查询任务状态，不要重复创建或启动。`);try{await syncActionCards();}catch{}notice('操作未确认完成。');}
  finally{busy=false;controls();}
}
let serviceBase='',context=null,initialized=false,busy=false,uploading=false,conversationId='',resumePending=null,attachmentName='',modelConfigured=false;
let renderedTurns=0;
let sessions=[],switching=false,sessionDialogId='',deletedSessionId='';
const drafts=new Map(),activeStorageKey='job-assistant-active-session-v1';
const notice=text=>{document.querySelector('#assistantNotice').textContent=text;};
function saveActive(){try{if(conversationId)localStorage.setItem(activeStorageKey,conversationId);else localStorage.removeItem(activeStorageKey);}catch{}}
function savedActive(){try{return localStorage.getItem(activeStorageKey)||'';}catch{return '';}}
function rememberDraft(){drafts.set(conversationId,{message:document.querySelector('#assistantMessage').value,resume:resumePending,name:attachmentName,scroll:document.querySelector('.assistant-chat-stage').scrollTop});}
function restoreDraft(){const draft=drafts.get(conversationId);document.querySelector('#assistantMessage').value=draft?.message||'';resumePending=draft?.resume??null;attachmentName=draft?.name||'';renderAttachment();resizeComposer();if(draft)document.querySelector('.assistant-chat-stage').scrollTop=draft.scroll;}
function conversationTitle(){document.querySelector('#assistantConversationTitle').textContent=sessions.find(s=>s.id===conversationId)?.title||'新对话';}
function historyOpen(open){
  const mobile=matchMedia('(max-width:900px)').matches,workspace=document.querySelector('.assistant-workspace');
  workspace.classList.toggle('assistant-history-open',open);workspace.classList.toggle('assistant-history-collapsed',!open);
  document.querySelector('#assistantHistoryBackdrop').hidden=!open||!mobile;
  const toggle=document.querySelector('#assistantHistoryToggle');toggle.setAttribute('aria-expanded',String(open));toggle.setAttribute('aria-label',open?'收起会话栏':'展开会话栏');
  document.querySelector('#assistantHistory').inert=!open;
}
function renderSessions(){
  const root=document.querySelector('#assistantSessionList'),query=document.querySelector('#assistantSessionSearch').value.trim().toLocaleLowerCase();
  const rows=sessions.filter(s=>s.title.toLocaleLowerCase().includes(query));
  if(!rows.length){root.innerHTML=`<div class="assistant-history-empty"><span>◌</span><p>${query?'未找到匹配会话':'还没有历史会话'}</p><small>${query?'试试其他关键词':'开始聊天后，记录会出现在这里'}</small></div>`;return;}
  const start=new Date();start.setHours(0,0,0,0);const today=start.getTime(),day=86400000;let previous='';
  root.innerHTML=rows.map(s=>{
    const group=s.updated>=today?'今天':s.updated>=today-day?'昨天':s.updated>=today-7*day?'近7天':'更早';
    const heading=group!==previous?`<h3 class="assistant-history-group">${group}</h3>`:'';previous=group;
    return `${heading}<div class="assistant-session-row ${s.id===conversationId?'is-active':''}"><button type="button" class="assistant-session-select" data-session="${escape(s.id)}" ${s.id===conversationId?'aria-current="true"':''} ${busy||switching||uploading?'disabled':''} title="${escape(s.title)}"><span class="assistant-session-icon" aria-hidden="true">◷</span><span class="assistant-session-title">${escape(s.title)}</span><small>${s.turn_count}</small></button><button type="button" class="assistant-session-menu" data-session-menu="${escape(s.id)}" aria-label="管理会话：${escape(s.title)}" aria-haspopup="dialog" ${busy||switching||uploading?'disabled':''}>···</button></div>`;
  }).join('');
}
async function refreshSessions(){
  const result=await request('/api/assistant/sessions');if(!result.persistent)throw new Error('当前助手服务尚未支持历史会话，请更新并重启助手服务');
  sessions=result.sessions;renderSessions();conversationTitle();
}
function clearChat(){document.querySelector('#assistantMessages').innerHTML='';document.querySelector('.assistant-chat-shell').classList.remove('assistant-is-empty');renderConditions({});}
function newConversation(){
  if(busy||uploading||switching)return;rememberDraft();conversationId='';saveActive();clearChat();welcome();restoreDraft();conversationTitle();renderSessions();
  notice('新对话已就绪，旧会话已保留。');if(matchMedia('(max-width:900px)').matches)historyOpen(false);document.querySelector('#assistantMessage').focus();
}
async function selectConversation(id){
  if(busy||uploading||switching||id===conversationId)return;
  rememberDraft();switching=true;controls();notice('正在恢复会话…');
  try{
    const record=await request('/api/assistant/session',{action:'read',id});
    conversationId=id;saveActive();clearChat();
    for(const entry of record.turns){bubble('user',entry.message+(entry.attachment?'\n'+entry.attachment:''));renderTurn(bubble('assistant',''),entry.turn);}
    if(!record.turns.length)welcome();else renderConditions({...record.turns.at(-1).turn,has_resume:record.has_resume});
    restoreDraft();conversationTitle();renderSessions();notice('已恢复历史与筛选条件。历史数据为当时快照，继续提问使用当前知识库；简历如已过期请重新提供。');
    if(matchMedia('(max-width:900px)').matches)historyOpen(false);
  }catch(error){notice(`恢复失败：${error.message}。当前会话未切换。`);}
  finally{switching=false;controls();}
}
function openSessionDialog(id){
  const session=sessions.find(s=>s.id===id);if(!session||busy||switching||uploading)return;
  sessionDialogId=id;document.querySelector('#assistantSessionForm').elements.title.value=session.title;document.querySelector('#assistantSessionDialogNotice').textContent='';document.querySelector('#assistantSessionDialog').showModal();
}
async function sessionAction(action){
  const button=document.querySelector(action==='rename'?'#assistantSessionRename':'#assistantSessionDelete'),info=document.querySelector('#assistantSessionDialogNotice');
  const id=sessionDialogId;button.disabled=true;
  try{
    await request('/api/assistant/session',{action,id,title:document.querySelector('#assistantSessionForm').elements.title.value});
    document.querySelector('#assistantSessionDialog').close();
    if(action==='delete'){
      drafts.delete(id);if(conversationId===id){conversationId='';saveActive();clearChat();welcome();restoreDraft();}
      deletedSessionId=id;const area=document.querySelector('#assistantHistoryNotice');area.innerHTML='已移除会话 <button type="button" id="assistantSessionUndo">撤销</button>';
      document.querySelector('#assistantSessionUndo').addEventListener('click',async()=>{
        try{await request('/api/assistant/session',{action:'restore',id:deletedSessionId});deletedSessionId='';area.textContent='会话已恢复。';await refreshSessions();}catch(error){area.textContent=`恢复失败：${error.message}`;}
      });
    }
    await refreshSessions();notice(action==='delete'?'会话已移除，可在侧栏撤销。':'会话名称已更新。');
  }catch(error){info.textContent=`操作失败：${error.message}`;}
  finally{button.disabled=false;}
}
async function request(path,body){
  const options=body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{};
  try{return await fetchJsonWithTimeout(serviceBase+path,options,100000);}
  catch(error){if(!serviceBase&&error.status===404){serviceBase='http://127.0.0.1:8791';return fetchJsonWithTimeout(serviceBase+path,options,100000);}throw error;}
}
function renderModel(model){
  modelConfigured=!!model.configured;
  const badge=document.querySelector('#assistantModelBadge');badge.textContent=modelConfigured?`${model.provider} · ${model.model}`:'本地模式';badge.title=modelConfigured?'发送消息默认调用此模型；简历原文不外发':'尚未配置模型，使用本地多轮规则与岗位工具';
  const form=document.querySelector('#assistantModelForm');form.elements.provider.value=model.provider_id||'deepseek';form.elements.model.value=model.model||(model.provider_id==='qwen'?'':'deepseek-flash');
}
function bubble(role,text){
  const item=document.createElement('article');item.className=`assistant-message assistant-message-${role}`;
  item.innerHTML=`<div class="assistant-message-label">${role==='user'?'你':'岗位助手'}</div><div class="assistant-message-text">${escape(text)}</div>`;
  if(role==='assistant')setAssistantMarkdown(item.querySelector('.assistant-message-text'),text);
  const messages=document.querySelector('#assistantMessages');messages.append(item);scrollToLatest();return item;
}
function scrollToLatest(){const stage=document.querySelector('.assistant-chat-stage');stage.scrollTop=stage.scrollHeight;}
function welcome(){
  document.querySelector('.assistant-chat-shell').classList.add('assistant-is-empty');
  const hero=document.createElement('div');hero.className='assistant-welcome';
  hero.innerHTML='<div class="assistant-welcome-symbol" aria-hidden="true">✧</div><p class="eyebrow">YOUR NEXT OPPORTUNITY</p><h3>下一步，想去哪里？</h3><p>看懂岗位、对比机会，也能直接管理采集任务。<br>查询立即执行，创建、续采、暂停与导出需确认。</p>';
  document.querySelector('#assistantMessages').append(hero);
}
function resizeComposer(){const input=document.querySelector('#assistantMessage');input.style.height='auto';input.style.height=`${Math.min(200,Math.max(70,input.scrollHeight))}px`;}
function controls(){expireActionCards();for(const id of ['assistantSubmit','assistantClear','assistantAttach'])document.querySelector('#'+id).disabled=busy||uploading||switching;for(const button of document.querySelectorAll('[data-collection-action],[data-collection-query]'))button.disabled=busy||uploading||switching||!!button.dataset.collectionAction&&button.closest('[data-action-card]').dataset.actionState!=='pending';renderSessions();}
function renderAttachment(){
  const root=document.querySelector('#assistantAttachment');root.classList.toggle('hidden',resumePending===null);
  root.innerHTML=resumePending===null?'':`<span>▤ ${escape(attachmentName)} · ${resumePending.length.toLocaleString('zh-CN')}字 · 待发送</span><button type="button" class="assistant-attachment-remove" aria-label="移除待发送简历附件">×</button>`;
  root.querySelector('button')?.addEventListener('click',()=>{if(busy||uploading)return;resumePending=null;attachmentName='';renderAttachment();});
}
async function uploadResume(file){
  if(!file||busy||uploading)return;
  uploading=true;controls();document.querySelector('#assistantNotice').textContent='正在本机解析简历附件';
  const root=document.querySelector('#assistantAttachment');root.classList.remove('hidden');root.textContent=`正在读取 ${file.name}…`;
  try{
    if(file.size>3*1024*1024||!(/\.(txt|md|pdf|docx)$/i.test(file.name)))throw new Error('附件支持TXT、Markdown、文字PDF、DOCX，最多3MB；扫描件和图片暂不支持。');
    const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
    const parsed=await request('/api/assistant/attachment',{filename:file.name,base64:btoa(binary)});
    resumePending=parsed.text;attachmentName=parsed.filename;document.querySelector('#assistantNotice').textContent='附件已在本机解析，发送消息即可开始匹配';
  }catch(error){bubble('assistant',`附件未读取成功：${error.message}`);document.querySelector('#assistantNotice').textContent='附件读取失败';}
  finally{uploading=false;controls();renderAttachment();}
}
function renderConditions(turn){
  const labels={roles:'岗位方向',city:'城市',education:'学历',experience:'经验',years:'工作年限',employment_type:'用工',salary_min_k:'月薪中点下限',salary_max_k:'月薪中点上限'};
  const tags=Object.entries(turn.filters||{}).filter(([,v])=>v!=null&&v!=='').map(([f,v])=>`<span>${escape(labels[f]||f)}：${escape(Array.isArray(v)?v.join(' / '):v)}${f==='years'?'年':f.startsWith('salary_')?'K':''}</span>`);
  if(turn.has_resume)tags.push('<span>简历已暂存本机内存</span>');
  document.querySelector('#assistantConditions').innerHTML=tags.join('')||'当前不限筛选条件 · 不会自动放宽';
}
function renderTurn(item,turn){
  const sourcePrefix=`assistant-turn-${++renderedTurns}`;
  setAssistantMarkdown(item.querySelector('.assistant-message-text'),turn.answer,turn.result?.sources||[],sourcePrefix);
  const result=turn.result,stats=result?.statistics;
  const supplement=document.createElement('div');supplement.className='assistant-message-evidence';
  supplement.innerHTML=`<div class="assistant-execution-label">${turn.execution==='model'?'文本模型 · 系统工具Agent':turn.execution==='local-fallback'?'本地工具结果 · 模型降级':'本地多轮规则模式'}${turn.dataset_changed?' · 数据库已更新，旧条件和引用已重置':''}</div>
    ${(result?.tasks||[]).map(collectionTaskCard).join('')}${result?.task?collectionTaskCard(result.task):''}${result?.action?collectionActionCard(result.action):''}${result?.logs?`<details class="assistant-collection-logs"><summary>最近运行日志（已脱敏）</summary><pre>${escape(result.logs)}</pre></details>`:''}
    ${turn.warning?`<p class="assistant-warning">${escape(turn.warning)}</p>`:''}
    ${turn.trace?.length?`<details class="assistant-tool-trace"><summary>本轮执行了 ${turn.trace.length} 步工具</summary><ol>${turn.trace.map(t=>`<li><span>${escape(toolNames[t.tool]||t.tool)}</span> · ${t.rows} 条 · ${t.status==='ready'?'完成':t.status==='failed'?'失败（未执行）':'需要补充信息'}</li>`).join('')}</ol></details>`:''}
    ${stats?`<div class="assistant-metrics"><div><span>${result.mode==='compare'?'对比岗位有效薪资':'有效薪资样本'}</span><b>${stats.valid_salary_rows} 条</b></div><div><span>招聘月薪中位数</span><b>${k(stats.median_salary_k)}</b></div><div><span>25%–75%分位</span><b>${k(stats.p25_salary_k)} — ${k(stats.p75_salary_k)}</b></div></div>`:''}
    ${result?.comparisons?.length?`<div class="table-scroll assistant-role-comparison"><table class="insight-table"><thead><tr><th>岗位方向</th><th>岗位 / 有效薪资</th><th>月薪中位数</th><th>25%–75%</th></tr></thead><tbody>${result.comparisons.map(g=>`<tr><td>${escape(g.role)}</td><td>${g.matched_jobs} / ${g.statistics.valid_salary_rows}</td><td>${k(g.statistics.median_salary_k)}</td><td>${k(g.statistics.p25_salary_k)} — ${k(g.statistics.p75_salary_k)}</td></tr>`).join('')}</tbody></table></div>${result.comparable_strata?.length?`<details><summary>同城市、经验、学历、用工类型的分层对比（每组至少5条有效薪资）</summary>${result.comparable_strata.map(s=>`<p>${escape(s.conditions)}<br>${s.groups.map(g=>`${escape(g.role)}：${k(g.median_salary_k)}（${g.valid_salary_rows}条）`).join('；')}</p>`).join('')}</details>`:''}<p class="assistant-muted">${escape(result.notice)}</p>`:''}
    ${result?.frequent_skills?.length?`<div class="assistant-tags">${result.frequent_skills.slice(0,8).map(s=>`<span>${escape(s.name)} <small>${s.count}条</small></span>`).join('')}</div>`:''}
    ${result?.mode==='match'?`<p>简历明确提及：${escape(result.resume_skills?.join('、')||'未识别到当前岗位词表的明确技能')}</p>`:''}
    ${result?.sources?.length?`<details class="assistant-source-list" ${result.mode==='compare'?'open':''}><summary>查看 ${result.sources.length} 条岗位证据 · 可继续说“对比前两个岗位”</summary><div class="assistant-jobs">${result.sources.map((s,sourceIndex)=>{
      const position=(turn.selection||[]).find(p=>p.key===s.key)?.position;
      return `<article class="assistant-job" id="${sourceAnchorId(sourcePrefix,sourceIndex)}" tabindex="-1"><div class="assistant-job-head"><div><small>证据 ${sourceIndex+1} · ${position?`第${position}个岗位 · `:''}[${escape(s.citation)}] · ${s.knowledge?'知识库稳定岗位ID':`原文件第${s.row_no}行`}</small><h3>${escape(s.title)}</h3><p>${escape(s.company)} · ${escape(s.city)} · ${escape(s.platform)}</p></div></div><div class="assistant-job-facts"><span>${escape(s.experience||'经验未明确')}</span><span>${escape(s.education||'学历未明确')}</span><b>${k(s.salary_k)}</b></div><p>技术：${escape(s.skills.join('、')||'未提取')}</p>${s.coverage!=null?`<p>技术标签覆盖 ${(s.coverage*100).toFixed(0)}%（非录用概率）<br>未提及／待确认：${escape(s.not_mentioned_skills.join('、')||'暂无')}</p>`:''}<blockquote>${escape(s.quote)}</blockquote><p class="assistant-muted">${s.knowledge?'来自知识库当前内容版本；平台与岗位ID可追溯':s.source_verified?'岗位ID和标题已核对原文件':'仅有报告有限证据'}</p>${s.url?`<a href="${escape(s.url)}" target="_blank" rel="noopener noreferrer">原始岗位 ↗</a>`:''}</article>`;
    }).join('')}</div></details>`:''}
    ${result?.plan?.length&&turn.trace.at(-1)?.tool!=='compare_jobs'?`<details open><summary>准备方向（需确认真实技能缺口）</summary><ol>${result.plan.map(p=>`<li>${escape(p.action)} <small>${p.evidence_jobs}条目标岗位提及</small></li>`).join('')}</ol></details>`:''}`;
  item.append(supplement);
  controls();
  item.addEventListener('click',event=>{
    const link=event.target.closest?.('.assistant-citation');if(!link||!item.contains(link))return;
    const target=item.querySelector(link.getAttribute('href'));if(!target)return;
    event.preventDefault();for(let parent=target.parentElement;parent&&parent!==item;parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;
    target.scrollIntoView({behavior:'smooth',block:'nearest'});target.focus({preventScroll:true});
  });
  renderConditions(turn);scrollToLatest();
}
async function submit(){
  if(busy||uploading||switching)return;
  const form=document.querySelector('#assistantForm'),message=form.elements.message.value.trim()||(resumePending!==null?'请根据这份简历匹配岗位，并给出准备方向。':'');if(!message)return;
  const body={message,conversationId:conversationId||undefined};
  if(resumePending!==null)body.resume=resumePending;
  document.querySelector('.assistant-welcome')?.remove();document.querySelector('.assistant-chat-shell').classList.remove('assistant-is-empty');
  bubble('user',message+(resumePending?`\n［附件：${attachmentName}，仅在本机解析］`:''));
  const pending=bubble('assistant','正在处理这一轮任务…');pending.classList.add('assistant-pending');
  busy=true;controls();
  form.elements.message.value='';resizeComposer();document.querySelector('#assistantNotice').textContent=modelConfigured?'Agent正在规划工具；写操作需要确认':'正在使用本地规则与系统工具';
  try{const turn=await request('/api/assistant/chat',body);const previous=conversationId;conversationId=turn.conversationId;saveActive();drafts.delete(previous);resumePending=null;attachmentName='';renderAttachment();renderTurn(pending,turn);
    if(turn.session){sessions=[turn.session,...sessions.filter(s=>s.id!==turn.session.id)];renderSessions();conversationTitle();}
    else document.querySelector('#assistantHistoryNotice').textContent='本轮服务未保存历史，请检查服务版本。';
    if(turn.result?.action)await syncActionCards();document.querySelector('#assistantNotice').textContent='回答完成';}
  catch(error){setAssistantMarkdown(pending.querySelector('.assistant-message-text'),`本轮未完成：${error.message}。请检查服务或点击“新对话”重试；不会自动重复调用模型。`);document.querySelector('#assistantNotice').textContent='执行失败，上下文未提交。';form.elements.message.value=message;}
  finally{if(body.resume)body.resume='';pending.classList.remove('assistant-pending');busy=false;controls();resizeComposer();form.elements.message.focus();}
}
export async function loadJobAssistant(){
  if(!initialized){
    initialized=true;welcome();
    setInterval(expireActionCards,15000);
    document.querySelector('#assistantMessages').addEventListener('click',event=>{
      const action=event.target.closest('[data-collection-action]'),query=event.target.closest('[data-collection-query]');
      if(action)collectionAction(action.dataset.collectionAction,action.dataset.decision);
      else if(query&&!busy&&!switching&&!uploading){document.querySelector('#assistantMessage').value=`查询采集任务 ${query.dataset.collectionQuery} 的最新进度`;submit();}
    });
    document.querySelectorAll('.sidebar .nav-item').forEach(link=>{link.title=link.textContent.trim();});
    historyOpen(!matchMedia('(max-width:900px)').matches);
    document.querySelector('#assistantHistoryToggle').addEventListener('click',()=>{const open=document.querySelector('#assistantHistoryToggle').getAttribute('aria-expanded')==='true';historyOpen(!open);if(!open)document.querySelector('#assistantSessionSearch').focus();});
    const closeHistory=()=>{historyOpen(false);document.querySelector('#assistantHistoryToggle').focus();};
    document.querySelector('#assistantHistoryClose').addEventListener('click',closeHistory);
    document.querySelector('#assistantHistoryBackdrop').addEventListener('click',closeHistory);
    matchMedia('(max-width:900px)').addEventListener('change',event=>historyOpen(!event.matches));
    document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!document.querySelector('dialog[open]'))closeHistory();});
    document.querySelector('#assistantSessionSearch').addEventListener('input',renderSessions);
    document.querySelector('#assistantSessionList').addEventListener('click',event=>{const menu=event.target.closest('[data-session-menu]'),row=event.target.closest('[data-session]');if(menu)openSessionDialog(menu.dataset.sessionMenu);else if(row)selectConversation(row.dataset.session);});
    document.querySelector('#assistantSessionDialogClose').addEventListener('click',()=>document.querySelector('#assistantSessionDialog').close());
    document.querySelector('#assistantSessionForm').addEventListener('submit',event=>{event.preventDefault();sessionAction('rename');});
    document.querySelector('#assistantSessionDelete').addEventListener('click',()=>sessionAction('delete'));
    const modelForm=document.querySelector('#assistantModelForm'),form=document.querySelector('#assistantForm');
    const modelDialog=document.querySelector('#assistantModelDialog'),modelOpen=document.querySelector('#assistantModelOpen');
    modelOpen.addEventListener('click',()=>{if(!modelDialog.open)modelDialog.showModal();});
    document.querySelectorAll('[data-close-assistant-model]').forEach(button=>button.addEventListener('click',()=>modelDialog.close()));
    modelDialog.addEventListener('close',()=>{modelForm.elements.apiKey.value='';modelOpen.focus();});
    modelDialog.addEventListener('click',e=>{if(e.target!==modelDialog)return;const rect=modelDialog.getBoundingClientRect();if(e.clientX<rect.left||e.clientX>rect.right||e.clientY<rect.top||e.clientY>rect.bottom)modelDialog.close();});
    modelForm.elements.provider.addEventListener('change',()=>{modelForm.elements.model.value=modelForm.elements.provider.value==='deepseek'?'deepseek-flash':'';});
    modelForm.addEventListener('submit',async e=>{
      e.preventDefault();const button=document.querySelector('#assistantModelSave'),notice=document.querySelector('#assistantModelNotice');
      const body={provider:modelForm.elements.provider.value,model:modelForm.elements.model.value,apiKey:modelForm.elements.apiKey.value};modelForm.elements.apiKey.value='';button.disabled=true;
      try{const model=await request('/api/assistant/model',body);renderModel(model);notice.textContent=`${model.provider} · ${model.model} 已加密保存，尚未验证真实调用。`;}
      catch(error){notice.textContent=`保存失败：${error.message}`;}finally{body.apiKey='';button.disabled=false;}
    });
    form.addEventListener('submit',e=>{e.preventDefault();submit();});
    form.elements.message.addEventListener('input',resizeComposer);
    form.elements.message.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();submit();}});
    document.querySelector('#assistantClear').addEventListener('click',newConversation);
    document.querySelector('#assistantAttach').addEventListener('click',()=>document.querySelector('#assistantResumeFile').click());
    document.querySelector('#assistantResumeFile').addEventListener('change',async e=>{try{await uploadResume(e.target.files?.[0]);}finally{e.target.value='';}});
    form.addEventListener('dragover',e=>{if(e.dataTransfer.types.includes('Files'))e.preventDefault();});
    form.addEventListener('drop',e=>{if(!e.dataTransfer.files.length)return;e.preventDefault();if(e.dataTransfer.files.length>1){bubble('assistant','一次请上传一份简历文件。');return;}uploadResume(e.dataTransfer.files[0]);});
    document.querySelectorAll('[data-assistant-example]').forEach(button=>button.addEventListener('click',()=>{
      const type=button.dataset.assistantExample;form.elements.message.value=type==='collection'?'查看采集任务列表':type==='requirements'?`${context?.role||'当前岗位'}主要需要哪些技能？`:type==='compare'?'对比前两个岗位':type==='plan'?'给我一份准备计划':'北京、三年经验、本科的岗位有哪些？';resizeComposer();form.elements.message.focus();
    }));
  }
  try{await refreshSessions();if(!conversationId){const saved=savedActive();if(saved&&sessions.some(s=>s.id===saved))await selectConversation(saved);}}
  catch(error){document.querySelector('#assistantHistoryNotice').textContent=`历史记录暂不可用：${error.message}`;}
  const info=document.querySelector('#assistantContext');
  try{context=await request('/api/assistant/context');info.textContent=context.knowledge?`全岗位知识库 v${context.revision} · ${context.candidate_rows}条去重候选 · ${context.indexed_jobs}条可检索正文岗位。方向：${context.roles.join('、')}。可直接跨岗位比较，不需要切换洞察报告；岗位分类含原文规则结果，建议复核。`:`${context.role} · ${context.indexed_jobs}条纳入岗位 · ${context.verified_sources}条已核对原文。历史会话加密保存，简历内存闲置30分钟过期。`;renderModel(context.model);}
  catch(error){info.textContent=`证据库暂不可用：${error.message}。现有采集不受影响。`;try{renderModel(await request('/api/assistant/model'));}catch{}}
}
