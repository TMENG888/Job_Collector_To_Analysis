import {cohortConditionValue} from './insight-cohorts.js';
import { patchHtml, updateLog } from './dom-updates.js';
import {renderInsightWorkspace} from './insight-dashboard.js?v=20261024-concrete-skills';
import {installWordCloudInteractions} from './insight-wordcloud.js';
import {loadJobAssistant} from './job-assistant.js?v=20261022-interview-retrieval';
import {installSkillTermReview} from './skill-term-review.js';
installWordCloudInteractions();
import {mergeLiveProgress, collectionProgress} from './collection-progress.js';
import {renderCollectionDashboard} from './collection-dashboard.js?v=20261026-verification-state';
import {formatCollectionFlowLog} from './collection-flow-log.js?v=20261022-flow-log';
import {renderInterviewPanel,installInterviewTools} from './interview-tools.js?v=20261023-interview-unlimited';
import { fetchJsonWithTimeout } from './http-client.js';
import { localPathKey, finalDatasetCatalog, selectLegacyTaskDataset,resolveLatestInsightSource } from './insight-transfer.js';
import {loadInsightCatalog,populateInsightPickers} from './insight-dataset-picker.js';
import {installInsightClassifier} from './insight-classifier.js?v=20261023-trial-workflow';
import {insightReportContext} from './insight-classifier-state.js?v=20261023-trial-workflow';
import {installSemanticCloud} from './insight-semantic.js?v=20261024-concrete-skills';
import {installJobBrowserWorkspace} from './browser-workspace.js?v=20261019-interaction-fix-9';
import {installPersonalWiki} from './personal-wiki.js?v=20261022-single-organizer';
const state = { tasks: [], selectedId: null, insight: null, insightDatasets: [], insightRenderKey: null, insightFormInitialized: false, insightDatasetRequest: 0, view: 'tasks', timer: null, logTimer: null };
const normalizedLocalPath = (value) => String(value || '').trim().replaceAll('/', '\\').toLowerCase();
const $ = (selector) => document.querySelector(selector);
const number = (value) => new Intl.NumberFormat('zh-CN').format(Number(value || 0));
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const stageLabel = { collection: '多平台采集', public: '多平台采集', zhaopin: '多平台采集', yupao: '多平台采集', boss: '多平台采集', login_boss: 'BOSS登录', login_zhaopin: '智联登录', login_yupao: '鱼泡验证', finalize: '导出交付', workbook: '导出交付' };
const statusLabel = { ready: '待启动', running: '运行中', completed: '已完成', partial: '未达目标', failed: '需处理', paused: '已暂停', stopping: '停止中' };
const platformLabel = { shixiseng: '实习僧', iguopin: '国聘', mohrss: '公共招聘网', job51: '前程无忧', jobonline: '就业在线', zhaopin: '智联招聘', liepin:'猎聘', yupao: '鱼泡直聘', boss: 'BOSS直聘' };
const authLabels={unknown:'未确认',saved_unverified:'会话已保存，未验证登录',human_confirmed:'人工已确认',login_required:'需要登录'};
const verificationLabels={unchecked:'未检查',waiting_human:'等待人工验证',clear:'当前页面通过',session_closed:'会话已关闭'};
const pendingGets = new Map();
async function api(url, options = {}) {
  const readOnly = !options.method || options.method === 'GET';
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
  const completed = state.tasks.filter((task) => task.status === 'completed').length;
  const rows = state.tasks.reduce((sum, task) => sum + (task.metrics.knowledgeRows??task.metrics.finalRows), 0);
  const candidates = state.tasks.reduce((sum, task) => sum + task.metrics.candidates, 0);
  patchHtml($('#stats'), [
    ['任务总数', state.tasks.length, ''],
    ['正在运行', running, running ? '请勿同时启动多个登录渠道' : '当前无活动进程'],
    ['已完成任务', completed, ''],
    ['去重入库量', number(rows), `采集候选 ${number(candidates)} 条`],
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
      <div class="task-row"><strong>${escapeHtml(task.label)}</strong><span class="badge ${task.status}">${task.collectUntilExhausted&&task.status==='partial'?'本轮受阻或预算暂停':task.collectUntilExhausted&&task.status==='completed'?'本轮条件已处理':statusLabel[task.status] || task.status}</span></div>
      <div class="task-meta"><span>${task.collectUntilExhausted?`已入库 ${number(task.metrics.knowledgeRows??0)} 条`:task.metrics.hasFinalResult ? `${number(task.metrics.finalRows)} / ${number(task.targetRows)}` : '尚未生成最终结果'} · 候选 ${number(task.metrics.candidates)}</span><span>${escapeHtml(task.currentStage ? stageLabel[task.currentStage] : String(task.message||'').split('；已取消原目标条数')[0])}</span></div>
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

function renderDetail() {
  const task = state.tasks.find((item) => item.id === state.selectedId);
  if (!task) {
    $('#detail').dataset.taskId = '';
    patchHtml($('#detail'), '<div class="empty-state"><h2>未找到采集任务</h2><p>请选择一个现存任务，或检查链接中的任务 ID。</p></div>');
    return;
  }
  if ($('#detail').dataset.taskId !== task.id) { $('#detail').replaceChildren(); $('#detail').dataset.taskId = task.id; }
  const isRunning = ['running', 'stopping'].includes(task.status);
  const taskMessage = String(task.message || '').split('；已取消原目标条数')[0];
  const chips = [...task.platforms.map((key) => platformLabel[key]), ...task.cities.slice(0, 5), task.pace === 'safe' ? '稳健节奏' : task.pace === 'fast' ? '较快节奏' : '均衡节奏'];
  patchHtml($('#detail'), `
    <div class="detail-head">
      <div class="detail-title"><div><h2>${escapeHtml(task.label)}</h2><p>${escapeHtml(task.status==='running' && task.currentStage ? `${stageLabel[task.currentStage]}进行中` : taskMessage)}</p></div><span class="badge ${task.status}">${statusLabel[task.status] || task.status}</span></div>
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
      ${task.pausedPlatforms?.length?'<p role="status">暂停渠道（数据与断点保留）：'+task.pausedPlatforms.map(item=>escapeHtml((platformLabel[item.key]||item.key)+'：'+item.reason)).join('；')+'</p>':''}
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
  const view = new URLSearchParams(location.search).get('view') === 'assistant' ? 'assistant' : ['tasks', 'insights','browser','profile'].includes(parts[0]) ? parts[0] : 'tasks';
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
  const titles = { tasks: '采集任务', insights: '岗位洞察', assistant: '求职助手',browser:'求职浏览器',profile:'个人 Wiki 与简历库' };
  $('#pageTitle').textContent = titles[view];
  $('#newTaskBtn').classList.toggle('hidden', ['insights', 'assistant','browser','profile'].includes(view));
  $('#newTaskBtn').innerHTML = '<span>＋</span> 新建采集任务';
  if (options.history !== false) syncRoute();
  if (view === 'tasks') refresh(false);
  if (view === 'insights') { loadInsightDatasets(); loadInsight(false); }
  if (view === 'assistant') loadJobAssistant();
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

async function loadInsightDatasets() {
  const select = $('#insightDataset');
  if (!select) return;
  const requestId = ++state.insightDatasetRequest;
  const errorBox=$('#insightDatasetError'),retry=$('#retryInsightDatasets');
  if(retry)retry.disabled=true;
  try {
    const datasets = await loadInsightCatalog(api);
    if (requestId !== state.insightDatasetRequest) return;
    state.insightDatasets = datasets;
    populateInsightPickers(document,datasets);
    if(errorBox){errorBox.hidden=true;errorBox.querySelector('span').textContent='';}
  } catch (error) {
    if(requestId!==state.insightDatasetRequest)return;
    // Retain the last usable choices and the user's kb:// source on failure.
    if(!state.insightDatasets.length)select.innerHTML='<option value="">数据源目录暂不可用</option>';
    if(errorBox){errorBox.querySelector('span').textContent=`数据源加载失败：${error.message}`;errorBox.hidden=false;}
  } finally {if(requestId===state.insightDatasetRequest&&retry)retry.disabled=false;}
}

$('#retryInsightDatasets')?.addEventListener('click',()=>loadInsightDatasets());

function renderInsightStatus() {
  const transfer = state.insightTransfer;
  $('#insightRoleSource').textContent = '';
  $('#insightTransferSource').textContent = transfer ? `来源：${transfer.role} · ${transfer.expectedRows ? `${number(transfer.expectedRows)} 条` : '条数待读取'}${transfer.collecting?' · 采集中':''}` : '';
  const insight = state.insight || { status: 'empty', message: '尚未生成岗位市场洞察' };
  const status = $('#insightStatus');
  const report = insight.report;
  const context=insightReportContext({report,inputFile:$('#insightForm input[name="inputFile"]').value,running:insight.status==='running',normalize:normalizedLocalPath});
  const completedMessage = report && insight.status === 'completed' ? `${report.experimental?'[试分析 · 候选未达标] ':''}${report.detected_role?.name || report.role || '岗位'}分析完成：${number(report.sample_rows)}/${number(report.total_rows)} 条` : insight.message;
  const updatedAt = report?.generated_at || insight.updatedAt;
  status.classList.toggle('insight-report-stale',context.hideReport);
  status.innerHTML = `<div class="insight-run-state ${escapeHtml(insight.status)}"><span class="pulse"></span><div><b>${escapeHtml(context.title||completedMessage)}</b><small>${context.hideReport?'上次报告与当前数据集不同':insight.status === 'running' ? `已运行 ${number(insight.runningSeconds)} 秒` : updatedAt ? `最近更新 ${new Date(updatedAt).toLocaleString('zh-CN')}` : '选择数据后生成分析'}</small></div></div>`;
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
    const ready=button.dataset.analysisReady==='true'&&button.dataset.classifierSource===$('#insightForm input[name="inputFile"]').value;
    const running=insight.status==='running'||button.dataset.submitting==='true';
    button.disabled = running||!ready;
    button.textContent = running ? '分析运行中…' : button.dataset.classifierMode==='candidate-trial'?'生成全量试分析':'生成全量分析';
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
  container.innerHTML=(report.experimental?'<p class="insight-trial-banner" role="note">试分析 · 分类器未通过验收，结果仅供探索，未发布为正式知识库分析。</p>':'')+'<div id="cohortExplorer"></div>';
  disposeInsightWorkspace=renderInsightWorkspace($('#cohortExplorer'),report,{drawCityMap,drawCityDetail});
}

const cityMapCodes = {北京:110000,天津:120000,上海:310000,重庆:500000,广州:440100,深圳:440300,杭州:330100,成都:510100,武汉:420100,南京:320100,苏州:320500,西安:610100,长沙:430100,合肥:340100,郑州:410100,济南:370100,青岛:370200,厦门:350200,福州:350100,无锡:320200,宁波:330200,东莞:441900,佛山:440600,珠海:440400,昆明:530100,沈阳:210100,大连:210200};
let cityDetailRevision = 0;
async function drawCityDetail(city, rows) {
  const revision = ++cityDetailRevision;
  $('#cityMapDetail')?.remove();
  const host = document.createElement('section');host.id='cityMapDetail';host.className='card insight-panel';
  ($('#insightCityDetail')||$('#cohortExplorer')).append(host);
  host.innerHTML = `<h3>${escapeHtml(city)}行政区分布</h3><p>正在读取市级行政区边界…</p>`;
  try {
    if (!cityMapCodes[city]) throw new Error('当前城市暂无已缓存的行政边界');
    const res=await fetch(`/maps/${cityMapCodes[city]}.geojson`);if(!res.ok)throw new Error('边界暂不可用');
    const geo=await res.json();if(revision!==cityDetailRevision || !host.isConnected || $('#cohortCity')?.value!==city)return;
    orientMap(geo);
    const districtRows=rows.filter(r=>r.district);
    const districtCounts = new Map();
    for (const feature of geo.features) districtCounts.set(feature.properties.name, rows.filter(r=>r.district===feature.properties.name).length);
    const located=[...districtCounts.values()].reduce((a,b)=>a+b,0);
    host.innerHTML=`<h3>${escapeHtml(city)}行政区分布</h3><p>当前 ${number(rows.length)} 条岗位；有明确且匹配的区县 ${number(located)} 条，区县未明确或未匹配 ${number(rows.length-located)} 条。${located ? '颜色深浅表示有明确区县的岗位数量。' : '仅展示行政边界，未将城市总数分摊到区县。'}</p><div class="city-map" id="cityDistrictMap"></div>`;
    const svg=window.d3.select('#cityDistrictMap').append('svg').attr('viewBox','0 0 760 400');
    const projection=window.d3.geoMercator().fitExtent([[20,20],[740,380]],geo);const path=window.d3.geoPath(projection);
    const max=Math.max(1,...districtCounts.values());
    svg.selectAll('path').data(geo.features).join('path').attr('class','map-region').attr('fill',f=>districtCounts.get(f.properties.name)?window.d3.interpolateGreens(.3+.6*districtCounts.get(f.properties.name)/max):'#edf5f3').style('fill',f=>districtCounts.get(f.properties.name)?window.d3.interpolateGreens(.3+.6*districtCounts.get(f.properties.name)/max):'#edf5f3').attr('d',path).append('title').text(f=>`${f.properties.name}：${districtCounts.get(f.properties.name)} 条明确区县岗位`);
    svg.selectAll('text').data(geo.features).join('text').attr('transform',f=>`translate(${path.centroid(f)})`).attr('text-anchor','middle').attr('font-size',10).text(f=>f.properties.name);
  } catch(error) { if(revision===cityDetailRevision)host.innerHTML=`<h3>${escapeHtml(city)}行政区分布</h3><p>${escapeHtml(error.message)}；城市岗位统计仍可查看。</p>`; }
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

let cityMapRevision=0,cityMapGeometryPromise=null;
function cityMapGeometry(){
  if(!cityMapGeometryPromise)cityMapGeometryPromise=Promise.all(['/china-provinces.geojson','/maps/cities.geojson'].map(async url=>{const response=await fetch(url);if(!response.ok){if(url.includes('cities'))return {features:[]};throw new Error('行政区边界数据不可用');}return response.json();})).catch(error=>{cityMapGeometryPromise=null;throw error;});
  return cityMapGeometryPromise;
}
async function drawCityMap(cities) {
  const revision=++cityMapRevision;
  const container = $('#cityMap');
  if (!container) return;
  if (!window.d3) { container.textContent = '地图组件未加载，城市排名仍可正常使用。'; return; }
  try {
    const geometry=await cityMapGeometry();
    if(revision!==cityMapRevision||!container.isConnected)return;
    const [geo,cityGeo]=structuredClone(geometry);container.replaceChildren();
    // DataV follows the GeoJSON right-hand winding convention, while d3-geo
    // interprets spherical polygon winding in the opposite direction.
    orientMap(geo);
    const width = 760; const height = 470;
    const svg = window.d3.select(container).append('svg').attr('viewBox', `0 0 ${width} ${height}`).attr('role', 'img').attr('aria-label', '中国城市岗位样本分布');
    const projection = window.d3.geoMercator().fitExtent([[18, 18], [width - 18, height - 18]], geo);
    const pathGenerator = window.d3.geoPath(projection);
    svg.selectAll('path').data(geo.features).join('path').attr('class', 'map-region').attr('d', pathGenerator);
    orientMap(cityGeo);svg.selectAll('path.city-boundary').data(cityGeo.features.filter(f=>cities.some(c=>c.name===f.properties.name))).join('path').attr('class','map-region city-boundary').attr('d',pathGenerator).attr('tabindex',0).attr('role','button').attr('aria-label',f=>`查看${f.properties.name}岗位`).on('click',(_,f)=>selectMapCity(f.properties.name)).on('keydown',(event,f)=>{if(event.key==='Enter')selectMapCity(f.properties.name);});
    const visible = cities.filter((item) => Number.isFinite(item.longitude) && Number.isFinite(item.latitude));
    const radius = window.d3.scaleSqrt().domain([1, window.d3.max(visible, (item) => item.count) || 1]).range([4, 18]);
    const marks = svg.selectAll('g.city-mark').data(visible).join('g').attr('class', 'city-mark').attr('transform', (item) => `translate(${projection([item.longitude, item.latitude]).join(',')})`);
    marks.attr('tabindex',0).attr('role','button').attr('aria-label',item=>`查看${item.name}岗位`).on('click',(_,item)=>selectMapCity(item.name)).on('keydown',(event,item)=>{if(event.key==='Enter')selectMapCity(item.name);});
    marks.append('circle').attr('r', (item) => radius(item.count)).append('title').text((item) => `${item.name}：${item.count} 条；薪资中位数 ${item.median_salary_k == null ? '样本不足' : `${item.median_salary_k}K/月`}`);
    marks.filter((item, index) => index < 8).append('text').attr('x', (item) => radius(item.count) + 4).attr('y', 4).text((item) => item.name);
  } catch (error) { if(revision===cityMapRevision&&container.isConnected)container.textContent = `地图暂不可用：${error.message}`; }
}

function selectMapCity(city) {
  const select=$('#cohortCity');if(!select)return;
  // Map and ranking operate inside the current linked filter scope.
  const value=cohortConditionValue({city},'city');
  if(![...select.options].some(option=>option.value===value))return;
  select.value=value;select.dispatchEvent(new Event('change'));$('#insightOverviewSection')?.scrollIntoView({behavior:'smooth',block:'start'});
}

function insightReportKey(report) {
  if (!report) return 'empty';
  return [report.version, report.generated_at, report.topic_model?.display_model?.updated_at, report.input_file, report.sheet_name, report.analysis_mode, report.sample_rows].join('|');
}

function renderInsight() {
  renderInsightStatus();
  const nextKey = insightReportKey(state.insight?.report);
  if (nextKey === state.insightRenderKey) return;
  state.insightRenderKey = nextKey;
  renderInsightDashboard();
}

async function loadInsight(silent = true) {
  if(state.insightLoading)return;
  state.insightLoading=true;
  try {
    const next=await api('/api/insights?summary=1');
    const report=!next.reportVersion?null:next.reportVersion===state.insight?.reportVersion?state.insight.report:await api('/api/insights/report',{timeoutMs:60000});
    state.insight = {...next,report};
    if(!state.insightFormInitialized && state.insight.report) {
      const report=state.insight.report;
      // The previous report is a result, not the default source for a new analysis.
      $('#insightForm input[name="inputFile"]').value='kb://all';
      state.insightFormInitialized=true;
      await loadInsightDatasets();
    }
    renderInsight();
  } catch (error) { if (!silent) toast(error.message, true); }
  finally{state.insightLoading=false;}
}

async function refresh(silent = true) {
  if (state.tasksLoading) return;
  state.tasksLoading = true;
  try {
    const data = await api('/api/tasks');
    state.tasks = data.tasks;
    try {
      const unified=await api(`/unified-progress.json?t=${Date.now()}`);
      if(Date.now()-Date.parse(unified.updatedAt)<45000)state.tasks=state.tasks.map(task=>{
        const report=unified.tasks?.[task.id];
        return report?.task_id===task.id?{...task,metrics:{...task.metrics,unifiedDataset:report}}:task;
      });
    } catch {}
    // Static compatibility snapshot keeps the running collector untouched.
    // Native server metrics take precedence after a normal service restart.
    if (state.tasks.some(task=>!task.metrics.liveCollection)) {
      try {
        const snapshot = await api(`/live-progress.json?t=${Date.now()}`);
        state.tasks = mergeLiveProgress(state.tasks,snapshot);
      } catch {}
    }
    if (state.view !== 'tasks') return;
    if (!state.selectedId && state.tasks.length) state.selectedId = state.tasks[0].id;
    syncRoute(true);
    render();
    if (state.selectedId && !$('#taskLog')?._logLoaded) loadLog();
  } catch (error) { if (!silent) toast(error.message, true); }
  finally { state.tasksLoading = false; }
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
    const verificationAction=action.match(/^verify-(open|finish|close|recheck|session)-(job51|liepin)$/);
    if(verificationAction){
      const [,operation,platform]=verificationAction,key=task.id+':'+platform;
      if(pendingVerifications.has(key))return;
      pendingVerifications.add(key);
      const controls=[...document.querySelectorAll('button.channel-verify-control,button.channel-verify-trigger')].filter(button=>button.dataset.action?.endsWith('-'+platform));
      const labels=controls.map(button=>button.textContent);
      controls.forEach(button=>{button.disabled=true;button.setAttribute('aria-busy','true');if(button.dataset.action===action)button.textContent=operation==='recheck'?'复检中…':'处理中…';});
      try{
        const opening=operation==='open'||operation==='session';
        const options={mode:operation==='session'?'collector':'ordinary',browserId:'edge'};
        if(opening){
          const capabilities=await api('/api/channel-verification/capabilities').catch(()=>null);
          if(!capabilities?.ordinaryBrowser)throw Error('普通浏览器入口需要重启后台生效；已阻止旧版打开受管理窗口');
        }
        const data=await api(`/api/tasks/${encodeURIComponent(task.id)}/channels/${platform}/verification/${opening?'open':operation}`,{method:'POST',body:JSON.stringify(opening?options:{}),timeoutMs:60000});
        toast(data.message);await refresh();
      }finally{pendingVerifications.delete(key);controls.forEach((button,i)=>{if(button.isConnected){button.disabled=false;button.removeAttribute('aria-busy');button.textContent=labels[i];}});}
      return;
    }
    if(action==='export-latest'){
      const data=await api(`/api/tasks/${encodeURIComponent(task.id)}/export-latest`,{method:'POST',body:'{}'});
      toast(data.message);return refresh();
    }
    if (action === 'insights') {
      await loadInsightDatasets();
      let dataset;
      try { dataset = await resolveLatestInsightSource(task,api); }
      catch (error) { if (error.status !== 404) throw error; dataset = selectLegacyTaskDataset(task, state.insightDatasets); }
      state.insightFormInitialized = true;
      state.insightTransfer = { taskId: task.id, role: task.label, ...dataset };
      $('#insightForm input[name="inputFile"]').value = dataset.path;
      switchView('insights');
      $('#insightForm').scrollIntoView({ behavior: 'smooth' });
      toast(dataset.requiresManualSource?`已对接 ${task.label} 的最新导出CSV；点击“生成全量分析”时校验并读取文件`:`已选择 ${task.label} 的${dataset.resolution==='knowledge'?'已入库中间':dataset.resolution==='latest_snapshot'?'最新候选':'交付'}数据${dataset.expectedRows ? ` ${number(dataset.expectedRows)} 条` : ''}${dataset.updatedAt?'；更新于 '+new Date(dataset.updatedAt).toLocaleString('zh-CN'):''}${dataset.collecting ? '；采集更新后需重新生成' : ''}`);
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
      if (!confirm('仅从控制台列表移除该任务，采集数据不会删除。继续吗？')) return;
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
installInterviewTools({api,toast,refresh,getTask:()=>state.tasks.find(task=>task.id===state.selectedId),escapeHtml,number});
// Mark edits immediately, before any delayed initial report can restore fields.
for (const eventName of ['input', 'change']) $('#insightForm').addEventListener(eventName, () => {
  state.insightFormInitialized = true;
  if (state.insightTransfer && localPathKey($('#insightForm input[name="inputFile"]').value) !== localPathKey(state.insightTransfer.path)) state.insightTransfer = null;
  renderInsightStatus();
});
$('#insightDataset').addEventListener('change', (event) => {
  if (event.currentTarget.value) $('#insightForm input[name="inputFile"]').value = event.currentTarget.value;
  const selected=state.insightDatasets.find(item=>item.path===event.currentTarget.value);
  state.insightTransfer=null;
  state.insightHistoryVisible=false;
  if(['latest_snapshot','knowledge'].includes(selected?.resolution)){
    state.insightTransfer={...selected,role:selected.role};
    renderInsightStatus();
  }
  
});

function updateCollectionMode(){
  const hybrid=$('#taskForm select[name="transportMode"]').value==='http_preferred_browser_fallback';
  for(const input of document.querySelectorAll('#platformChecks input'))if(['jobonline','job51','liepin'].includes(input.value)){input.disabled=!hybrid;if(!hybrid)input.checked=false;}
  for(const input of document.querySelectorAll('#taskForm input[name="browserMaxPages"],#taskForm input[name="browserMaxRows"]'))input.disabled=!hybrid;
}
$('#taskForm select[name="transportMode"]').addEventListener('change',updateCollectionMode);
updateCollectionMode();
$('#taskForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const body = Object.fromEntries(form.entries());
  body.platforms = form.getAll('platforms');
  body.cities = form.getAll('cities');
  body.interviewEnabled = true;
  try {
    if (body.platforms.includes('boss') && !(await api('/api/state')).capabilities?.bossCollection) throw new Error('BOSS接入需要更新服务，请在当前采集停止后重启控制台');
    if(body.transportMode==='http_preferred_browser_fallback'&&!(await api('/api/state')).capabilities?.hybridCollection)throw new Error('请先更新并重启采集服务，当前服务不支持浏览器回退');
    if (body.platforms.includes('liepin') && body.transportMode!=='http_preferred_browser_fallback' && !(await api('/api/state')).capabilities?.liepinCollection) throw new Error('猎聘独立 HTTP 尚未验证，请改用浏览器页面试验模式');
    const data = await api('/api/tasks', { method: 'POST', body: JSON.stringify(body) });
    state.selectedId = data.task.id;
    $('#taskDialog').close();
    event.currentTarget.reset();
    document.querySelectorAll('#platformChecks input').forEach((input) => { input.checked = ['shixiseng','iguopin','mohrss','zhaopin'].includes(input.value); });
    updateCollectionMode();
    document.querySelectorAll('#cityChecks input').forEach((input) => { input.checked = !['天津', '重庆', '苏州'].includes(input.value); });
    toast('任务已创建');
    refresh();
  } catch (error) { toast(error.message, true); }
});

$('#insightForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button=$('#runInsight');if(button.dataset.submitting==='true'||state.insight?.status==='running')return;
  const body = Object.fromEntries(new FormData(event.currentTarget).entries());
  body.analysisMode = 'full';
  body.sheetName = '岗位数据';
  if (state.insightTransfer && !state.insightTransfer.requiresManualSource && localPathKey(body.inputFile) === localPathKey(state.insightTransfer.path) && state.insightTransfer.taskId) body.sourceTaskId = state.insightTransfer.taskId;
  try {
    if(button.dataset.analysisReady!=='true'||button.dataset.classifierSource!==body.inputFile)throw new Error('当前数据集尚无可用模型，请先完成标注与训练');
    body.classifierMode=button.dataset.classifierMode||'qualified';
    if(body.classifierMode==='candidate-trial')body.classifierRunId=button.dataset.classifierRunId;
    button.dataset.submitting='true';renderInsightStatus();
    if (!(await api('/api/state')).capabilities?.insightSourceRole) throw new Error('岗位来源自动识别需要重启更新后的服务；本轮尚未启动分析');
    const data = await api('/api/insights/run', { method: 'POST', body: JSON.stringify(body) });
    toast(data.message || '岗位分析已启动');
    await loadInsight(false);
  } catch (error) { toast(error.message, true); }
  finally{delete button.dataset.submitting;renderInsightStatus();}
});

installSkillTermReview({api,toast});
installInsightClassifier({api,toast});
installJobBrowserWorkspace({api,toast});
installPersonalWiki({api,toast});
installSemanticCloud({api,toast});
restoreRoute();
state.timer = setInterval(() => {
  if (document.hidden) return;
  if (state.view === 'tasks') refresh(true);
  if (state.view === 'insights') loadInsight(true);
}, 3000);
state.logTimer = setInterval(() => {
  if (document.hidden) return;
  if (state.view === 'tasks') loadLog();
}, 2000);
