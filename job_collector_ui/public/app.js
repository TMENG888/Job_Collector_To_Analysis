import { summarizeCohort, cohortConditionValue, filterCohort, cohortFilterOptions, cohortSalaryStatistics } from './insight-cohorts.js';
import { patchHtml, updateLog } from './dom-updates.js';
import { fetchJsonWithTimeout } from './http-client.js';
import { localPathKey, finalDatasetCatalog, selectLegacyTaskDataset } from './insight-transfer.js';
const state = { tasks: [], selectedId: null, platforms: [], labelJobs: [], selectedLabelId: null, insight: null, insightDatasets: [], insightRenderKey: null, insightFormInitialized: false, insightDatasetRequest: 0, insightLabelRequest: 0, view: 'tasks', timer: null, logTimer: null };
const normalizedLocalPath = (value) => String(value || '').trim().replaceAll('/', '\\').toLowerCase();
const $ = (selector) => document.querySelector(selector);
const number = (value) => new Intl.NumberFormat('zh-CN').format(Number(value || 0));
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const stageLabel = { public: '公开渠道', zhaopin: '智联采集', yupao: '鱼泡采集', boss: 'BOSS采集', login_boss: 'BOSS登录', login_zhaopin: '智联登录', login_yupao: '鱼泡验证', finalize: '合并去重', workbook: 'Excel导出' };
const statusLabel = { ready: '就绪', running: '运行中', completed: '已完成', partial: '未达目标', failed: '需处理', paused: '已暂停', stopping: '停止中' };
const platformLabel = { shixiseng: '实习僧', iguopin: '国聘', mohrss: '公共招聘网', job51: '前程无忧', jobonline: '就业在线', zhaopin: '智联招聘', yupao: '鱼泡直聘', boss: 'BOSS直聘' };
const loginStatusLabel = { not_logged_in: '未保存', opening: '正在打开', saved: '会话已保存',browser_open:'共享浏览器已开启' };
const authLabels={unknown:'未确认',saved_unverified:'会话已保存，未验证登录',human_confirmed:'人工已确认',login_required:'需要登录'};
const verificationLabels={unchecked:'未检查',waiting_human:'等待人工验证',clear:'当前页面通过',session_closed:'会话已关闭'};
const pendingGets = new Map();
const pendingPlatformLogins = new Set();
let switchingYupaoBrowser = false;
function browserSwitchReason(item){
  if(typeof item.canSwitchBrowser!=='boolean')return '当前服务尚未加载浏览器切换功能，请重启 8788 控制台服务后刷新页面';
  if(switchingYupaoBrowser)return '正在迁移 Cookie，请等待新浏览器打开';
  if(!item.browserOpen)return '请先打开鱼泡登录浏览器，并保持窗口开启，再切换到新实例';
  if(!item.canSwitchBrowser)return '鱼泡登录或采集正在运行，请等待登录完成或暂停采集后再切换';
  return '';
}

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
  const current = task.metrics.hasFinalResult ? task.metrics.finalRows : 0;
  return Math.min(100, Math.round((current / task.targetRows) * 100));
}

