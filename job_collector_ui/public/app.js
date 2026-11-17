import {createInsightSnapshotLoader} from './insight-snapshot-client.js?v=20261113-version-bound';
import {confirmAction} from './confirmation-dialog.js?v=20261112-clear-prompts';
import {installCollectionKeywords} from './collection-keywords.js?v=20261112-compact-copy';
import {provinceName} from './insight-groups.js?v=20261111-province-ranking';
import { patchHtml, updateLog } from './dom-updates.js';
import {renderInsightWorkspace,provinceTooltipDetails} from './insight-dashboard.js?v=20261113-version-bound-top50';
import {installWordCloudInteractions} from './insight-wordcloud.js';
import {loadJobAssistant} from './job-assistant.js?v=20261112-compact-copy';
installWordCloudInteractions();
import {mergeLiveProgress, collectionProgress,collectionStatusLabel,collectionTaskSummary} from './collection-progress.js?v=20261026-statistics';
import {renderCollectionDashboard} from './collection-dashboard.js?v=20261112-compact-copy';
import {formatCollectionFlowLog} from './collection-flow-log.js?v=20261026-statistics';
import {renderInterviewPanel,installInterviewTools} from './interview-tools.js?v=20261112-compact-copy';
import { fetchJsonWithTimeout } from './http-client.js?v=20261112-status-recovery';
import {installInsightClassifier} from './insight-classifier.js?v=20261112-compact-copy';
import {installInsightTrainingQueue} from './insight-training-queue.js?v=20261112-compact-copy';
import {installInsightDiscovery} from './insight-discovery.js?v=20261112-compact-copy';
import {insightReportContext,classifierSnapshotIdentity,reportMatchesClassifier} from './insight-classifier-state.js?v=20261113-version-bound';
import {installSemanticCloud} from './insight-semantic.js?v=20261112-remove-supplement';
import {loadResumeMatching} from './resume-matching.js?v=20261113-requirements';
const state = { tasks: [], tasksLoaded:false,tasksError:'',selectedId: null, insight: null, insightRenderKey: null, insightFormInitialized: false, view: 'tasks', timer: null, logTimer: null };
const normalizedLocalPath = (value) => String(value || '').trim().replaceAll('/', '\\').toLowerCase();
const $ = (selector) => document.querySelector(selector);
const number = (value) => new Intl.NumberFormat('zh-CN').format(Number(value || 0));
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const stageLabel = { collection: '多平台采集', public: '多平台采集', zhaopin: '多平台采集', yupao: '多平台采集', boss: '多平台采集', login_boss: 'BOSS登录', login_zhaopin: '智联登录', login_yupao: '鱼泡验证', finalize: '导出交付', workbook: '导出交付' };
const statusLabel = { ready: '待启动', running: '运行中', completed: '已完成', partial: '未达目标', failed: '需处理', paused: '已暂停', stopping: '停止中' };
const platformLabel = { shixiseng: '实习僧', iguopin: '国聘', mohrss: '公共招聘网', job51: '前程无忧', jobonline: '就业在线', zhaopin: '智联招聘', liepin:'猎聘',nowcoder:'牛客岗位', yupao: '鱼泡直聘', boss: 'BOSS直聘' };
const authLabels={unknown:'未确认',saved_unverified:'会话已保存，未验证登录',human_confirmed:'人工已确认',login_required:'需要登录'};
const verificationLabels={unchecked:'未检查',waiting_human:'等待人工验证',clear:'当前页面通过',session_closed:'会话已关闭'};
const pendingGets = new Map();
async function api(url, options = {}) {
  const readOnly = !options.method || options.method === 'GET';
  if(!readOnly)options={...options,headers:{...options.headers,'Idempotency-Key':options.headers?.['Idempotency-Key']||crypto.randomUUID()}};
  if (readOnly && pendingGets.has(url)) return pendingGets.get(url);
  const request = fetchJson(url, options);
  if (readOnly) pendingGets.set(url, request);
  try { return await request; }
  finally { if (pendingGets.get(url) === request) pendingGets.delete(url); }
}

async function fetchJson(url, options) {
  const {timeoutMs,...requestOptions}=options;
  return fetchJsonWithTimeout(url, requestOptions, timeoutMs);
}

function toast(message, error = false) {
  const element = $('#toast');
  element.textContent = message;
  element.className = `toast show${error ? ' error' : ''}`;
  clearTimeout(element._timer);
  element._timer = setTimeout(() => { element.className = 'toast'; }, 2800);
}

function progress(task) {
  return collectionProgress(task).percent;
}

function renderStats() {
  const running = state.tasks.filter((task) => ['running', 'stopping'].includes(task.status)).length;
  const rows = state.tasks.reduce((sum, task) => sum + (task.metrics.knowledgeRows??task.metrics.finalRows), 0);
  const articles = state.tasks.reduce((sum, task) => sum + (Number(task.interviews?.details)||0), 0);
  patchHtml($('#stats'), [
    ['任务总数', state.tasks.length, ''],
    ['正在运行', running, running ? '请勿同时启动多个登录渠道' : '当前无活动进程'],
    ['岗位已入库', number(rows), '条 · 各任务累计，跨任务未去重'],
    ['面经正文已保存', number(articles), '篇 · 不计入岗位数量'],
  ].map(([label, value, note]) => `<div class="stat"><span>${label}</span><strong>${value}</strong>${note?`<em>${note}</em>`:''}</div>`).join(''));
}

function renderList() {
  const list = $('#taskList');
  if (!state.tasks.length) {
    patchHtml(list, '<div class="empty-list">还没有任务<br />点击右上角创建第一个采集任务</div>');
    return;
  }
  patchHtml(list, state.tasks.map((task) => {
    const value = progress(task);
    return `<button class="task-item ${task.id === state.selectedId ? 'selected' : ''}" data-task="${escapeHtml(task.id)}">
      <div class="task-row"><strong>${escapeHtml(task.label)}</strong><span class="badge ${task.status}">${escapeHtml(collectionStatusLabel(task))}</span></div>
      <div class="task-meta"><span>岗位 ${number(task.metrics.knowledgeRows??0)} 条${task.interviews?.enabled?` · 面经正文 ${number(task.interviews.details||0)} 篇`:''}</span><span>${escapeHtml(collectionTaskSummary(task))}</span></div>
      ${value==null?'':`<div class="mini-progress"><i style="width:${value}%"></i></div>`}
    </button>`;
  }).join(''));
  list.querySelectorAll('[data-task]').forEach((button) => {
    if (button._taskClickBound) return; button._taskClickBound = true;
    button.addEventListener('click', () => {
    state.selectedId = button.dataset.task;
    syncRoute();
    render();
    loadLog();
    });
  });
}

function renderTaskLoadState(){
  const notice=$('#taskLoadNotice'),message=$('#taskLoadMessage'),retry=$('#taskLoadRetry'),refreshButton=$('#refreshBtn');
  notice.hidden=!state.tasksError&&(!state.tasksLoading||state.tasksLoaded);
  notice.dataset.state=state.tasksError?'error':'loading';
  notice.setAttribute('role',state.tasksError?'alert':'status');
  message.textContent=state.tasksError?(state.tasksLoaded?'刷新失败，仍显示上次读取的任务。':'采集任务读取失败。')+state.tasksError:state.tasksLoading?'正在读取采集任务…':'';
  retry.hidden=!state.tasksError;retry.disabled=!!state.tasksLoading;
  refreshButton.disabled=!!state.tasksLoading;refreshButton.setAttribute('aria-busy',String(!!state.tasksLoading));
  $('#taskList').setAttribute('aria-busy',String(!!state.tasksLoading));
  if(!state.tasksLoaded){
    patchHtml($('#taskList'),`<div class="empty-list">${state.tasksError?'暂未读取到任务，请点击重试':'正在读取任务列表…'}</div>`);
    if(state.view==='tasks')patchHtml($('#detail'),`<div class="empty-state"><h2>${state.tasksError?'任务列表暂不可用':'正在加载采集任务'}</h2><p>${state.tasksError?'请点击左侧重试；本次未能读取列表，不代表任务或数据已删除。':'任务读取完成后，将显示采集进度与渠道状态。'}</p></div>`);
  }
}

function renderDetail() {
  const task = state.tasks.find((item) => item.id === state.selectedId);
  if (!task) {
    $('#detail').dataset.taskId = '';
    patchHtml($('#detail'), '<div class="empty-state"><h2>未找到采集任务</h2><p>请选择一个现存任务，或检查链接中的任务 ID。</p></div>');
    return;
  }
  if ($('#detail').dataset.taskId !== task.id) { $('#detail').replaceChildren(); $('#detail').dataset.taskId = task.id; }
  const isRunning = ['running', 'stopping'].includes(task.status);
  const taskMessage = collectionTaskSummary(task);
  const chips = [...task.platforms.filter(key=>key!=='liepin').map((key) => platformLabel[key]), ...task.cities.slice(0, 5), task.pace === 'safe' ? '稳健节奏' : task.pace === 'fast' ? '较快节奏' : '均衡节奏'];
  patchHtml($('#detail'), `
    <div class="detail-head">
      <div class="detail-title"><div><h2>${escapeHtml(task.label)}</h2><p>${escapeHtml(taskMessage)}</p></div><span class="badge ${task.status}">${escapeHtml(collectionStatusLabel(task))}</span></div>
      <div class="detail-actions">
        ${task.browserSession?.verification_status==='waiting_human'?'<button class="primary" data-action="confirm-verification">已人工验证，继续当前会话</button>':''}
        <button class="primary" data-action="all" ${isRunning ? 'disabled' : ''}>${isRunning?'采集中':task.metrics.candidates?'▶ 断点续采全部平台':'▶ 开始采集全部平台'}</button>
        <button class="ghost" data-action="export-latest" ${task.latestExport?.status==='running'?'disabled':''} title="可选下载；洞察和助手直接读知识库，不需要文件中转">${task.latestExport?.status==='running'?'数据下载准备中…':'下载数据（可选）'}</button>
        <button class="danger" data-action="pause" ${!isRunning || task.status === 'stopping' ? 'disabled' : ''}>暂停</button>
        <button class="ghost" data-action="open">打开文件夹</button>
        <button class="secondary" data-action="insights">用于岗位洞察</button>
      </div>
    </div>
    <div class="detail-body">
      ${task.browserSession?`<p>登录状态：${escapeHtml(authLabels[task.browserSession.login_status]||'未确认')} · 验证状态：${escapeHtml(verificationLabels[task.browserSession.verification_status]||'未检查')}</p>`:''}
      ${task.hybridCollection?.results?.length?`<p role="status">本轮取数方式：${task.hybridCollection.results.map(row=>escapeHtml((platformLabel[row.platform]||row.platform)+'：'+(row.transport==='browser_dom'?'页面 RPA':row.transport==='http'?'HTTP':'暂停')+(row.reason?' · '+row.reason:''))).join('；')}</p>`:''}
      ${task.pausedPlatforms?.filter(item=>item.key!=='liepin').length?'<p role="status">暂停渠道（数据与断点保留）：'+task.pausedPlatforms.filter(item=>item.key!=='liepin').map(item=>escapeHtml((platformLabel[item.key]||item.key)+'：'+item.reason)).join('；')+'</p>':''}
      ${renderCollectionDashboard(task,{number,escapeHtml})}
      ${renderInterviewPanel(task,{number,escapeHtml})}
      ${task.latestExport?`<p class="latest-export-status">最新导出：${escapeHtml(task.latestExport.status==='running'?'正在处理':task.latestExport.status==='failed'?'失败':task.latestExport.status==='partial'?'CSV已更新，Excel未更新':'CSV／Excel已更新')} ${task.latestExport.rows?number(task.latestExport.rows)+' 条':''} ${escapeHtml(task.latestExport.updatedAt?new Date(task.latestExport.updatedAt).toLocaleString('zh-CN'):'')} ${escapeHtml(task.latestExport.warning||task.latestExport.error||'')}</p>`:''}
      <div class="task-config">${chips.filter(Boolean).map((chip) => `<span class="chip">${escapeHtml(chip)}</span>`).join('')}</div>
      <div class="log-head"><h3>执行流程</h3><span>${isRunning ? '自动更新' : '最近事件'}</span></div>
      <pre class="log" id="taskLog">正在读取流程…</pre>
      <div class="path"><span>输出</span><code title="${escapeHtml(task.outputDir)}">${escapeHtml(task.outputDir)}</code></div>
      ${task.legacyOutputDir ? `<div class="path"><span>历史目录（未自动混入）</span><code>${escapeHtml(task.legacyOutputDir)}</code></div>` : ''}
      <div class="detail-actions"><button class="ghost" data-action="archive" ${isRunning ? 'disabled' : ''}>从任务列表移除</button></div>
    </div>`);
  $('#detail').querySelectorAll('[data-action]').forEach((button) => {
    if (button._actionBound) return; button._actionBound = true;
    button.addEventListener('click', () => handleAction(state.tasks.find(item => item.id === task.id) || task, button.dataset.action));
  });
}