function renderStats() {
  const running = state.tasks.filter((task) => ['running', 'stopping'].includes(task.status)).length;
  const completed = state.tasks.filter((task) => task.status === 'completed').length;
  const rows = state.tasks.reduce((sum, task) => sum + task.metrics.finalRows, 0);
  const candidates = state.tasks.reduce((sum, task) => sum + task.metrics.candidates, 0);
  patchHtml($('#stats'), [
    ['任务总数', state.tasks.length, '独立配置与输出目录'],
    ['正在运行', running, running ? '请勿同时启动多个登录渠道' : '当前无活动进程'],
    ['已交付任务', completed, '已完成 Excel 导出'],
    ['最终数据量', number(rows), `候选池 ${number(candidates)} 条`],
  ].map(([label, value, note]) => `<div class="stat"><span>${label}</span><strong>${value}</strong><em>${note}</em></div>`).join(''));
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
      <div class="task-row"><strong>${escapeHtml(task.label)}</strong><span class="badge ${task.status}">${statusLabel[task.status] || task.status}</span></div>
      <div class="task-meta"><span>${task.metrics.hasFinalResult ? `${number(task.metrics.finalRows)} / ${number(task.targetRows)}` : '尚未生成最终结果'} · 候选 ${number(task.metrics.candidates)}</span><span>${escapeHtml(task.currentStage ? stageLabel[task.currentStage] : task.message)}</span></div>
      <div class="mini-progress"><i style="width:${value}%"></i></div>
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
  const value = progress(task);
  const chips = [...task.platforms.map((key) => platformLabel[key]), ...task.cities.slice(0, 5), task.pace === 'safe' ? '稳健节奏' : task.pace === 'fast' ? '较快节奏' : '均衡节奏'];
  patchHtml($('#detail'), `
    <div class="detail-head">
      <div class="detail-title"><div><h2>${escapeHtml(task.label)}</h2><p>${escapeHtml(task.message)}${task.currentStage ? ` · ${stageLabel[task.currentStage]}` : ''}</p></div><span class="badge ${task.status}">${statusLabel[task.status] || task.status}</span></div>
      <div class="detail-actions">
        ${task.browserSession?.verification_status==='waiting_human'?'<button class="primary" data-action="confirm-verification">已人工验证，继续当前会话</button>':''}
        <button class="primary" data-action="all" ${isRunning ? 'disabled' : ''}>▶ 全部运行</button>
        <button class="ghost" data-action="public" ${isRunning ? 'disabled' : ''}>采集公开渠道</button>
        <button class="ghost" data-action="zhaopin" ${isRunning ? 'disabled' : ''}>采集 / 续爬智联</button>
        <button class="ghost" data-action="yupao" ${isRunning ? 'disabled' : ''}>采集 / 续爬鱼泡</button>
        ${task.platforms.includes('boss') ? `<button class="ghost" data-action="boss" ${isRunning ? 'disabled' : ''}>采集 / 续爬BOSS（试验）</button>` : ''}
        <button class="ghost" data-action="finalize" ${isRunning ? 'disabled' : ''}>合并去重</button>
        <button class="ghost" data-action="workbook" ${isRunning ? 'disabled' : ''}>导出 Excel</button>
        <button class="danger" data-action="pause" ${!isRunning || task.status === 'stopping' ? 'disabled' : ''}>暂停</button>
        <button class="ghost" data-action="open">打开文件夹</button>
        <button class="secondary" data-action="insights">用于岗位洞察</button>
        <button class="secondary" data-action="labels">创建AI打标</button>
      </div>
    </div>
    <div class="detail-body">
      ${task.browserSession?`<p>登录状态：${escapeHtml(authLabels[task.browserSession.login_status]||'未确认')} · 验证状态：${escapeHtml(verificationLabels[task.browserSession.verification_status]||'未检查')}</p>`:''}
      <div class="progress-wrap"><div><div class="progress-info"><span>交付完成度</span><span>${task.metrics.hasFinalResult ? `${number(task.metrics.finalRows)} / ${number(task.targetRows)}` : '本任务尚未生成最终结果'}</span></div><div class="progress"><i style="width:${value}%"></i></div></div><div class="progress-number">${value}%</div></div>
      <div class="metric-grid">
        <div class="metric"><small>公开渠道</small><b>${number(task.metrics.publicRows)}</b></div>
        <div class="metric"><small>智联候选</small><b>${number(task.metrics.zhaopinRows)}</b></div>
        <div class="metric"><small>鱼泡候选</small><b>${number(task.metrics.yupaoRows)}</b></div>
        ${task.platforms.includes('boss') ? `<div class="metric"><small>BOSS候选</small><b>${number(task.metrics.bossRows)}</b></div>` : ''}
        <div class="metric"><small>候选总量</small><b>${number(task.metrics.candidates)}</b></div>
        <div class="metric"><small>最终结果</small><b>${task.metrics.hasFinalResult ? number(task.metrics.finalRows) : '—'}</b></div>
        <div class="metric"><small>去除重复</small><b>${number(task.metrics.duplicatesRemoved)}</b></div>
      </div>
      <div class="task-config">${chips.filter(Boolean).map((chip) => `<span class="chip">${escapeHtml(chip)}</span>`).join('')}</div>
      <div class="log-head"><h3>实时运行日志</h3><span>${isRunning ? `已运行 ${task.runningSeconds || 0} 秒 · 2秒刷新` : '最近输出'}</span></div>
      <pre class="log" id="taskLog">正在读取日志…</pre>
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
  const id = view === 'labels' ? state.selectedLabelId : view === 'tasks' ? state.selectedId : null;
  return `/${view}${id ? `/${encodeURIComponent(id)}` : ''}`;
}

function syncRoute(replace = false) {
  const route = routePath();
  if (location.pathname !== route) history[replace ? 'replaceState' : 'pushState']({}, '', route);
}

function restoreRoute() {
  const parts = location.pathname.split('/').filter(Boolean);
  const view = ['tasks', 'platforms', 'labels', 'insights'].includes(parts[0]) ? parts[0] : 'tasks';
  const id = parts[1] ? decodeURIComponent(parts[1]) : null;
  if (view === 'labels') state.selectedLabelId = id;
  if (view === 'tasks') state.selectedId = id;
  switchView(view, { history: false });
}

function switchView(view, options = {}) {
  state.view = view;
  document.querySelectorAll('.app-view').forEach((element) => element.classList.add('hidden'));
  $(`#${view}View`).classList.remove('hidden');
  document.querySelectorAll('[data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  const titles = { tasks: '采集任务', platforms: '平台登录', labels: 'AI打标', insights: '岗位洞察' };
  $('#pageTitle').textContent = titles[view];
  $('#newTaskBtn').classList.toggle('hidden', ['platforms', 'insights'].includes(view));
  $('#newTaskBtn').innerHTML = view === 'labels' ? '<span>＋</span> 新建打标任务' : '<span>＋</span> 新建采集任务';
  if (options.history !== false) syncRoute();
  if (view === 'tasks') refresh(false);
  if (view === 'platforms') loadPlatforms(false);
  if (view === 'labels') loadLabels(false);
  if (view === 'insights') { loadInsightDatasets(); loadInsightLabelJobs(); loadInsight(false); }
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

function cohortSalaryMarkup() {
  return `<div class="salary-estimator" id="salaryEstimator">
    <h4>同条件薪资统计</h4>
    <div class="salary-estimate-results">
      <div><span>招聘月薪中位数</span><strong id="salaryEstimateValue">—</strong><small id="salaryEstimateBasis"></small></div>
      <div><span>招聘月薪平均值</span><strong id="salaryEstimateMean">—</strong><small>容易受高薪或低薪岗位影响</small></div>
      <div><span>样本薪资 P25–P75</span><strong id="salaryEstimateRange">—</strong><small>匹配岗位薪资中点的四分位区间，不是预测区间</small></div>
      <div><span>匹配的有效薪资样本</span><strong id="salaryEstimateSupport">—</strong><small id="salaryEstimateReliability"></small></div>
    </div>
    <p class="salary-disclaimer">薪资、技能和技术栈共用上方五项条件；薪资仅统计匹配岗位中3K–200K/月的有效薪资中点，未解析或超范围薪资不参与，但岗位仍计入画像。少于5条有效薪资不显示薪资统计，5–19条提示小样本；不使用技能过滤或模型估价。“不限（不筛选）”包含所有取值；“招聘要求：不限”仅匹配原文不限要求。仅统计当前报告纳入的岗位，不包括待复核或排除岗位；招聘开价不等于实际到手薪资。</p>
  </div>`;
}

function updateCohortSalary(selected) {
  const stats = cohortSalaryStatistics(selected);
  const enough = stats.count >= 5;
  $('#salaryEstimateValue').textContent = enough ? `${stats.median.toFixed(1)}K/月` : '样本不足';
  $('#salaryEstimateMean').textContent = enough ? `${stats.mean.toFixed(1)}K/月` : '—';
  $('#salaryEstimateRange').textContent = enough ? `${stats.p25.toFixed(1)}–${stats.p75.toFixed(1)}K` : '—';
  $('#salaryEstimateSupport').textContent = `${number(stats.count)} 条`;
  $('#salaryEstimateBasis').textContent = enough ? '实际岗位薪资中点中位数 · 同条件统计' : !selected.length ? '所选条件没有匹配岗位，请放宽或重置条件' : !stats.count ? '有匹配岗位，但没有有效薪资' : '有效薪资少于5条，不显示薪资统计';
  $('#salaryEstimateReliability').textContent = `同条件岗位 ${number(selected.length)} 条；缺失、无法解析或超范围薪资 ${number(stats.excluded)} 条${stats.count >= 5 && stats.count < 20 ? '；小样本易受个别岗位影响' : ''}；不使用模型外推`;
}

async function loadInsightDatasets() {
  const select = $('#insightDataset');
  if (!select) return;
  const requestId = ++state.insightDatasetRequest;
  try {
    const [data, taskData] = await Promise.all([api('/api/insights/datasets'), api('/api/tasks')]);
    if (requestId !== state.insightDatasetRequest) return;
    state.insightDatasets = finalDatasetCatalog(data.datasets || [], taskData.tasks || []);
    $('#insightCatalogNote').textContent = `当前 ${number(state.insightDatasets.length)} 个最终整合数据集；每个任务只显示一份，平台分片、重复格式和历史版本不进入默认目录。原始与打标文件保留，可手工指定其他路径。`;
    const options = state.insightDatasets.map((item) => `<option value="${escapeHtml(item.path)}">${escapeHtml(item.name)} · ${escapeHtml(item.format || 'xlsx')}${item.collecting ? ' · 采集中数据' : ''} · ${(item.size / 1024 / 1024).toFixed(1)} MB</option>`).join('');
    select.innerHTML = `<option value="">手工输入 XLSX / CSV 路径</option>${options}`;
    const labelSelection = $('#labelDataset').value;
    $('#labelDataset').innerHTML = `<option value="">手工填写数据路径</option>${options}`;
    if ([...$('#labelDataset').options].some((option) => option.value === labelSelection)) $('#labelDataset').value = labelSelection;
    const current = $('#insightForm input[name="inputFile"]')?.value;
    const matched = state.insightDatasets.find((item) => normalizedLocalPath(item.path) === normalizedLocalPath(current));
    select.value = matched?.path || '';
  } catch (error) { if (requestId === state.insightDatasetRequest) select.innerHTML = '<option value="">未能自动扫描，请手工输入Excel路径</option>'; }
}

async function loadInsightLabelJobs() {
  const select = $('#insightLabelJob');
  if (!select) return;
  const requestId = ++state.insightLabelRequest;
  const inputFile = normalizedLocalPath($('#insightForm input[name="inputFile"]')?.value);
  if (select.dataset.sourcePath !== inputFile) {
    const selected = select.value === '' ? '' : 'auto';
    select.innerHTML = '<option value="auto">自动使用同源标签（推荐）</option><option value="">不使用外部标签（仅规则抽取）</option>';
    select.value = selected;
    select.dataset.sourcePath = inputFile;
  }
  try {
    const data = await api('/api/labels');
    if (requestId !== state.insightLabelRequest || inputFile !== normalizedLocalPath($('#insightForm input[name="inputFile"]')?.value)) return;
    // Empty is an intentional "no external labels" choice, not an auto default.
    const selected = select.value;
    const compatible = (data.jobs || []).filter((job) => normalizedLocalPath(job.inputFile) === inputFile && job.metrics.completed && !job.resultsMissing && (job.platform !== 'rules' || job.status === 'completed'));
    const pairs=[];
    const ai=compatible.filter(job=>job.platform!=='rules');
    for(let i=0;i<ai.length;i++)for(let j=i+1;j<ai.length;j++)if(ai[i].platform!==ai[j].platform)pairs.push(`<option value="consensus:${escapeHtml(ai[i].id)},${escapeHtml(ai[j].id)}">双平台一致：${escapeHtml(ai[i].platformName)} + ${escapeHtml(ai[j].platformName)}</option>`);
    select.innerHTML = '<option value="auto">自动使用同源标签（推荐）</option><option value="">不使用外部标签（仅规则抽取）</option>' + pairs.join('') + compatible.map((job) => `<option value="${escapeHtml(job.id)}">${escapeHtml(job.name)} · ${number(job.metrics.completed)} 条${job.platform === 'rules' ? '预标注' : '结果'}</option>`).join('');
    select.value = [...select.options].some((option) => option.value === selected) ? selected : 'auto';
  } catch { if (requestId === state.insightLabelRequest && inputFile === normalizedLocalPath($('#insightForm input[name="inputFile"]')?.value)) select.innerHTML = '<option value="">标签任务暂不可读取</option>'; }
}

function renderInsightStatus() {
  const transfer = state.insightTransfer;
  $('#insightTransferSource').textContent = transfer ? `来源采集任务：${transfer.role} · ${transfer.expectedRows ? `交付 ${number(transfer.expectedRows)} 条` : '交付条数待核对'} · ${/legacy$/.test(transfer.resolution || '') ? '旧服务：按任务目录及交付信息验证，后端清单校验需重启后生效' : '按任务交付清单验证'}。全量分析会逐条筛选，不代表全部记录都属于目标岗位。` : '';
  const insight = state.insight || { status: 'empty', message: '尚未生成岗位市场洞察' };
  const status = $('#insightStatus');
  const report = insight.report;
  const completedMessage = report && insight.status === 'completed' ? `${report.detected_role?.name || report.role || '岗位'}分析完成：${number(report.sample_rows)}/${number(report.total_rows)} 条` : insight.message;
  const updatedAt = report?.generated_at || insight.updatedAt;
  status.innerHTML = `<div class="insight-run-state ${escapeHtml(insight.status)}"><span class="pulse"></span><div><b>${escapeHtml(completedMessage)}</b><small>${insight.status === 'running' ? `已运行 ${number(insight.runningSeconds)} 秒` : updatedAt ? `最近更新 ${new Date(updatedAt).toLocaleString('zh-CN')}` : '选择数据后生成分析'}</small></div></div>`;
  if (report) {
    const selectedRole = $('#insightForm input[name="role"]').value.trim();
    const reportRole = report.detected_role?.manual_label || report.role;
    const changed = normalizedLocalPath($('#insightForm input[name="inputFile"]').value) !== normalizedLocalPath(report.input_file) || (!/^(自动|自动识别|auto)?$/i.test(selectedRole) && selectedRole !== reportRole);
    const historicalManual = report.detected_role?.mode === 'manual_override' && !report.selection_contract;
    status.insertAdjacentHTML('beforeend', `<p class="insight-report-source">当前报告来源：${escapeHtml(report.input_file)}${insight.status === 'failed' ? ' · 本次分析失败，下方保留上次成功报告，不是本次结果' : changed ? ' · 选择已更改，下方仍是上次报告，请重新生成分析' : historicalManual ? ' · 历史手工覆盖报告，请重新生成以验证指定岗位' : ''}</p>`);
  }
  const button = $('#runInsight');
  if (button) {
    button.disabled = insight.status === 'running';
    button.textContent = insight.status === 'running' ? '分析运行中…' : '生成全量分析';
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
    joint_expansion: report.joint_expansion,
    topic_model: report.topic_model,
    pending_included_in_statistics: false,
  };
  console.debug('[岗位筛选审计]', audit);
  return audit;
}

function renderInsightDashboard() {
  const report = state.insight?.report;
  const container = $('#insightDashboard');
  if (!report) {
    container.innerHTML = '<div class="insight-empty card"><b>从一小批真实数据开始</b><p>系统将读取岗位名称、薪资、城市、经验、学历、技能、行业和岗位描述，生成可解释的市场洞察。</p></div>';
    return;
  }
  logInsightFilterAudit(report);
  const salary = report.salary || {};
  const topCity = report.cities?.[0];
  const detectedRole = report.detected_role || { name: report.role || '待识别', confidence: 0, evidence: {} };
  const roleEvidence = detectedRole.evidence || {};
  container.innerHTML = `
    <section class="stats insight-kpis">
      <div class="stat"><span>有效分析样本</span><strong>${number(report.sample_rows)}</strong><em>${report.analysis_mode === 'full' ? '全量逐条匹配' : `抽样 ${number(report.requested_sample_rows || report.sample_rows)} 条`} · 原始 ${number(report.total_rows)} 条</em></div>
      <div class="stat"><span>月薪中位数</span><strong>${salary.median == null ? '—' : `${salary.median}K`}</strong><em>P25 ${salary.p25 ?? '—'}K · P75 ${salary.p75 ?? '—'}K</em></div>
      <div class="stat"><span>薪资可用率</span><strong>${percent(report.quality?.salary_coverage)}</strong><em>${number(report.quality?.salary_rows)} 条有效薪资样本</em></div>
      <div class="stat"><span>最大需求城市</span><strong>${escapeHtml(topCity?.name || '—')}</strong><em>${topCity ? `${number(topCity.count)} 条样本岗位` : '缺少城市信息'}</em></div>
    </section>
    <section class="card insight-role-summary">
      <div><span>${detectedRole.mode === 'auto' ? '自动识别岗位族' : '指定分析岗位'}</span><strong>${escapeHtml(detectedRole.name)}</strong><small>${detectedRole.mode === 'manual_keyword' ? '手工名称按字面关键词匹配；不回退到其他岗位族' : detectedRole.mode === 'manual_override' ? '已使用手工岗位族覆盖' : '由文件名、查询词、标题、技能和岗位描述综合识别'}</small></div>
      <div><span>${detectedRole.mode === 'manual_keyword' ? '关键词匹配证据' : '识别置信度'}</span><strong>${detectedRole.mode === 'manual_keyword' ? `${number(roleEvidence.matching_rows)} 条` : percent(detectedRole.confidence)}</strong><small>${detectedRole.mode === 'manual_keyword' ? `检查 ${number(roleEvidence.inspected_rows)} 条；不是模型置信度` : `${roleEvidence.query_rows ?? '—'} / ${roleEvidence.inspected_rows ?? '—'} 条查询词支持`}</small></div>
      <div><span>岗位匹配率</span><strong>${percent(report.relevance_rate)}</strong><small>保留 ${number(report.relevant_sample_rows)} 条 · 移除 ${number(report.filtered_out_rows)} 条</small></div>
      <div><span>标签覆盖率</span><strong>${percent(report.quality?.skill_coverage)}</strong><small>职责主题 ${percent(report.quality?.task_coverage)}</small></div>
    </section>
    <section class="card insight-explorer" id="cohortExplorer"></section>
    <section class="card insight-label-provenance">标签来源：${escapeHtml(report.label_provenance?.mode || '规则抽取')}${report.label_provenance?.total != null ? ` · 已预标注 ${number(report.label_provenance.total)} 条` : ''} · 已用于分析 ${number(report.label_provenance?.used_in_focused_rows)} 条${report.label_provenance?.included_by_external_label ? ` · 标签补充纳入 ${number(report.label_provenance.included_by_external_label)} 条` : ''}${report.label_provenance?.non_target != null ? ` · 规则判为非目标 ${number(report.label_provenance.non_target)} 条（待复核）` : ''}${report.label_provenance?.excluded_by_prelabel ? ` · 从关键词匹配样本排除 ${number(report.label_provenance.excluded_by_prelabel)} 条` : ''}${report.label_provenance?.human_approved != null ? ` · 人工批准 ${number(report.label_provenance.human_approved)} 条` : ''}</section>
    <section class="insight-grid">
      <article class="card insight-panel"><div class="insight-panel-head"><div><h3>多技术栈组合</h3><p>2–4项频繁项集；调整后估计已控制画像条件</p></div></div><div class="table-scroll"><table class="insight-table"><thead><tr><th>技术栈组合</th><th>项数</th><th>样本</th><th>支持度</th><th>原始中位数</th><th>调整后估计</th></tr></thead><tbody>${(report.frequent_skill_sets || report.skill_combinations || []).slice(0, 15).map((item) => `<tr><td>${escapeHtml(item.name)}</td><td>${item.size || 2}</td><td>${number(item.count)}</td><td>${percent(item.support)}</td><td>${item.raw_median_salary_k ?? item.median_salary_k ?? '—'}K</td><td>${item.adjusted_estimate_k == null ? '—' : `${item.adjusted_estimate_k}K`}</td></tr>`).join('') || '<tr><td colspan="6">当前样本没有达到组合展示阈值</td></tr>'}</tbody></table></div></article>
    </section>
    <section class="insight-grid two-col">
      <article class="card insight-panel"><div class="insight-panel-head"><div><h3>岗位种子学习特征</h3><p>按目标岗位中的频率及相对其他岗位的区分度学习技能与职责</p></div></div>${insightBars(report.topic_model?.discovered_terms, 'seed_count', (value, item) => `${value} · Lift ${item.lift}`)}</article>
      <article class="card insight-panel"><div class="insight-panel-head"><div><h3>样本纳入依据</h3><p>${report.selection_contract === 'role-evidence-v2' ? '学习关键词＋领域工程上下文；职责与任职要求分别取证，待复核独立保留' : report.selection_contract === 'universal-keywords-v1' ? '标题建立种子，学习关键词筛选全部岗位；规则结果待复核' : '历史报告：直接匹配与技能＋业务职责联合匹配'}</p></div></div>${insightBars(report.topic_model?.match_methods)}</article>
    </section>
    ${report.selection_review ? `<section class="card insight-label-provenance" id="insightPendingReview"><details><summary>待复核岗位 ${number(report.selection_review.pending_rows)} 条（不计入主报告）</summary><p>${escapeHtml(report.selection_review.note)}</p><p>预览前20条；完整记录包含源行号、平台岗位ID、原文依据和证据位置。<button type="button" id="downloadInsightReview">下载完整复核清单（JSON）</button></p>${report.selection_review.rows.slice(0,20).map(r => `<p>第 ${number(r.row_no)} 行 · ${escapeHtml(r.title)} · ${escapeHtml(r.platform)}<br/>${r.keyword_evidence.quotes.slice(0,3).map(q=>`${escapeHtml(q.location === 'requirements' ? '任职要求' : q.location === 'duties' ? '职责' : '未分节')}：${escapeHtml(q.quote)}`).join('<br/>')}</p>`).join('')}</details></section>` : ''}
    <section class="insight-grid map-layout">
      <article class="card insight-panel map-panel"><div class="insight-panel-head"><div><h3>城市行政分布</h3><p>圆点大小代表岗位样本数；边界使用公开行政区GeoJSON</p></div></div><div id="cityMap" class="city-map" aria-label="中国城市岗位样本分布图"></div></article>
      <article class="card insight-panel"><div class="insight-panel-head"><div><h3>城市排名</h3><p>同时显示各城市样本薪资中位数</p></div></div>${insightBars(report.cities, 'count', (value, item) => `${value} · ${item.median_salary_k == null ? '—' : `${item.median_salary_k}K`}`)}</article>
    </section>
    `;
  bindCohortExplorer(report);
  $('#downloadInsightReview')?.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ input_file: report.input_file, generated_at: report.generated_at, selection_contract: report.selection_contract, ...report.selection_review }, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = '岗位待复核清单.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  drawCityMap(report.cities || []);
}

function bindCohortExplorer(report) {
  const root = $('#cohortExplorer');
  const rows = report.cohort_observations || [];
  // Older reports have aggregates only: show them once in the same profile panel.
  if (!rows.length) {
    root.innerHTML = '<div class="insight-panel-head"><div><h3>岗位画像</h3><p>历史报告仅有汇总，没有逐条岗位；重新生成洞察后可按五项条件联动查看薪资和技术栈。行业按岗位计数，与新报告的公司去重口径不同。</p></div></div><div class="insight-grid two-col">' +
      [['高频技能', report.skills], ['高频工作内容', report.tasks], ['业务工作方向', report.business_domains], ['公司行业定位', report.industries]]
        .map(([title, items]) => '<article><h4>' + title + '</h4>' + (insightBars(items, 'count') || '<p>暂无可用标签</p>') + '</article>').join('') + '</div>';
    return;
  }
  const filterSpecs = [['city','城市','cohortCity'],['experience','经验','cohortExperience'],['education','学历','cohortEducation'],['company_size','公司规模','cohortCompanySize'],['employment_type','用工类型','cohortEmployment']];
  root.innerHTML = `<div class="insight-panel-head"><div><h3>条件岗位画像与薪资统计</h3><p>五项条件共用同一批匹配岗位，同步统计薪资、技能与技术栈、工作内容及行业。选项来自当前报告实际岗位，随其他已选条件联动；每个标签在同一岗位只计一次。</p></div></div>
    <div class="cohort-filters">${filterSpecs.map(([field,label,id])=>`<label>${label}<select id="${id}" data-cohort-filter="${field}"><option value="">不限（不筛选）</option></select></label>`).join('')}<button type="button" class="ghost" id="resetCohort">全部不限</button></div>
    <div id="cohortSummary" aria-live="polite"></div>${cohortSalaryMarkup()}<div class="insight-grid two-col"><article><h4>高频技能与技术栈</h4><div id="cohortSkills"></div></article><article><h4>高频工作内容</h4><div id="cohortTasks"></div></article><article><h4>业务工作方向</h4><div id="cohortDomains"></div></article><article><h4>公司行业定位</h4><div id="cohortIndustries"></div></article></div><details><summary>查看业务判断原文依据</summary><div id="cohortEvidence"></div></details>`;
  const update = () => {
    const profile = Object.fromEntries(filterSpecs.map(([field,,id])=>[field,$('#'+id).value]));
    for (const [field,,id] of filterSpecs) {
      const available = cohortFilterOptions(rows,profile,field);
      const current = profile[field];
      const select = $('#'+id);
      select.innerHTML = '<option value="">不限（不筛选）</option>' + available.map(item=>`<option value="${escapeHtml(item.value)}">${escapeHtml(item.value === '不限' ? '招聘要求：不限' : item.value)} · ${number(item.count)} 条</option>`).join('') +
        (current && !available.some(item=>item.value===current) ? `<option value="${escapeHtml(current)}" disabled>${escapeHtml(current)} · 当前组合0条</option>` : '');
      select.value = current;
    }
    const city = profile.city;
    const selected = filterCohort(rows,profile);
    const summary = summarizeCohort(selected);
    const salary = cohortSalaryStatistics(selected);
    $('#cohortSummary').innerHTML = `<p><b>${number(summary.count)} 条匹配岗位</b> · 有效薪资 ${number(salary.count)} 条 · ${number(summary.count-salary.count)} 条岗位薪资缺失、无法解析或超范围，仍参与技能画像${summary.count && summary.count < 20 ? ' · 小样本，统计波动较大' : ''}${!summary.count ? ' · 当前条件组合没有岗位，请改为不限或点击全部不限；不会自动借用其他样本' : ''}</p>`;
    updateCohortSalary(selected);
    for (const [id,key] of [['cohortSkills','skills'],['cohortTasks','tasks'],['cohortDomains','business_domains']]) $('#'+id).innerHTML = insightBars(summary[key], 'count', (count,item)=>`${number(count)} · ${percent(item.rate)}`) || '<p>暂无可用标签</p>';
    $('#cohortIndustries').innerHTML = summary.industries.length ? insightBars(summary.industries, 'share', (value)=>percent(value)) : '<p>缺少公司行业信息，暂不推测行业。</p>';
    $('#cohortEvidence').innerHTML = summary.business_domains.slice(0,6).map(d=>`<p><b>${escapeHtml(d.name)}</b> · ${number(d.count)} 条岗位<br>${d.evidence.map(e=>`#${number(e.row_no)} ${escapeHtml(e.job_name)}：${escapeHtml(e.quote || '标签来源有证据，未提取业务片段')}`).join('<br>')}</p>`).join('') || '<p>当前筛选没有明确业务方向证据。</p>';
    if (city) drawCityDetail(city,selected); else { $('#cityMapDetail')?.remove(); }
  };
  root.querySelectorAll('select').forEach(el=>el.addEventListener('change',update));
  $('#resetCohort').addEventListener('click',()=>{root.querySelectorAll('select').forEach(el=>el.value='');update();});
  update();
}

const cityMapCodes = {北京:110000,天津:120000,上海:310000,重庆:500000,广州:440100,深圳:440300,杭州:330100,成都:510100,武汉:420100,南京:320100,苏州:320500,西安:610100,长沙:430100,合肥:340100,郑州:410100,济南:370100,青岛:370200,厦门:350200,福州:350100,无锡:320200,宁波:330200,东莞:441900,佛山:440600,珠海:440400,昆明:530100,沈阳:210100,大连:210200};
let cityDetailRevision = 0;
async function drawCityDetail(city, rows) {
  const revision = ++cityDetailRevision;
  $('#cityMapDetail')?.remove();
  const host = document.createElement('section');host.id='cityMapDetail';host.className='card insight-panel';
  $('#cohortExplorer').after(host);
  host.innerHTML = `<h3>${escapeHtml(city)}行政区分布</h3><p>正在读取市级行政区边界…</p>`;
  try {
    if (!cityMapCodes[city]) throw new Error('当前城市暂无已缓存的行政边界');
    const res=await fetch(`/maps/${cityMapCodes[city]}.geojson`);if(!res.ok)throw new Error('边界暂不可用');
    const geo=await res.json();if(revision!==cityDetailRevision || $('#cohortCity').value!==city)return;
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
  for(const f of geo.features || []) {
    const g=f.geometry;
    if(g?.type==='Polygon')g.coordinates.forEach(r=>r.reverse());
    if(g?.type==='MultiPolygon')g.coordinates.forEach(p=>p.forEach(r=>r.reverse()));
  }
}

async function drawCityMap(cities) {
  const container = $('#cityMap');
  if (!container) return;
  if (!window.d3) { container.textContent = '地图组件未加载，城市排名仍可正常使用。'; return; }
  try {
    const response = await fetch('/china-provinces.geojson');
    if (!response.ok) throw new Error('行政区边界数据不可用');
    const geo = await response.json();
    // DataV follows the GeoJSON right-hand winding convention, while d3-geo
    // interprets spherical polygon winding in the opposite direction.
    orientMap(geo);
    const width = 760; const height = 470;
    const svg = window.d3.select(container).append('svg').attr('viewBox', `0 0 ${width} ${height}`).attr('role', 'img').attr('aria-label', '中国城市岗位样本分布');
    const projection = window.d3.geoMercator().fitExtent([[18, 18], [width - 18, height - 18]], geo);
    const pathGenerator = window.d3.geoPath(projection);
    svg.selectAll('path').data(geo.features).join('path').attr('class', 'map-region').attr('d', pathGenerator);
    const cityResponse=await fetch('/maps/cities.geojson');
    if(cityResponse.ok){const cityGeo=await cityResponse.json();orientMap(cityGeo);svg.selectAll('path.city-boundary').data(cityGeo.features.filter(f=>cities.some(c=>c.name===f.properties.name))).join('path').attr('class','map-region city-boundary').attr('d',pathGenerator).attr('tabindex',0).attr('role','button').attr('aria-label',f=>`查看${f.properties.name}岗位`).on('click',(_,f)=>selectMapCity(f.properties.name)).on('keydown',(event,f)=>{if(event.key==='Enter')selectMapCity(f.properties.name);});}
    const visible = cities.filter((item) => Number.isFinite(item.longitude) && Number.isFinite(item.latitude));
    const radius = window.d3.scaleSqrt().domain([1, window.d3.max(visible, (item) => item.count) || 1]).range([4, 18]);
    const marks = svg.selectAll('g.city-mark').data(visible).join('g').attr('class', 'city-mark').attr('transform', (item) => `translate(${projection([item.longitude, item.latitude]).join(',')})`);
    marks.attr('tabindex',0).attr('role','button').attr('aria-label',item=>`查看${item.name}岗位`).on('click',(_,item)=>selectMapCity(item.name)).on('keydown',(event,item)=>{if(event.key==='Enter')selectMapCity(item.name);});
    marks.append('circle').attr('r', (item) => radius(item.count)).append('title').text((item) => `${item.name}：${item.count} 条；薪资中位数 ${item.median_salary_k == null ? '样本不足' : `${item.median_salary_k}K/月`}`);
    marks.filter((item, index) => index < 8).append('text').attr('x', (item) => radius(item.count) + 4).attr('y', 4).text((item) => item.name);
  } catch (error) { container.textContent = `地图暂不可用：${error.message}`; }
}

function selectMapCity(city) {
  const select=$('#cohortCity');if(!select)return;
  // A map click chooses a new city scope, not an impossible old filter tuple.
  $('#resetCohort')?.click();
  const value=cohortConditionValue({city},'city');
  if(![...select.options].some(option=>option.value===value))return;
  select.value=value;select.dispatchEvent(new Event('change'));$('#cohortExplorer').scrollIntoView({behavior:'smooth',block:'start'});
}

function insightReportKey(report) {
  if (!report) return 'empty';
  return [report.version, report.generated_at, report.input_file, report.sheet_name, report.analysis_mode, report.sample_rows].join('|');
}

function renderInsight() {
  renderInsightStatus();
  const nextKey = insightReportKey(state.insight?.report);
  if (nextKey === state.insightRenderKey) return;
  state.insightRenderKey = nextKey;
  renderInsightDashboard();
}

async function loadInsight(silent = true) {
  try {
    state.insight = await api('/api/insights');
    if(!state.insightFormInitialized && state.insight.report) {
      const report=state.insight.report;
      $('#insightForm input[name="inputFile"]').value=report.input_file;
      $('#insightForm input[name="role"]').value=report.detected_role?.manual_label || report.role || '自动识别';
      state.insightFormInitialized=true;
      await loadInsightDatasets();await loadInsightLabelJobs();
    }
    renderInsight();
  } catch (error) { if (!silent) toast(error.message, true); }
}

async function loadPlatforms(silent = true) {
  if (state.platformsLoading) return;
  state.platformsLoading = true;
  try {
    const data = await api('/api/platforms');
    state.platforms = data.platforms;
    const groups = [...new Set(state.platforms.map((item) => item.group))];
    patchHtml($('#platformGroups'), groups.map((group) => `<div class="platform-section"><div class="section-heading"><h2>${escapeHtml(group)}</h2><p>${group === '招聘平台' ? '用于岗位详情采集' : '用于人工登录后的结构化打标'}</p></div><div class="platform-grid">${state.platforms.filter((item) => item.group === group).map((item) => `<article class="platform-card card"><div class="platform-card-head"><div class="platform-logo">${escapeHtml(item.name.slice(0, 2))}</div><div><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.description)}</p></div><span class="session-badge ${item.status}">${loginStatusLabel[item.status] || item.status}</span></div><div class="session-message">登录状态：${escapeHtml(authLabels[item.loginStatus]||'未确认')} · 验证状态：${escapeHtml(verificationLabels[item.verificationStatus]||'未检查')}<br>${escapeHtml(item.message)}${item.key === 'yupao' && item.browserExecutable ? `<details class="browser-instance-info"><summary>浏览器实例 · PID ${escapeHtml(item.browserPid)}</summary><small>程序：${escapeHtml(item.browserExecutable)}<br>配置目录：${escapeHtml(item.browserProfile)}${item.browserInitialization?.source_profile ? `<br>初始化：${item.browserInitialization.mode === 'full' ? '本机完整配置快照' : '本机常用设置'}（${escapeHtml(item.browserInitialization.source_profile)}）${item.browserInitialization.mode === 'full' ? '<br>加密登录数据已复制，登录态请在新实例人工确认' : ''}` : ''}${item.browserProxy ? `<br>代理：${escapeHtml(item.browserProxy)}` : ''}</small></details>` : ''}${item.key === 'yupao' && browserSwitchReason(item) ? `<br><span class="browser-switch-reason">${escapeHtml(browserSwitchReason(item))}</span>` : ''}</div><div class="platform-actions"><small>${item.updatedAt ? `最近会话 ${new Date(item.updatedAt).toLocaleString('zh-CN')}` : '尚无本机登录记录'}</small><div class="platform-browser-actions"><button class="secondary" data-platform-login="${escapeHtml(item.key)}" ${item.status === 'opening' ? 'disabled' : ''}>${item.browserOpen ? '显示共享浏览器' : '打开登录浏览器'}</button>${item.key === 'yupao' ? `<button class="secondary" data-platform-switch="yupao" ${!item.canSwitchBrowser ? 'disabled' : ''} title="将当前 Cookie 迁入独立的新实例，后续采集自动复用；请先暂停鱼泡采集">携带 Cookie 切换新浏览器</button>` : ''}</div></div></article>`).join('')}</div></div>`).join(''));
    document.querySelectorAll('[data-platform-login]').forEach((button) => {
      if (pendingPlatformLogins.has(button.dataset.platformLogin)) button.disabled = true;
      if (button._platformLoginBound) return;
      button._platformLoginBound = true;
      button.addEventListener('click', async () => {
      if (button.disabled) return;
      pendingPlatformLogins.add(button.dataset.platformLogin);
      button.disabled = true;
      try {
        const data = await api(`/api/platforms/${encodeURIComponent(button.dataset.platformLogin)}/login`, { method: 'POST', body: '{}' });
        toast(data.message); await loadPlatforms();
      } catch (error) { toast(error.message, true); }
      finally {
        pendingPlatformLogins.delete(button.dataset.platformLogin);
        button.disabled = state.platforms.find(p=>p.key===button.dataset.platformLogin)?.status === 'opening';
      }
    }); });
    $('#refreshPlatforms').title = '本地服务连接正常';
    const switchButton=document.querySelector('[data-platform-switch="yupao"]');
    if(switchButton){
      switchButton.disabled=switchingYupaoBrowser||!state.platforms.find(p=>p.key==='yupao')?.canSwitchBrowser;
      if(!switchButton._switchBound){
        switchButton._switchBound=true;
        switchButton.addEventListener('click',async()=>{
          if(switchButton.disabled)return;
          switchingYupaoBrowser=true;switchButton.disabled=true;
          toast('正在打开新浏览器并迁移 Cookie…');
          try{
            const data=await api('/api/platforms/yupao/switch-browser',{method:'POST',body:'{}',timeoutMs:180000});
            toast(data.message);
          }catch(error){toast(error.message,true);}
          finally{switchingYupaoBrowser=false;await loadPlatforms(false);}
        });
      }
    }
  } catch (error) { $('#refreshPlatforms').title = error.message; if (!silent) toast(error.message, true); }
  finally { state.platformsLoading = false; }
}

function labelProgress(job) {
  return Math.min(100, Math.round((job.metrics.completed / Math.max(1, job.metrics.total)) * 100));
}

function labelResultMissing(job) { return Boolean(job?.resultsMissing || job?.status === 'completed' && job?.metrics?.completed === 0); }

function renderLabelStats() {
  const total = state.labelJobs.reduce((sum, job) => sum + job.metrics.total, 0);
  const completed = state.labelJobs.reduce((sum, job) => sum + job.metrics.completed, 0);
  const running = state.labelJobs.filter((job) => ['running', 'stopping'].includes(job.status)).length;
  const confidence = state.labelJobs.filter((job) => job.metrics.averageConfidence).map((job) => job.metrics.averageConfidence);
  const average = confidence.length ? confidence.reduce((sum, value) => sum + value, 0) / confidence.length : 0;
  patchHtml($('#labelStats'), [
    ['打标任务', state.labelJobs.length, '独立配置与输出目录'],
    ['正在运行', running, running ? '请勿重复启动同一聊天平台' : '当前无活动任务'],
    ['已完成标签', number(completed), `计划 ${number(total)} 条`],
    ['模型自报置信度', average ? `${(average * 100).toFixed(1)}%` : '—', '仅作复核线索，不等同真实准确率'],
  ].map(([label, value, note]) => `<div class="stat"><span>${label}</span><strong>${value}</strong><em>${note}</em></div>`).join(''));
}

function renderLabelList() {
  const list = $('#labelList');
  if (!state.labelJobs.length) {
    patchHtml(list, '<div class="empty-list">还没有打标任务<br />点击右上角创建测试任务</div>');
    return;
  }
  patchHtml(list, state.labelJobs.map((job) => `<button class="task-item ${job.id === state.selectedLabelId ? 'selected' : ''}" data-label-job="${escapeHtml(job.id)}"><div class="task-row"><strong>${escapeHtml(job.name)}</strong><span class="badge ${labelResultMissing(job) ? 'failed' : job.status}">${labelResultMissing(job) ? '结果缺失' : statusLabel[job.status] || job.status}</span></div><div class="task-meta"><span>${number(job.metrics.completed)} / ${number(job.metrics.total)}</span><span>${escapeHtml(job.platformName)}</span></div><div class="mini-progress"><i style="width:${labelProgress(job)}%"></i></div></button>`).join(''));
  list.querySelectorAll('[data-label-job]').forEach((button) => {
    if (button._labelClickBound) return; button._labelClickBound = true;
    button.addEventListener('click', () => {
    state.selectedLabelId = button.dataset.labelJob;
    syncRoute();
    renderLabels();
    loadLabelLog();
    });
  });
}

function setText(element, value) { if (element && element.textContent !== String(value)) element.textContent = String(value); }
function setDisabled(element, value) { if (element.disabled !== value) element.disabled = value; }

function updateLabelDetail(job) {
  const root = $('#labelDetail');
  const running = ['running', 'stopping'].includes(job.status);
  setText(root.querySelector('h2'), job.name);
  setText(root.querySelector('.detail-title p'), `${job.message} · ${job.platformName}`);
  const badge = root.querySelector('.detail-title .badge');
  setText(badge, labelResultMissing(job) ? '结果缺失' : statusLabel[job.status] || job.status);
  const badgeClass = `badge ${labelResultMissing(job) ? 'failed' : job.status}`;
  if (badge.className !== badgeClass) badge.className = badgeClass;
  setText(root.querySelector('.progress-info span:last-child'), `${number(job.metrics.completed)} / ${number(job.metrics.total)}`);
  const progress = labelProgress(job);
  const bar = root.querySelector('.progress i'); if (bar.style.width !== `${progress}%`) bar.style.width = `${progress}%`;
  setText(root.querySelector('.progress-number'), `${progress}%`);
  const metrics = [number(job.metrics.total), number(job.metrics.completed), number(job.metrics.failed), job.metrics.averageConfidence ? `${(job.metrics.averageConfidence * 100).toFixed(1)}%` : '—', number(job.metrics.riskRows), job.metrics.schemaSuccessRate ? `${(job.metrics.schemaSuccessRate * 100).toFixed(1)}%` : '—', job.metrics.rowsPerMinute ? `${job.metrics.rowsPerMinute.toFixed(2)} 条/分` : '—'];
  root.querySelectorAll('.label-metrics b').forEach((element, i) => setText(element, metrics[i]));
  const run = root.querySelector('[data-label-action="run"]'); setDisabled(run, running);
  setText(run, `▶ ${job.metrics.completed ? '继续打标' : '开始打标'}`);
  setDisabled(root.querySelector('[data-label-action="pause"]'), !running || job.status === 'stopping');
  setDisabled(root.querySelector('[data-label-action="archive"]'), running);
  setDisabled(root.querySelector('[data-label-insights]'), labelResultMissing(job) || !job.metrics.completed);
  setText(root.querySelector('.log-head span'), running ? `已运行 ${job.runningSeconds || 0} 秒 · 日志独立刷新` : '最近输出');
  const runtime = root.querySelector('#labelRuntime');
  if (job.runtime && job.platform !== 'rules') {
    const target = runtime || document.createElement('p');
    if (!runtime) { target.id = 'labelRuntime'; target.className = 'safety compact-safety'; }
    setText(target, `平台阶段：${job.runtime.stage || '未明确'}。${job.runtime.nextActionAt ? `下一步不早于 ${new Date(job.runtime.nextActionAt).toLocaleString('zh-CN')}。` : ''}${job.runtime.retryAfter ? `冷却至 ${new Date(job.runtime.retryAfter).toLocaleString('zh-CN')}。` : ''}${job.runtime.recovery || ''}`);
    if (!runtime) root.querySelector('.detail-body').prepend(target);
  } else runtime?.remove();
}

function renderLabelDetail() {
  const job = state.labelJobs.find((item) => item.id === state.selectedLabelId);
  if (!job) {
    $('#labelDetail').dataset.jobId = '';
    patchHtml($('#labelDetail'), '<div class="empty-state"><h2>未找到打标任务</h2><p>请选择一个现存任务，或检查链接中的任务 ID。</p></div>');
    return;
  }
  if ($('#labelDetail').dataset.jobId === job.id) { updateLabelDetail(job); return; }
  $('#labelDetail').dataset.jobId = job.id;
  const isRunning = ['running', 'stopping'].includes(job.status);
  const value = labelProgress(job);
  $('#labelDetail').innerHTML = `<div class="detail-head"><div class="detail-title"><div><h2>${escapeHtml(job.name)}</h2><p>${escapeHtml(job.message)} · ${escapeHtml(job.platformName)}</p></div><span class="badge ${job.status}">${statusLabel[job.status] || job.status}</span></div><div class="detail-actions"><button class="primary" data-label-action="run" ${isRunning ? 'disabled' : ''}>▶ ${job.metrics.completed ? '继续打标' : '开始打标'}</button><button class="danger" data-label-action="pause" ${!isRunning || job.status === 'stopping' ? 'disabled' : ''}>暂停</button><button class="ghost" data-label-action="open">打开结果目录</button></div></div><div class="detail-body"><div class="progress-wrap"><div><div class="progress-info"><span>打标完成度</span><span>${number(job.metrics.completed)} / ${number(job.metrics.total)}</span></div><div class="progress"><i style="width:${value}%"></i></div></div><div class="progress-number">${value}%</div></div><div class="metric-grid label-metrics"><div class="metric"><small>计划标注</small><b>${number(job.metrics.total)}</b></div><div class="metric"><small>已完成</small><b>${number(job.metrics.completed)}</b></div><div class="metric"><small>失败</small><b>${number(job.metrics.failed)}</b></div><div class="metric"><small>模型自报置信度</small><b>${job.metrics.averageConfidence ? `${(job.metrics.averageConfidence * 100).toFixed(1)}%` : '—'}</b></div><div class="metric"><small>风险信号</small><b>${number(job.metrics.riskRows)}</b></div><div class="metric"><small>结构通过率</small><b>${job.metrics.schemaSuccessRate ? `${(job.metrics.schemaSuccessRate * 100).toFixed(1)}%` : '—'}</b></div><div class="metric"><small>实测速度</small><b>${job.metrics.rowsPerMinute ? `${job.metrics.rowsPerMinute.toFixed(2)} 条/分` : '—'}</b></div></div><div class="task-config"><span class="chip">${escapeHtml(job.sheetName)}</span><span class="chip">每批 ${job.batchSize} 条</span><span class="chip">数据最小化</span><span class="chip">验证码即停</span></div><div class="log-head"><h3>实时打标日志</h3><span>${isRunning ? `已运行 ${job.runningSeconds || 0} 秒 · 2秒刷新` : '最近输出'}</span></div><pre class="log" id="labelLog">正在读取日志…</pre><div class="path"><span>输入</span><code title="${escapeHtml(job.inputFile)}">${escapeHtml(job.inputFile)}</code></div><div class="path"><span>输出</span><code title="${escapeHtml(job.outputDir)}">${escapeHtml(job.outputDir)}</code></div><div class="detail-actions"><button class="ghost" data-label-action="archive" ${isRunning ? 'disabled' : ''}>从列表移除</button></div></div>`;
  if (labelResultMissing(job)) {
    const badge = $('#labelDetail .detail-title .badge');
    badge.textContent = '结果缺失';
    badge.className = 'badge failed';
  }
  const review = document.createElement('section');
  review.id = 'labelReview';
  review.className = 'label-review';
  review.textContent = labelResultMissing(job) ? '结果文件缺失，无法复核。请用现存 Excel 创建新任务。' : '正在读取待复核标签…';
  $('#labelDetail .detail-body').prepend(review);
  $('#labelDetail').querySelectorAll('[data-label-action]').forEach((button) => button.addEventListener('click', () => handleLabelAction(state.labelJobs.find(item => item.id === job.id) || job, button.dataset.labelAction)));
  const insightButton=document.createElement('button');insightButton.type='button';insightButton.className='secondary';insightButton.textContent='用于岗位洞察';
  insightButton.dataset.labelInsights = '';
  insightButton.disabled=labelResultMissing(job) || !job.metrics.completed;
  insightButton.addEventListener('click',async()=>{
    state.insightFormInitialized=true;
    $('#insightForm input[name="inputFile"]').value=job.inputFile;
    $('#insightForm input[name="role"]').value=job.jobFamily || '自动识别';
    switchView('insights');
    $('#insightForm').scrollIntoView({behavior:'smooth'});
  });
  $('#labelDetail .detail-actions').append(insightButton);
  if (job.runtime && job.platform !== 'rules') {
    const runtime = document.createElement('p'); runtime.className = 'safety compact-safety'; runtime.id = 'labelRuntime';
    const stages = { starting: '启动', checking_page: '检查页面', entering_prompt: '填写任务', waiting_response: '等待回复', cooldown: '批次冷却', retry_backoff: '异常退避', stopped: '已停止', completed: '完成' };
    runtime.textContent = `平台阶段：${stages[job.runtime.stage] || job.runtime.stage || '未明确'}。${job.runtime.nextActionAt ? `下一步不早于 ${new Date(job.runtime.nextActionAt).toLocaleString('zh-CN')}。` : ''}${job.runtime.retryAfter ? `冷却至 ${new Date(job.runtime.retryAfter).toLocaleString('zh-CN')}。` : ''}${job.runtime.recovery || ''}`;
    $('#labelDetail .detail-body').prepend(runtime);
  }
  updateLabelDetail(job);
}

function renderLabels() { renderLabelStats(); renderLabelList(); renderLabelDetail(); loadLabelReview(); }

async function loadLabelReview() {
  const id = state.selectedLabelId;
  const root = $('#labelReview');
  if (!id || !root || labelResultMissing(state.labelJobs.find((job) => job.id === id))) return;
  try {
    const data = await api(`/api/labels/${encodeURIComponent(id)}/review`);
    if (state.view !== 'labels' || id !== state.selectedLabelId || root !== $('#labelReview')) return;
    const signature = JSON.stringify(data);
    if (root._reviewSignature === signature) return;
    root._reviewSignature = signature;
    patchHtml(root, `<h3>人工复核</h3><p>已批准 ${number(data.approved)} · 已驳回 ${number(data.rejected)} · 待复核 ${number(data.pending)}。列表覆盖不同用工类型与置信度；核对原文证据后再批准。</p>${data.rows.map((row) => `<article class="label-review-row" data-review-row="${escapeHtml(`${row.row_no}:${row.job_id}`)}"><b>${escapeHtml(row.job_name)} · #${number(row.row_no)}</b><small>AI岗位判断：${escapeHtml(row.relevance_grade || '未明确')} / ${escapeHtml(row.label_status || '未明确')}${row.relevance_grade === '非目标' ? '；若岗位实际属于目标族，请特别核查后再批准' : ''}</small><small>用工类型：${escapeHtml(row.employment_type || '未明确')}；模型自报置信度：${percent(row.confidence)}；证据覆盖：${percent(row.evidence_coverage)}</small><small>标注技能：${escapeHtml((row.skills || []).join('、') || '无')}；职责：${escapeHtml((row.tasks || []).join('、') || '无')}</small><small>原始技能字段：${escapeHtml(row.skills_text || '无')}</small><small>岗位描述：${escapeHtml(row.job_description || '无')}</small><small>标注证据：${escapeHtml((row.evidence_json || []).map((item) => item.quote).filter(Boolean).join('；').slice(0, 360) || '无证据，请驳回')}</small><div><button class="secondary" data-review="approved" data-row-no="${number(row.row_no)}" data-job-id="${escapeHtml(row.job_id)}">批准</button><button class="ghost" data-review="rejected" data-row-no="${number(row.row_no)}" data-job-id="${escapeHtml(row.job_id)}">驳回</button></div></article>`).join('') || '<p>暂无待复核记录。</p>'}`);
    root.querySelectorAll('[data-review]').forEach((button) => {
      if (button._reviewBound) return; button._reviewBound = true;
      button.addEventListener('click', async () => {
      try {
        await api(`/api/labels/${encodeURIComponent(id)}/review`, { method: 'POST', body: JSON.stringify({ row_no: Number(button.dataset.rowNo), job_id: button.dataset.jobId, decision: button.dataset.review }) });
        await loadLabelReview();
      } catch (error) { toast(error.message, true); }
      });
    });
  } catch { if (state.view === 'labels' && root === $('#labelReview') && !root._reviewSignature) setText(root, '当前没有可复核的标注结果。'); }
}

async function loadLabels(silent = true) {
  if (state.labelsLoading) return;
  state.labelsLoading = true;
  try {
    const data = await api('/api/labels');
    state.labelJobs = data.jobs;
    if (state.view !== 'labels') return;
    if (!state.selectedLabelId && state.labelJobs.length) state.selectedLabelId = state.labelJobs[0].id;
    syncRoute(true);
    renderLabels();
    if (state.selectedLabelId && !$('#labelLog')?._logLoaded) loadLabelLog();
  } catch (error) { if (!silent) toast(error.message, true); }
  finally { state.labelsLoading = false; }
}

async function loadLabelLog() {
  const id = state.selectedLabelId;
  const log = $('#labelLog');
  if (state.view !== 'labels' || !id || !log || log._logLoading) return;
  log._logLoading = true;
  try {
    const data = await api(`/api/labels/${encodeURIComponent(id)}/logs`);
    if (state.view !== 'labels' || id !== state.selectedLabelId || log !== $('#labelLog')) return;
    updateLog(log, data.content || '尚无运行日志。'); log._logLoaded = true;
  } catch {}
  finally { log._logLoading = false; }
}

async function handleLabelAction(job, action) {
  try {
    if (action === 'archive' && !confirm('仅从列表移除任务，结果文件不会删除。继续吗？')) return;
    const body = {};
    if (action === 'run' && job.runtime?.requiresHuman) {
      if (job.runtime.retryAfter && Date.parse(job.runtime.retryAfter) > Date.now()) throw new Error(`平台仍在冷却，请等到 ${new Date(job.runtime.retryAfter).toLocaleString('zh-CN')} 后再恢复`);
      if (!confirm(`${job.runtime.recovery}\n已在平台页面人工处理完成，并确认平台允许继续使用吗？`)) return;
      body.confirmedHumanResolution = true;
    }
    const data = await api(`/api/labels/${encodeURIComponent(job.id)}/${action}`, { method: 'POST', body: JSON.stringify(body) });
    toast(data.message || '操作完成');
    if (action === 'archive') state.selectedLabelId = null;
    loadLabels();
  } catch (error) { toast(error.message, true); }
}

async function refresh(silent = true) {
  if (state.tasksLoading) return;
  state.tasksLoading = true;
  try {
    const data = await api('/api/tasks');
    state.tasks = data.tasks;
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
    updateLog(log, data.content || '尚无运行日志。'); log._logLoaded = true;
  } catch {}
  finally { log._logLoading = false; }
}

async function handleAction(task, action) {
  try {
    if (['insights', 'labels'].includes(action)) {
      await loadInsightDatasets();
      let dataset;
      try { dataset = (await api(`/api/tasks/${encodeURIComponent(task.id)}/insight-source`)).dataset; }
      catch (error) { if (error.status !== 404) throw error; dataset = selectLegacyTaskDataset(task, state.insightDatasets); }
      if (action === 'labels') {
        $('#labelForm input[name="inputFile"]').value = dataset.path;
        $('#labelForm input[name="jobFamily"]').value = task.label;
        $('#labelDataset').value = dataset.path;
        switchView('labels'); $('#labelDialog').showModal();
      } else {
        state.insightFormInitialized = true;
        state.insightTransfer = { taskId: task.id, role: task.label, ...dataset };
        $('#insightForm input[name="inputFile"]').value = dataset.path;
        $('#insightForm input[name="role"]').value = task.label;
        switchView('insights');
        $('#insightForm').scrollIntoView({ behavior: 'smooth' });
      }
      toast(`已选择 ${task.label} 的交付数据${dataset.expectedRows ? ` ${number(dataset.expectedRows)} 条` : ''}${dataset.collecting ? '；采集更新后需重新生成' : ''}`);
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
    if (action === 'login-zhaopin' || action === 'login-yupao') {
      const platform = action === 'login-yupao' ? 'yupao' : 'zhaopin';
      const data = await api(`/api/tasks/${encodeURIComponent(task.id)}/login`, { method: 'POST', body: JSON.stringify({ platform }) });
      toast(data.message); return refresh();
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
$('#newTaskBtn').addEventListener('click', () => { if (state.view === 'labels') { loadInsightDatasets(); $('#labelDialog').showModal(); } else $('#taskDialog').showModal(); });
$('#labelDataset').addEventListener('change', event => { if (event.currentTarget.value) $('#labelForm input[name="inputFile"]').value = event.currentTarget.value; });
$('#labelForm select[name="platform"]').addEventListener('change', event => {
  const kimi = event.currentTarget.value === 'kimi';
  $('#labelForm input[name="batchSize"]').max = kimi ? '1' : '5';
  if (kimi) $('#labelForm input[name="batchSize"]').value = '1';
  $('#labelForm input[name="cooldownSeconds"]').min = kimi ? '30' : '15';
  if (kimi) $('#labelForm input[name="cooldownSeconds"]').value = Math.max(30, Number($('#labelForm input[name="cooldownSeconds"]').value));
});
document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => $('#taskDialog').close()));
document.querySelectorAll('[data-close-label]').forEach((button) => button.addEventListener('click', () => $('#labelDialog').close()));
$('#showGuide').addEventListener('click', () => $('#guideDialog').showModal());
document.querySelectorAll('[data-close-guide]').forEach((button) => button.addEventListener('click', () => $('#guideDialog').close()));
$('#refreshBtn').addEventListener('click', () => refresh(false));
$('#refreshPlatforms').addEventListener('click', () => loadPlatforms(false));
$('#refreshLabels').addEventListener('click', () => loadLabels(false));
// Mark edits immediately, before any delayed initial report can restore fields.
for (const eventName of ['input', 'change']) $('#insightForm').addEventListener(eventName, () => {
  state.insightFormInitialized = true;
  if (state.insightTransfer && (localPathKey($('#insightForm input[name="inputFile"]').value) !== localPathKey(state.insightTransfer.path) || $('#insightForm input[name="role"]').value.trim() !== state.insightTransfer.role)) state.insightTransfer = null;
  renderInsightStatus();
});
$('#insightDataset').addEventListener('change', (event) => {
  if (event.currentTarget.value) $('#insightForm input[name="inputFile"]').value = event.currentTarget.value;
  loadInsightLabelJobs();
});
$('#insightForm input[name="inputFile"]').addEventListener('change', () => {
  const inputFile = normalizedLocalPath($('#insightForm input[name="inputFile"]').value);
  $('#insightDataset').value = state.insightDatasets.find((item) => normalizedLocalPath(item.path) === inputFile)?.path || '';
  loadInsightLabelJobs();
});

$('#taskForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const body = Object.fromEntries(form.entries());
  body.platforms = form.getAll('platforms');
  body.cities = form.getAll('cities');
  try {
    if (body.platforms.includes('boss') && !(await api('/api/state')).capabilities?.bossCollection) throw new Error('BOSS接入需要更新服务，请在当前采集和打标停止后重启控制台');
    const data = await api('/api/tasks', { method: 'POST', body: JSON.stringify(body) });
    state.selectedId = data.task.id;
    $('#taskDialog').close();
    event.currentTarget.reset();
    document.querySelectorAll('#platformChecks input').forEach((input) => { input.checked = !['job51', 'yupao', 'boss'].includes(input.value); });
    document.querySelectorAll('#cityChecks input').forEach((input) => { input.checked = !['天津', '重庆', '苏州'].includes(input.value); });
    toast('任务已创建');
    refresh();
  } catch (error) { toast(error.message, true); }
});

$('#labelForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const body = Object.fromEntries(form.entries());
  try {
    if (!(await api('/api/state')).capabilities?.labelPacing) throw new Error('请先更新服务以启用限速与原生数据接入');
    body.cooldownMs = Number(body.cooldownSeconds) * 1000;
    const data = await api('/api/labels', { method: 'POST', body: JSON.stringify(body) });
    state.selectedLabelId = data.job.id;
    $('#labelDialog').close();
    toast('打标任务已创建');
    await loadLabels();
  } catch (error) { toast(error.message, true); }
});

$('#insightForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(event.currentTarget).entries());
  body.analysisMode = 'full';
  body.labelJobId = 'auto';
  body.sheetName = '岗位数据';
  if (state.insightTransfer && localPathKey(body.inputFile) === localPathKey(state.insightTransfer.path) && body.role === state.insightTransfer.role) body.sourceTaskId = state.insightTransfer.taskId;
  try {
    if (body.labelJobId && !(await api('/api/state')).capabilities?.labelReview) throw new Error('请先更新服务以接入复核标签');
    const data = await api('/api/insights/run', { method: 'POST', body: JSON.stringify(body) });
    toast(data.message || '岗位分析已启动');
    await loadInsight(false);
  } catch (error) { toast(error.message, true); }
});

restoreRoute();
state.timer = setInterval(() => {
  if (document.hidden) return;
  if (state.view === 'tasks') refresh(true);
  if (state.view === 'platforms') loadPlatforms(true);
  if (state.view === 'labels') loadLabels(true);
  if (state.view === 'insights') loadInsight(true);
}, 3000);
state.logTimer = setInterval(() => {
  if (document.hidden) return;
  if (state.view === 'labels') loadLabelLog();
  if (state.view === 'tasks') loadLog();
}, 2000);