function render() { renderStats(); renderList(); renderDetail(); }

function routePath(view = state.view) {
  if (view === 'assistant') return '/?view=assistant';
  const id = view === 'tasks' ? state.selectedId : null;
  return `/${view}${id ? `/${encodeURIComponent(id)}` : ''}`;
}

function syncRoute(replace = false) {
  const route = routePath();
  if (location.pathname + location.search !== route) history[replace ? 'replaceState' : 'pushState']({}, '', route);
}

function restoreRoute() {
  const parts = location.pathname.split('/').filter(Boolean);
  const view = new URLSearchParams(location.search).get('view') === 'assistant' ? 'assistant' : ['tasks', 'insights','matching'].includes(parts[0]) ? parts[0] : 'tasks';
  const id = parts[1] ? decodeURIComponent(parts[1]) : null;
  if (view === 'tasks') state.selectedId = id;
  switchView(view, { history: false });
}

function switchView(view, options = {}) {
  state.view = view;
  document.body.dataset.view = view;
  document.body.classList.toggle('assistant-chat-page',view==='assistant');
  document.querySelectorAll('.app-view').forEach((element) => element.classList.add('hidden'));
  $(`#${view}View`).classList.remove('hidden');
  document.querySelectorAll('[data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  document.querySelectorAll('.sidebar [data-view]').forEach((link) => {
    if (link.dataset.view === view) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  const titles = { tasks: '采集任务', insights: '岗位洞察', matching:'简历匹配', assistant: '求职助手' };
  $('#pageTitle').textContent = titles[view];
  $('#newTaskBtn').classList.toggle('hidden', ['insights', 'assistant','matching'].includes(view));
  $('#newTaskBtn').innerHTML = '<span>＋</span> 新建采集任务';
  if (options.history !== false) syncRoute();
  if (view === 'tasks') refresh(false);
  if (view === 'insights') { $('#insightForm input[name="inputFile"]').value='kb://all'; loadInsight(false); }
  if (view === 'assistant') loadJobAssistant();
  if (view === 'matching') void loadResumeMatching({api,toast});
  document.dispatchEvent(new CustomEvent('job-workspace-view',{detail:{view}}));
}

function percent(value) { return `${(Number(value || 0) * 100).toFixed(1)}%`; }
function insightBars(items = [], valueKey = 'count', formatter = (value) => number(value)) {
  const max = Math.max(1, ...items.map((item) => Number(item[valueKey] || 0)));
  return `<div class="insight-bars">${items.slice(0, 10).map((item) => `<div class="insight-bar-row"><span title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span><i><b style="width:${Math.max(3, Number(item[valueKey] || 0) / max * 100)}%"></b></i><strong>${escapeHtml(formatter(item[valueKey], item))}</strong></div>`).join('')}</div>`;
}

function salaryBenchmarkTable(items = []) {
  return `<div class="table-scroll"><table class="insight-table"><thead><tr><th>对标维度</th><th>薪资样本</th><th>P25</th><th>中位数</th><th>P75</th></tr></thead><tbody>${items.map((item) => `<tr><td>${escapeHtml(item.name)}</td><td>${number(item.salary_count)}</td><td>${item.p25 ?? '—'}K</td><td>${item.median ?? '—'}K</td><td>${item.p75 ?? '—'}K</td></tr>`).join('') || '<tr><td colspan="5">有效薪资样本不足</td></tr>'}</tbody></table></div>`;
}

function selectOptions(values = [], selected = '') {
  return values.map((value) => `<option value="${escapeHtml(value)}" ${value === selected ? 'selected' : ''}>${escapeHtml(value)}</option>`).join('');
}

function renderInsightStatus() {
  $('#insightRoleSource').textContent = '';
  $('#insightTransferSource').textContent = '';
  const insight = state.insight || { status: 'empty', message: '尚未生成岗位市场洞察' };
  const status = $('#insightStatus');
  const report = insight.report;
  const context=insightReportContext({report,inputFile:$('#insightForm input[name="inputFile"]').value,role:$('#insightRole')?.value||'',running:insight.status==='running',normalize:normalizedLocalPath});
  const completedMessage = report && insight.status === 'completed' ? `${report.experimental?'[试分析 · 候选未达标] ':''}${report.detected_role?.name || report.role || '岗位'}分析完成：${number(report.sample_rows)}/${number(report.total_rows)} 条${insight.snapshot?.reusable?' · 已复用快照':insight.snapshot?' · 可更新':''}` : insight.message;
  const updatedAt = report?.generated_at || insight.updatedAt;
  status.classList.toggle('insight-report-stale',context.hideReport);
  status.innerHTML = `<div class="insight-run-state ${escapeHtml(insight.status)}"><span class="pulse"></span><div><b>${escapeHtml(context.title||completedMessage)}</b><small>${context.hideReport?'上次报告与当前范围或岗位不同':insight.status === 'running' ? `已运行 ${number(insight.runningSeconds)} 秒` : updatedAt ? `最近更新 ${new Date(updatedAt).toLocaleString('zh-CN')}` : '选择目标岗位后生成分析'}</small></div></div>`;
  if (report) {
    const changed = normalizedLocalPath($('#insightForm input[name="inputFile"]').value) !== normalizedLocalPath(report.input_file);
    const historicalManual = report.detected_role?.mode === 'manual_override' && !report.selection_contract;
    const sourceLabel=String(report.input_file||'').startsWith('kb://')?`${report.detected_role?.name||report.role||'全部岗位'} · 知识库`:String(report.input_file||'').split(/[/\\]/).at(-1);
    status.insertAdjacentHTML('beforeend', `<div class="insight-report-actions"><p class="insight-report-source" title="${escapeHtml(report.input_file)}">${changed?'上次报告':'报告'}：${escapeHtml(sourceLabel)}${insight.status === 'failed' ? ' · 本次失败，保留上次报告' : historicalManual ? ' · 历史报告，建议重新生成' : ''}</p>${context.hideReport?`<button type="button" class="ghost" data-insight-history aria-controls="insightDashboard" aria-expanded="${!!state.insightHistoryVisible}">${state.insightHistoryVisible?'收起':'查看'}上次报告</button>`:''}</div>`);
  }
  $('#insightDashboard').hidden=context.hideReport&&!state.insightHistoryVisible;
  status.querySelector('[data-insight-history]')?.addEventListener('click',()=>{state.insightHistoryVisible=!state.insightHistoryVisible;renderInsightStatus();});
  const button = $('#runInsight');
  if (button) {
    const ready=button.dataset.analysisReady==='true'&&button.dataset.classifierSource===$('#insightForm input[name="inputFile"]').value&&button.dataset.classifierRole===($('#insightRole')?.value||'');
    const running=insight.status==='running'||insight.globalRunning||button.dataset.submitting==='true';
    button.disabled = running||!ready;
    button.textContent = running ? '分析中…' : button.dataset.classifierMode==='candidate-trial'?'生成试分析':'生成分析';
  }
}

function logInsightFilterAudit(report) {
  // Development diagnostics only; original evidence remains in the saved report.
  const audit = {
    input_file: report.input_file,
    generated_at: report.generated_at,
    selection_contract: report.selection_contract,
    counts: {
      input_rows: report.total_rows,
      scanned_rows: report.requested_sample_rows,
      matched_rows: report.sample_rows,
      salary_rows: report.quality?.salary_rows,
      pending_rows: report.selection_review?.pending_rows,
      excluded_rows: report.selection_review?.excluded_rows ?? report.filtered_out_rows,
    },
    analysis_mode: report.analysis_mode,
    sampling_method: report.sampling_method,
    relevance_rate: report.relevance_rate,
    low_match_rate: report.relevance_rate < 0.1,
    keyword_selection: report.keyword_selection,
    role_classifier: report.role_classifier,
    joint_expansion: report.joint_expansion,
    topic_model: report.topic_model,
    pending_included_in_statistics: false,
  };
  console.debug('[岗位筛选审计]', audit);
  return audit;
}

let disposeInsightWorkspace=null;
function renderInsightDashboard() {
  const report = state.insight?.report;
  const container = $('#insightDashboard');
  disposeInsightWorkspace?.();disposeInsightWorkspace=null;
  if (!report) {
    container.innerHTML = '<div class="insight-empty card"><b>暂无分析结果</b></div>';
    return;
  }
  logInsightFilterAudit(report);
  container.innerHTML=(report.experimental?'<p class="insight-trial-banner" role="note">试分析 · 分类器未通过验收</p>':'')+'<div id="cohortExplorer"></div>';
  disposeInsightWorkspace=renderInsightWorkspace($('#cohortExplorer'),report,{drawProvinceMap});
}

function orientMap(geo) {
  // Normalize each ring rather than blindly reversing a whole feature. Cached
  // city boundaries contain mixed windings (notably Tianjin's coastal islands).
  // A reversed small ring covers the rest of the globe in d3's spherical model.
  const polygon=rings=>rings.forEach((ring,index)=>{
    const coversGlobe=window.d3.geoArea({type:'Polygon',coordinates:[ring]})>2*Math.PI;
    if(coversGlobe===(index===0))ring.reverse();
  });
  const geometry=g=>{
    if(g?.type==='Polygon')polygon(g.coordinates);
    if(g?.type==='MultiPolygon')g.coordinates.forEach(polygon);
    if(g?.type==='GeometryCollection')g.geometries.forEach(geometry);
  };
  for(const feature of geo.features||[])geometry(feature.geometry);
}

let provinceMapRevision=0,provinceGeometryPromise=null;
async function drawProvinceMap(provinces) {
  const revision=++provinceMapRevision,container=$('#provinceMap');if(!container)return;
  if(!window.d3){container.textContent='地图组件未加载，请刷新页面重试。';return;}
  try{
    if(!provinceGeometryPromise)provinceGeometryPromise=fetch('/china-provinces.geojson').then(response=>{if(!response.ok)throw Error('省级行政边界不可用');return response.json();}).catch(error=>{provinceGeometryPromise=null;throw error;});
    const geo=structuredClone(await provinceGeometryPromise);
    if(revision!==provinceMapRevision||!container.isConnected)return;
    orientMap(geo);container.replaceChildren();
    const statistics=new Map(provinces.map(item=>[item.name,item])),counts=new Map(provinces.map(item=>[item.name,item.count])),max=Math.max(1,...counts.values());
    const tooltip=document.createElement('div');tooltip.id='provinceMapTooltip';tooltip.className='province-map-tooltip';tooltip.setAttribute('role','tooltip');tooltip.hidden=true;container.append(tooltip);
    const hideTooltip=()=>{tooltip.hidden=true;};
    const showTooltip=(event,feature)=>{
      const name=province(feature),detail=provinceTooltipDetails(statistics.get(name),feature.properties.name||name);
      tooltip.innerHTML=detail.html;tooltip.hidden=false;
      const bounds=container.getBoundingClientRect(),region=event.currentTarget.getBoundingClientRect();
      const x=event.type==='focus'?region.left+region.width/2:event.clientX,y=event.type==='focus'?region.top+region.height/2:event.clientY;
      const left=x-bounds.left+16,top=y-bounds.top+16;
      tooltip.style.left=`${Math.max(8,Math.min(left, bounds.width-tooltip.offsetWidth-8))}px`;
      tooltip.style.top=`${Math.max(8,Math.min(top, bounds.height-tooltip.offsetHeight-8))}px`;
    };
    const width=760,height=470,svg=window.d3.select(container).append('svg').attr('viewBox',`0 0 ${width} ${height}`).attr('role','group').attr('aria-label','中国省份目标岗位分布，支持键盘筛选');
    const projection=window.d3.geoMercator().fitExtent([[18,18],[width-18,height-18]],geo),pathGenerator=window.d3.geoPath(projection);
    const province=feature=>feature.properties.name?provinceName(feature.properties.name):'';
    svg.selectAll('path').data(geo.features).join('path').attr('class','map-region').attr('d',pathGenerator)
      .style('fill',feature=>counts.get(province(feature))?window.d3.interpolateGreens(.25+.6*counts.get(province(feature))/max):'#edf3f0')
      .attr('tabindex',0).attr('role',feature=>counts.has(province(feature))?'button':'img')
      .attr('aria-label',feature=>provinceTooltipDetails(statistics.get(province(feature)),feature.properties.name||'省级边界').label)
      .attr('aria-describedby','provinceMapTooltip')
      .on('pointerenter pointermove focus',showTooltip).on('pointerleave blur',hideTooltip)
      .on('click',(_,feature)=>selectMapProvince(province(feature)))
      .on('keydown',(event,feature)=>{if(event.key==='Escape')hideTooltip();if(event.key==='Enter'||event.key===' '){event.preventDefault();selectMapProvince(province(feature));}});
    const legend=document.createElement('div');legend.className='province-map-legend';legend.innerHTML=`<span>岗位数</span><span>0</span><i aria-hidden="true"></i><span>${number(Math.max(0,...counts.values()))}</span>`;container.append(legend);
    const unmapped=provinces.filter(item=>!geo.features.some(feature=>province(feature)===item.name)).reduce((sum,item)=>sum+item.count,0);
    if(unmapped){const note=document.createElement('p');note.className='insight-card-caption';note.textContent=`另有 ${number(unmapped)} 条岗位地点未明确、为多省份或不在省级地图范围内，仍计入筛选与分析。`;container.append(note);}
  }catch(error){if(revision===provinceMapRevision&&container.isConnected)container.textContent=`地图暂不可用：${error.message}`;}
}
function selectMapProvince(province){
  const select=$('#cohortProvince');if(!select||![...select.options].some(option=>option.value===province))return;
  select.value=province;select.dispatchEvent(new Event('change'));
  $('#insightOverviewSection')?.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'});
}

function insightReportKey(report) {
  if (!report) return 'empty';
  return [report.version,report.role,report.analysis_snapshot?.contextKey,report.role_classifier?.artifact_sha256,report.generated_at, report.topic_model?.display_model?.updated_at, report.input_file, report.sheet_name, report.analysis_mode, report.sample_rows].join('|');
}

function renderInsight() {
  renderInsightStatus();
  const nextKey = insightReportKey(state.insight?.report);
  if (nextKey === state.insightRenderKey) return;
  state.insightRenderKey = nextKey;
  renderInsightDashboard();
}

let insightClassifierIdentity=null,insightClassifierIdentityRole='';
const currentInsightClassifier=()=>insightClassifierIdentityRole===($('#insightRole')?.value||'')?insightClassifierIdentity:null;
const insightSnapshotLoader=createInsightSnapshotLoader({api,classifier:currentInsightClassifier,selection:()=>{
  const button=$('#runInsight'),role=$('#insightRole')?.value||'';
  return {inputFile:'kb://all',role,classifierMode:button?.dataset.classifierRole===role?button.dataset.classifierMode||'qualified':'qualified',...(button?.dataset.classifierRole===role&&button.dataset.classifierMode==='candidate-trial'?{classifierRunId:button.dataset.classifierRunId}:{})};
},apply:next=>{
  state.insight=next;
  if(!state.insightFormInitialized&&next.report){$('#insightForm input[name="inputFile"]').value='kb://all';state.insightFormInitialized=true;}
  renderInsight();
}});
async function loadInsight(silent = true) {
  try{await insightSnapshotLoader.refresh();}catch(error){if(!silent)toast(error.message,true);}
}
$('#insightClassifier')?.addEventListener('insight-annotation-state',event=>{
  if(event.detail.inputFile!=='kb://all')return;
  const role=$('#insightRole')?.value||'',identity=classifierSnapshotIdentity(event.detail.state);
  const changed=role!==insightClassifierIdentityRole||JSON.stringify(identity)!==JSON.stringify(insightClassifierIdentity);
  insightClassifierIdentity=identity;insightClassifierIdentityRole=role;
  if(identity&&state.insight?.report&&!reportMatchesClassifier(state.insight.report,identity)){
    state.insight={...state.insight,report:null,reportVersion:null,snapshot:null,status:state.insight.status==='running'?'running':'empty',message:'分类器已更新，请重新生成分析'};
    renderInsight();
  }
  if(changed)void loadInsight(true);
});

async function refresh(silent = true) {
  if (state.tasksLoading) return;
  state.tasksLoading = true;
  state.tasksError='';renderTaskLoadState();
  try {
    const data = await api('/api/tasks');
    if(!Array.isArray(data.tasks))throw Error('后台返回的任务列表格式无效，请重试');
    state.tasks = data.tasks;
    state.tasksLoaded=true;
    if(state.view==='tasks'){
      if(!state.selectedId&&state.tasks.length)state.selectedId=state.tasks[0].id;
      syncRoute(true);render();
      if(state.selectedId&&!$('#taskLog')?._logLoaded)loadLog();
    }
    try {
      const unified=await api(`/unified-progress.json?t=${Date.now()}`,{timeoutMs:1500});
      if(Date.now()-Date.parse(unified.updatedAt)<45000)state.tasks=state.tasks.map(task=>{
        const report=unified.tasks?.[task.id];
        return report?.task_id===task.id?{...task,metrics:{...task.metrics,unifiedDataset:report}}:task;
      });
    } catch {}
    // Static compatibility snapshot keeps the running collector untouched.
    // Native server metrics take precedence after a normal service restart.
    if (state.tasks.some(task=>!task.metrics.liveCollection)) {
      try {
        const snapshot = await api(`/live-progress.json?t=${Date.now()}`,{timeoutMs:1500});
        state.tasks = mergeLiveProgress(state.tasks,snapshot);
      } catch {}
    }
    if (state.view !== 'tasks') return;
    if (!state.selectedId && state.tasks.length) state.selectedId = state.tasks[0].id;
    syncRoute(true);
    render();
    if (state.selectedId && !$('#taskLog')?._logLoaded) loadLog();
  } catch (error) { state.tasksError=error.message;if (!silent) toast(error.message, true); }
  finally { state.tasksLoading = false;renderTaskLoadState(); }
}

async function loadLog() {
  const id = state.selectedId;
  const log = $('#taskLog');
  if (state.view !== 'tasks' || !id || !log || log._logLoading) return;
  log._logLoading = true;
  try {
    const data = await api(`/api/tasks/${encodeURIComponent(id)}/logs`);
    if (state.view !== 'tasks' || id !== state.selectedId || log !== $('#taskLog')) return;
    updateLog(log, formatCollectionFlowLog(data.content)); log._logLoaded = true;
  } catch {}
  finally { log._logLoading = false; }
}

const pendingVerifications=new Set();
async function handleAction(task, action) {
  try {
    const verificationAction=action.match(/^verify-(open|finish|close|session)-(job51|liepin)$/);
    if(verificationAction){
      const [,operation,platform]=verificationAction,key=task.id+':'+platform;
      if(pendingVerifications.has(key))return;
      pendingVerifications.add(key);
      const controls=[...document.querySelectorAll('button.channel-verify-control,button.channel-verify-trigger')].filter(button=>button.dataset.action?.endsWith('-'+platform));
      const labels=controls.map(button=>button.textContent);
      controls.forEach(button=>{button.disabled=true;button.setAttribute('aria-busy','true');if(button.dataset.action===action)button.textContent='处理中…';});
      try{
        const opening=operation==='open'||operation==='session';
        // Always use the collector's own session browser. The old ordinary
        // Edge path created a second browser whose login did not carry over
        // to the collector/recheck session.
        const options={mode:'collector'};
        if(opening){
          const capabilities=await api('/api/channel-verification/capabilities').catch(()=>null);
          if(!capabilities?.ordinaryBrowser)throw Error('人工会话入口需要重启后台生效；已阻止旧版打开受管理窗口');
        }
        const data=await api(`/api/tasks/${encodeURIComponent(task.id)}/channels/${platform}/verification/${opening?'open':operation}`,{method:'POST',body:JSON.stringify(opening?options:{}),timeoutMs:60000});
        toast(data.message);await refresh();
      }finally{pendingVerifications.delete(key);controls.forEach((button,i)=>{if(button.isConnected){button.disabled=false;button.removeAttribute('aria-busy');button.textContent=labels[i];}});}
      return;
    }
    const manualBrowserAction=action.match(/^manual-open-(job51|liepin|zhaopin)$/);
    if(manualBrowserAction){
      const platform=manualBrowserAction[1],key=task.id+':'+platform;
      if(pendingVerifications.has(key))return;
      pendingVerifications.add(key);
      const controls=[...document.querySelectorAll('button.channel-verify-control,button.channel-verify-trigger')].filter(button=>button.dataset.action?.endsWith('-'+platform));
      const labels=controls.map(button=>button.textContent);
      controls.forEach(button=>{button.disabled=true;button.setAttribute('aria-busy','true');if(button.dataset.action===action)button.textContent='打开中…';});
      try{
        await api(`/api/tasks/${encodeURIComponent(task.id)}/channels/${platform}/manual-browser/open`,{method:'POST',body:'{}',timeoutMs:60000});
        toast('普通浏览器已打开；完成登录/验证并关闭窗口后，点击“已处理”');
      }finally{pendingVerifications.delete(key);controls.forEach((button,i)=>{if(button.isConnected){button.disabled=false;button.removeAttribute('aria-busy');button.textContent=labels[i];}});}
      return;
    }
    const sessionAction=action.match(/^session-(open|login|verified|process|close|resume)-(job51|liepin|zhaopin|jobonline)$/);
    if(sessionAction){
      const [,operation,platform]=sessionAction,key=task.id+':'+platform;
      if(pendingVerifications.has(key))return;
      pendingVerifications.add(key);
      const controls=[...document.querySelectorAll('button.channel-verify-control,button.channel-verify-trigger')].filter(button=>button.dataset.action?.endsWith('-'+platform));
      const labels=controls.map(button=>button.textContent);
      controls.forEach(button=>{button.disabled=true;button.setAttribute('aria-busy','true');if(button.dataset.action===action)button.textContent=operation==='resume'?'启动中…':'处理中…';});
      try{
        let data;
        if(operation==='resume')data=await api(`/api/tasks/${encodeURIComponent(task.id)}/channels/${platform}/resume`,{method:'POST',body:'{}',timeoutMs:60000});
        else if(operation==='close')data=await api(`/api/tasks/${encodeURIComponent(task.id)}/channels/${platform}/session/close`,{method:'POST',body:'{}',timeoutMs:60000});
        else if(operation==='open')data=await api(`/api/tasks/${encodeURIComponent(task.id)}/channels/${platform}/session/open`,{method:'POST',body:'{}',timeoutMs:90000});
        else data=await api(`/api/tasks/${encodeURIComponent(task.id)}/channels/${platform}/session/mark`,{method:'POST',body:JSON.stringify({state:operation==='login'?'logged_in':'verified'}),timeoutMs:90000});
        toast(data.message||'已处理');await refresh();
      }finally{pendingVerifications.delete(key);controls.forEach((button,i)=>{if(button.isConnected){button.disabled=false;button.removeAttribute('aria-busy');button.textContent=labels[i];}});}
      return;
    }
    if(action==='export-latest'){
      const data=await api(`/api/tasks/${encodeURIComponent(task.id)}/export-latest`,{method:'POST',body:'{}'});
      toast(data.message);return refresh();
    }
    if (action === 'insights') {
      state.insightFormInitialized = true;
      $('#insightForm input[name="inputFile"]').value = 'kb://all';
      switchView('insights');
      $('#insightForm').scrollIntoView({ behavior: 'smooth' });
      toast('已打开全量岗位洞察；选择目标岗位后生成分析，新方向可输入岗位名称训练');
      return;
    }
    if (action === 'pause') {
      const data = await api(`/api/tasks/${encodeURIComponent(task.id)}/pause`, { method: 'POST', body: '{}' });
      toast(data.message); return refresh();
    }
    if(action==='confirm-verification') {
      const data=await api(`/api/tasks/${encodeURIComponent(task.id)}/confirm-verification`,{method:'POST',body:'{}'});
      toast(data.message);return refresh();
    }
    if (action === 'open') {
      await api(`/api/tasks/${encodeURIComponent(task.id)}/open`, { method: 'POST', body: '{}' }); return;
    }
    if (action === 'archive') {
      if (!await confirmAction('移除采集任务',`确定移除“${task.label}”任务吗？已采集数据保留。`)) return;
      await api(`/api/tasks/${encodeURIComponent(task.id)}/archive`, { method: 'POST', body: '{}' });
      state.selectedId = null; toast('任务已移除，文件仍保留'); return refresh();
    }
    const data = await api(`/api/tasks/${encodeURIComponent(task.id)}/run`, { method: 'POST', body: JSON.stringify({ stage: action }) });
    toast(data.message); refresh();
  } catch (error) { toast(error.message, true); }
}

const cities = ['北京', '天津', '上海', '重庆', '南京', '苏州', '杭州', '武汉', '广州', '深圳', '成都', '西安'];
$('#cityChecks').innerHTML = cities.map((city) => `<label><input type="checkbox" name="cities" value="${city}" ${['北京','上海','南京','杭州','武汉','广州','深圳','成都','西安'].includes(city) ? 'checked' : ''} />${city}</label>`).join('');

document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', event => {
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault(); switchView(button.dataset.view);
}));
window.addEventListener('popstate', restoreRoute);
$('#newTaskBtn').addEventListener('click', () => $('#taskDialog').showModal());
document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => $('#taskDialog').close()));
$('#showGuide').addEventListener('click', () => $('#guideDialog').showModal());
document.querySelectorAll('[data-close-guide]').forEach((button) => button.addEventListener('click', () => $('#guideDialog').close()));
$('#refreshBtn').addEventListener('click', () => refresh(false));
$('#taskLoadRetry').addEventListener('click',()=>refresh(false));
installInterviewTools({api,toast,refresh,getTask:()=>state.tasks.find(task=>task.id===state.selectedId),escapeHtml,number});
// Mark edits immediately, before any delayed initial report can restore fields.
for (const eventName of ['input', 'change']) $('#insightForm').addEventListener(eventName, () => {
  state.insightFormInitialized = true;
  $('#insightForm input[name="inputFile"]').value='kb://all';
  renderInsightStatus();
});
$('#insightRole')?.addEventListener('change',()=>{state.insightHistoryVisible=false;renderInsightStatus();void loadInsight(false);});

function updateCollectionMode(){
  const hybrid=$('#taskForm select[name="transportMode"]').value==='http_preferred_browser_fallback';
  for(const input of document.querySelectorAll('#platformChecks input'))if(['jobonline','job51','liepin'].includes(input.value)){input.disabled=!hybrid;if(!hybrid)input.checked=false;}
}
$('#taskForm select[name="transportMode"]').addEventListener('change',updateCollectionMode);
updateCollectionMode();
const collectionKeywords=installCollectionKeywords($('#taskForm'),{api});
$('#taskForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if(collectionKeywords.busy)return;
  const taskForm=event.currentTarget;
  const form = new FormData(taskForm);
  const body = Object.fromEntries(form.entries());
  body.label=body.label.trim();
  body.primaryKeyword=body.label;
  body.platforms = form.getAll('platforms');
  body.cities = form.getAll('cities');
  body.interviewEnabled = true;
  try {
    if (body.platforms.includes('boss') && !(await api('/api/state')).capabilities?.bossCollection) throw new Error('BOSS接入需要更新服务，请在当前采集停止后重启控制台');
    if(body.transportMode==='http_preferred_browser_fallback'&&!(await api('/api/state')).capabilities?.hybridCollection)throw new Error('请先更新并重启采集服务，当前服务不支持浏览器回退');
    const data = await api('/api/tasks', { method: 'POST', body: JSON.stringify(body) });
    state.selectedId = data.task.id;
    $('#taskDialog').close();
    taskForm.reset();
    document.querySelectorAll('#platformChecks input').forEach((input) => { input.checked = ['shixiseng','iguopin','mohrss','zhaopin'].includes(input.value); });
    updateCollectionMode();
    document.querySelectorAll('#cityChecks input').forEach((input) => { input.checked = !['天津', '重庆', '苏州'].includes(input.value); });
    toast('任务已创建');
    refresh();
  } catch (error) { toast(error.message, true); }
});

$('#insightForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button=$('#runInsight');if(button.dataset.submitting==='true'||state.insight?.status==='running'||state.insight?.globalRunning)return;
  const body = Object.fromEntries(new FormData(event.currentTarget).entries());
  body.inputFile = 'kb://all';
  body.analysisMode = 'full';
  body.sheetName = '岗位数据';
  try {
    if(button.dataset.analysisReady!=='true'||button.dataset.classifierSource!==body.inputFile)throw new Error('目标岗位尚无可用模型，请先新增岗位并完成训练');
    body.classifierMode=button.dataset.classifierMode||'qualified';
    if(body.classifierMode==='candidate-trial')body.classifierRunId=button.dataset.classifierRunId;
    button.dataset.submitting='true';renderInsightStatus();
    if (!(await api('/api/state')).capabilities?.insightSourceRole) throw new Error('岗位来源自动识别需要重启更新后的服务；本轮尚未启动分析');
    const data = await api('/api/insights/run', { method: 'POST', body: JSON.stringify(body), timeoutMs:120000 });
    toast(data.message || '岗位分析已启动');
    await loadInsight(false);
  } catch (error) { toast(error.message, true); }
  finally{delete button.dataset.submitting;renderInsightStatus();}
});

installInsightClassifier({api,toast});
installInsightTrainingQueue({api,toast});
installInsightDiscovery({api,toast});
installSemanticCloud({api,toast});
restoreRoute();
state.timer = setInterval(() => {
  if (document.hidden) return;
  if (state.view === 'tasks'&&!state.tasksError) refresh(true);
  if (state.view === 'insights') loadInsight(true);
}, 3000);
state.logTimer = setInterval(() => {
  if (document.hidden) return;
  if (state.view === 'tasks') loadLog();
}, 2000);
