import http from 'node:http';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { labelKey, labelDigest, reviewState, selectReviewAuditRows, readJsonLines, consensusLabelsForWorkbook } from '../work/reviewed_job_labels.mjs';
import { labelPolicy, resumeBlock } from '../work/label_runtime_policy.mjs';
import { taskInsightSource } from '../work/task-insight-source.mjs';
import { bossCities } from '../work/boss_page_adapter.mjs';
import {assertCollectorResources,nativeCrashMessage} from '../work/collector_resources.mjs';
import {ownedReport,isolatedDirectory,isolateLegacyTask} from '../work/task_dataset_scope.mjs';
import {writeJsonAtomic} from '../work/collector_storage.mjs';
import {sessionFileName} from '../work/manual_search_session.mjs';
import {managedBrowserState,switchManagedBrowser} from '../work/managed_browser.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const publicDir = path.join(here, 'public');
const dataDir = process.env.JOB_UI_DATA_DIR ? path.resolve(process.env.JOB_UI_DATA_DIR) : path.join(root, 'ui_data');
const taskDataDir = path.join(dataDir, 'tasks');
const logDir = path.join(dataDir, 'logs');
const tasksPath = path.join(dataDir, 'tasks.json');
const platformSessionDir = path.join(dataDir, 'platform_sessions');
const platformStatusPath = path.join(platformSessionDir, '登录会话状态.json');
const labelDataDir = path.join(dataDir, 'label_tasks');
const labelLogDir = path.join(dataDir, 'label_logs');
const labelJobsPath = path.join(dataDir, 'label_jobs.json');
const labelPlatformRuntimeDir = path.join(dataDir, 'label_platform_runtime');
const insightDataDir = path.join(dataDir, 'insights');
const insightStatePath = path.join(insightDataDir, 'state.json');
const insightConfigPath = path.join(insightDataDir, 'config.json');
const insightReportPath = path.join(insightDataDir, '岗位市场洞察.json');
const insightLogPath = path.join(insightDataDir, 'analysis.log');
const insightDatasetRoot = process.env.JOB_INSIGHT_DATASET_ROOT ? path.resolve(process.env.JOB_INSIGHT_DATASET_ROOT) : path.join(root, 'outputs');
const host = '127.0.0.1';
const port = Number(process.env.JOB_UI_PORT || process.argv[2] || 8765);
const active = new Map();
const activeLabels = new Map();
const startingLabels = new Map();
const activeLogins = new Map();
let startingBoss = false;
let activeInsight = null;
const rowCountCache = new Map();
const startingStages = new Set();

function consoleUrl() { return `http://${host}:${port}`; }

function openBrowser() {
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/d', '/c', 'start', '', consoleUrl()], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
    return;
  }
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(command, [consoleUrl()], { detached: true, stdio: 'ignore' }).unref();
}

function existingConsoleIsReady() {
  return new Promise((resolve) => {
    const request = http.get(`${consoleUrl()}/api/state`, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        if (body.length < 64_000) body += chunk;
      });
      response.on('end', () => {
        try {
          const state = JSON.parse(body);
          resolve(response.statusCode === 200 && typeof state.version === 'string');
        } catch {
          resolve(false);
        }
      });
    });
    request.setTimeout(2500, () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

await fs.mkdir(taskDataDir, { recursive: true });
await fs.mkdir(logDir, { recursive: true });
await fs.mkdir(platformSessionDir, { recursive: true });
await fs.mkdir(labelDataDir, { recursive: true });
await fs.mkdir(labelLogDir, { recursive: true });
await fs.mkdir(insightDataDir, { recursive: true });

const platformDefinitions = [
  { key: 'zhaopin', name: '智联招聘', group: '招聘平台', description: '岗位详情采集主力渠道' },
  { key: 'yupao', name: '鱼泡直聘', group: '招聘平台', description: '蓝领与技术岗位补充渠道' },
  { key: 'liepin', name: '猎聘', group: '招聘平台', description: '共享登录浏览器 · 命令行采集渠道' },
  { key: 'boss', name: 'BOSS直聘', group: '招聘平台', description: '试验接入 · 人工登录后正常页面采集，需小样本验收' },
  { key: 'jobonline', name: '就业在线', group: '招聘平台', description: '公开列表与详情 · 全国岗位补充渠道' },
  { key: 'job51', name: '前程无忧', group: '招聘平台', description: '需要验证时暂停 · 人工处理后断点续采' },
  { key: 'deepseek', name: 'DeepSeek', group: 'AI聊天平台', description: '技术岗位结构化标注' },
  { key: 'kimi', name: 'Kimi', group: 'AI聊天平台', description: '长岗位描述标注' },
  { key: 'tongyi', name: '通义', group: 'AI聊天平台', description: '中文分类与技能归一' },
  { key: 'zhipu', name: '智谱清言', group: 'AI聊天平台', description: '复杂岗位交叉复核' },
  { key: 'doubao', name: '豆包', group: 'AI聊天平台', description: '中文语义与咨询表达' },
];
const labelPlatforms = ['rules', ...platformDefinitions.filter((item) => item.group === 'AI聊天平台').map((item) => item.key)];

const zhaopinCities = {
  '北京': '530', '天津': '531', '上海': '538', '重庆': '551', '南京': '635', '苏州': '639',
  '杭州': '653', '武汉': '736', '广州': '763', '深圳': '765', '成都': '801', '西安': '854',
};
const job51Cities = {
  '全国': '000000', '北京': '010000', '上海': '020000', '广州': '030200', '深圳': '040000',
  '天津': '050000', '重庆': '060000', '南京': '070200', '苏州': '070300', '杭州': '080200',
  '成都': '090200', '武汉': '180200', '西安': '200200',
};

function now() { return new Date().toISOString(); }
function safeName(value) { return String(value || '').replace(/[\\/:*?"<>|]/g, '_').trim(); }
function splitTerms(value) {
  if (Array.isArray(value)) return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
  return [...new Set(String(value || '').split(/[\n,，;；]+/).map((item) => item.trim()).filter(Boolean))];
}
function taskById(tasks, id) { return tasks.find((task) => task.id === id && !task.archived); }

async function loadTasks() {
  try {
    const tasks = JSON.parse(await fs.readFile(tasksPath, 'utf8'));
    let changed = false;
    for (const task of tasks) {
      if (task.status === 'running' || task.status === 'stopping') {
        task.status = 'paused';
        task.message = '控制台曾退出，可从原目录续爬';
        changed = true;
      }
    }
    if (changed) await saveTasks(tasks);
    return tasks;
  } catch { return []; }
}

async function saveTasks(tasks) {
  const temp = `${tasksPath}.tmp`;
  await fs.writeFile(temp, JSON.stringify(tasks, null, 2), 'utf8');
  await fs.rename(temp, tasksPath);
}

let tasks = await loadTasks();
let datasetScopesChanged=false;
for(const task of tasks)datasetScopesChanged=(await isolateLegacyTask(task))||datasetScopesChanged;
if(datasetScopesChanged)await saveTasks(tasks);

async function loadLabelJobs() {
  try {
    const items = JSON.parse(await fs.readFile(labelJobsPath, 'utf8'));
    let changed = false;
    for (const item of items) {
      if (item.status === 'running' || item.status === 'stopping') {
        item.status = 'paused';
        item.message = '控制台曾退出，可从已保存结果继续标注';
        changed = true;
      }
    }
    if (changed) await saveLabelJobs(items);
    return items;
  } catch { return []; }
}

async function saveLabelJobs(items) {
  const temp = `${labelJobsPath}.tmp`;
  await fs.writeFile(temp, JSON.stringify(items, null, 2), 'utf8');
  await fs.rename(temp, labelJobsPath);
}

let labelJobs = await loadLabelJobs();

async function loadInsightState() {
  try {
    const state = JSON.parse(await fs.readFile(insightStatePath, 'utf8'));
    if (state.status === 'running') return { ...state, status: 'ready', message: '控制台曾退出，可重新生成分析' };
    return state;
  } catch {
    return { status: 'empty', message: '尚未生成岗位市场洞察', updatedAt: null };
  }
}

let insightState = await loadInsightState();

async function saveInsightState(patch) {
  insightState = { ...insightState, ...patch, updatedAt: now() };
  const temp = `${insightStatePath}.tmp`;
  await fs.writeFile(temp, JSON.stringify(insightState, null, 2), 'utf8');
  await fs.rename(temp, insightStatePath);
  return insightState;
}

async function publicInsight() {
  let report = null;
  try { report = JSON.parse(await fs.readFile(insightReportPath, 'utf8')); } catch {}
  return { ...insightState, runningSeconds: activeInsight ? Math.floor((Date.now() - activeInsight.startedAt) / 1000) : 0, report };
}

async function discoverInsightDatasets() {
  const found = new Map();
  for (const task of tasks.filter((item) => !item.archived)) {
    try {
      const { dataset } = await taskInsightSource(task);
      found.set(dataset.path.toLowerCase(), { ...dataset, canonical: true, stage: 'final', name: `${task.label} · 最终整合数据${dataset.expectedRows ? ` · ${dataset.expectedRows.toLocaleString('zh-CN')} 条` : ''}` });
    } catch {
      // Incomplete tasks and obsolete shared-directory manifests are not final
      // analysis datasets. They remain accessible via task/manual-path views.
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')).slice(0, 100);
}

async function startInsight(body) {
  if (activeInsight) throw new Error('岗位洞察分析正在运行');
  const inputFile = path.resolve(String(body.inputFile || '').trim());
  if (!inputFile || !fsSync.existsSync(inputFile)) throw new Error('找不到输入Excel文件');
  if (!['.xlsx', '.csv'].includes(path.extname(inputFile).toLowerCase())) throw new Error('仅支持 XLSX 或 UTF-8 标准化 CSV');
  let transferSource = null;
  if (body.sourceTaskId) {
    const task = tasks.find((item) => item.id === String(body.sourceTaskId) && !item.archived);
    if (!task) throw new Error('来源采集任务不存在');
    transferSource = await taskInsightSource(task);
    if (transferSource.dataset.path.toLowerCase() !== inputFile.toLowerCase()) throw new Error('洞察文件不是该任务的当前交付文件，请重新点击“用于岗位洞察”');
    if (String(body.role || '').trim() !== task.label) throw new Error('分析岗位与来源采集任务不一致，请手工选择数据集后再修改岗位');
  }
  let labelJobId = String(body.labelJobId || '').trim();
  let labelJob = null;
  let consensusJobs = [];
  const compatibleLabelJobs = labelJobs.filter((item) => !item.archived && path.resolve(item.inputFile).toLowerCase() === inputFile.toLowerCase());
  if (labelJobId === 'auto') {
    const newestFirst = [...compatibleLabelJobs].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    for (const item of newestFirst.filter((candidate) => candidate.platform !== 'rules')) {
      if (!fsSync.existsSync(path.join(item.outputDir, '标注结果.jsonl')) || !fsSync.existsSync(path.join(item.outputDir, '标注质量报告.json'))) continue;
      const reviewed = await reviewState(item.outputDir);
      if ([...reviewed.decisions.values()].includes('approved')) { labelJob = item; break; }
    }
    if (!labelJob) {
      const ai = newestFirst.filter(item => item.platform !== 'rules' && fsSync.existsSync(path.join(item.outputDir, '标注质量报告.json')) && fsSync.existsSync(path.join(item.outputDir, '标注结果.jsonl')));
      let bestMatched = 4;
      for (let i = 0; i < ai.length; i++) for (let j = i + 1; j < ai.length; j++) {
        if (ai[i].platform === ai[j].platform) continue;
        try {
          const records = await readJsonLines(path.join(ai[i].outputDir, '标注结果.jsonl'));
          const rows = records.map(r => ({ row_no:r.row_no, 岗位ID:r.job_id, 岗位名称:r.job_name, 技能:r.skills_text, 岗位描述:r.job_description }));
          const known = new Set(records.flatMap(r=>r.skills || []));
          const result = await consensusLabelsForWorkbook([ai[i].outputDir,ai[j].outputDir],inputFile,rows,known);
          if (result.quality.matched > bestMatched) { bestMatched=result.quality.matched; consensusJobs=[ai[i],ai[j]]; }
        } catch {}
      }
    }
    if(!consensusJobs.length)labelJob ||= newestFirst.find((item) => item.platform === 'rules' && item.status === 'completed' && fsSync.existsSync(path.join(item.outputDir, '标注结果.jsonl')) && fsSync.existsSync(path.join(item.outputDir, '标注质量报告.json'))) || null;
    labelJobId = labelJob?.id || '';
  } else if(labelJobId.startsWith('consensus:')) {
    const ids=labelJobId.slice(10).split(',');
    if(ids.length!==2 || ids[0]===ids[1])throw new Error('双平台标签需要两个不同任务');
    consensusJobs=ids.map(id=>compatibleLabelJobs.find(job=>job.id===id));
    if(consensusJobs.some(job=>!job || job.platform==='rules') || consensusJobs[0].platform===consensusJobs[1].platform)throw new Error('请选择同一Excel的两个不同AI平台');
    if(consensusJobs.some(job=>!fsSync.existsSync(path.join(job.outputDir,'标注质量报告.json'))))throw new Error('双平台标签缺少质量报告');
    labelJobId='';
  } else {
    labelJob = labelJobId ? labelJobs.find((item) => item.id === labelJobId && !item.archived) : null;
  }
  if (labelJobId && !labelJob) throw new Error('所选打标任务不存在');
  if (labelJob && path.resolve(labelJob.inputFile).toLowerCase() !== inputFile.toLowerCase()) throw new Error('打标任务与洞察输入 Excel 不是同一文件');
  if (labelJob && (!fsSync.existsSync(path.join(labelJob.outputDir, '标注结果.jsonl')) || !fsSync.existsSync(path.join(labelJob.outputDir, '标注质量报告.json')))) throw new Error('所选打标任务的结果或质量报告缺失');
  if (labelJob?.platform === 'rules' && labelJob.status !== 'completed') throw new Error('本地预标注任务尚未完成，不能作为洞察输入');
  if (labelJob && labelJob.platform !== 'rules') {
    const reviewed = await reviewState(labelJob.outputDir);
    if (![...reviewed.decisions.values()].includes('approved')) throw new Error('所选打标任务尚无人工批准的标签');
  }
  const config = {
    inputFile,
    ...(transferSource ? { sourceTaskId: transferSource.taskId, sourceResolution: transferSource.dataset.resolution, expectedRows: transferSource.dataset.expectedRows } : {}),
    sheetName: String(body.sheetName || '岗位数据').trim() || '岗位数据',
    role: String(body.role || '自动识别').trim() || '自动识别',
    analysisMode: String(body.analysisMode || 'preview') === 'full' ? 'full' : 'preview',
    sampleSize: Math.max(50, Math.min(2000, Number(body.sampleSize || 300))),
    reviewedLabelDir: labelJob && labelJob.platform !== 'rules' ? labelJob.outputDir : '',
    prelabelDir: labelJob?.platform === 'rules' ? labelJob.outputDir : '',
    reviewedLabelJobId: labelJob?.id || '',
    ...(consensusJobs.length ? {consensusLabelDirs:consensusJobs.map(job=>job.outputDir),consensusLabelJobIds:consensusJobs.map(job=>job.id)} : {}),
  };
  await fs.writeFile(insightConfigPath, JSON.stringify(config, null, 2), 'utf8');
  await fs.writeFile(insightLogPath, `[${new Date().toLocaleString('zh-CN')}] 开始分析\n输入：${inputFile}\n模式：${config.analysisMode === 'full' ? '全量逐条匹配' : `抽样 ${config.sampleSize} 条`}\n`, 'utf8');
  await saveInsightState({ status: 'running', message: '正在读取样本并计算岗位洞察', ...config, startedAt: now(), error: '' });
  const child = spawn(process.execPath, [path.join(root, 'work', 'analyze_job_market_sample.mjs'), insightConfigPath, insightReportPath], {
    cwd: root, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  activeInsight = { child, startedAt: Date.now() };
  let analysisError = '';
  child.stdout.on('data', (chunk) => fs.appendFile(insightLogPath, chunk.toString('utf8'), 'utf8').catch(() => {}));
  child.stderr.on('data', (chunk) => {
    analysisError = (analysisError + chunk.toString('utf8')).slice(-16000);
    fs.appendFile(insightLogPath, `[错误] ${chunk.toString('utf8')}`, 'utf8').catch(() => {});
  });
  child.once('error', async (error) => {
    activeInsight = null;
    await saveInsightState({ status: 'failed', message: '岗位洞察启动失败', error: error.message });
  });
  child.once('close', async (code, signal) => {
    activeInsight = null;
    if (code === 0) {
      try {
        const report = JSON.parse(await fs.readFile(insightReportPath, 'utf8'));
        await saveInsightState({ status: 'completed', message: `${report.detected_role?.name || report.role}分析完成：${report.sample_rows}/${report.total_rows} 条`, error: '' });
        await fs.appendFile(insightLogPath, '\n[完成] 岗位市场洞察已生成。\n', 'utf8').catch(() => {});
      } catch (error) {
        await saveInsightState({ status: 'failed', message: '分析程序结束但报告读取失败', error: error.message });
      }
    } else {
      const failure = analysisError.match(/^Error:\s*(.+)$/m)?.[1] || `子进程退出：${code ?? signal}`;
      await saveInsightState({ status: 'failed', message: `岗位洞察分析失败：${failure}`, error: failure });
    }
  });
  return insightState;
}

async function setLabelJob(id, patch) {
  const item = labelJobs.find((job) => job.id === id);
  if (!item) return null;
  Object.assign(item, patch, { updatedAt: now() });
  await saveLabelJobs(labelJobs);
  return item;
}

async function appendLabelLog(id, text) {
  if (!text) return;
  await fs.appendFile(path.join(labelLogDir, `${id}.log`), String(text), 'utf8').catch(() => {});
}

async function readPlatformStatus() {
  try { return JSON.parse(await fs.readFile(platformStatusPath, 'utf8')); }
  catch { return { platforms: {} }; }
}

async function publicPlatforms() {
  const saved = await readPlatformStatus();
  const sessions=await Promise.all(tasks.filter(t=>!t.archived).map(readManualSession));
  const browsers=new Map(await Promise.all(platformDefinitions.map(async p=>[p.key,await managedBrowserState(p.key)])));
  return platformDefinitions.map((platform) => {
    const entry = saved.platforms?.[platform.key] || {};
    const session=sessions.find(s=>s?.platform===platform.key);
    const browser=browsers.get(platform.key);
    return {
      ...platform,
      loginStatus:session?.login_status||(entry.manual_window_closed_at?'saved_unverified':'unknown'),
      verificationStatus:session?.verification_status||'unchecked',
      browserOpen:Boolean(browser),browserSessionId:browser?.session_id||null,
      browserExecutable:browser?.executable_path||null,browserPid:browser?.browser_pid||null,
      browserProfile:browser?.profile_dir||null,
      browserInitialization:browser?.local_initialization||null,browserProxy:browser?.proxy_server||null,
      canSwitchBrowser:platform.key==='yupao'&&Boolean(browser)&&!activeLogins.has(platform.key)&&![...active.values()].some(item=>item.stage==='yupao'),
      status: activeLogins.has(platform.key) ? 'opening' : browser?'browser_open':entry.manual_window_closed_at ? 'saved' : 'not_logged_in',
      message: activeLogins.has(platform.key)?(platform.key==='yupao'?'正在打开鱼泡浏览器；首次访问前会随机等待 3–8 秒，请稍候':'正在打开登录浏览器，请稍候'):browser?(browser.switched_from?'已切换到携带 Cookie 的新浏览器；后续采集复用此实例。请在新窗口检查登录和验证状态':'共享浏览器保持开启；登录和采集复用同一实例，无需关闭窗口'):entry.state || '尚未打开平台共享浏览器',
      updatedAt: browser?.opened_at||entry.browser_opened_at||entry.manual_window_closed_at || null,
    };
  });
}

function startPlatformLogin(key) {
  const platform = platformDefinitions.find((item) => item.key === key);
  if (!platform) throw new Error('不支持的登录平台');
  if (activeLogins.has(key)) throw new Error(`${platform.name}登录窗口已经打开`);
  const child = spawn(process.execPath, [path.join(root, 'work', 'login_job_platforms.mjs'), platformSessionDir, key], {
    cwd: root,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });
  activeLogins.set(key, child);
  child.stdout.on('data', (chunk) => console.log(`[${platform.name}] ${chunk.toString('utf8').trim()}`));
  child.stderr.on('data', (chunk) => console.error(`[${platform.name}] ${chunk.toString('utf8').trim()}`));
  child.once('error', () => activeLogins.delete(key));
  child.once('exit', () => activeLogins.delete(key));
}

async function createLabelJob(body) {
  const inputFile = path.resolve(String(body.inputFile || '').trim());
  if (!inputFile || !fsSync.existsSync(inputFile)) throw new Error('找不到输入Excel文件');
  if (!['.xlsx', '.csv'].includes(path.extname(inputFile).toLowerCase())) throw new Error('仅支持 XLSX 或 UTF-8 标准化 CSV');
  const platform = String(body.platform || 'rules');
  if (!labelPlatforms.includes(platform)) throw new Error('不支持的打标平台');
  const jobFamily = String(body.jobFamily || '').trim();
  if (!jobFamily) throw new Error('请填写目标岗位族，避免将其他岗位套用爬虫标签');
  if (platform === 'rules' && !['爬虫/数据采集', '智能体/大模型应用'].includes(jobFamily)) throw new Error('本地规则预标注仅适用于爬虫/数据采集和智能体/大模型应用；其他岗位族请选择人工登录的 AI 平台并复核');
  const sampleSize = Math.max(1, Math.min(20000, Number(body.sampleSize || 20)));
  const requestedBatchSize = Math.max(1, Math.min(5, Number(body.batchSize || 3)));
  const batchSize = platform === 'kimi' ? 1 : requestedBatchSize;
  const id = `${Date.now()}-label`;
  const stamp = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  const outputDir = path.resolve(String(body.outputDir || path.join(path.dirname(inputFile), `AI打标_${sampleSize}条_${stamp}_${id}`)).trim());
  if (labelJobs.some((job) => path.resolve(job.outputDir).toLowerCase() === outputDir.toLowerCase())) throw new Error('该输出目录已被其他打标任务使用，请为新任务指定独立目录');
  if (fsSync.existsSync(outputDir) && (await fs.readdir(outputDir)).length) throw new Error('新打标任务的输出目录必须为空，避免覆盖已有结果');
  const configDir = path.join(labelDataDir, id);
  await fs.mkdir(configDir, { recursive: true });
  await fs.mkdir(outputDir, { recursive: true });
  const configPath = path.join(configDir, '打标配置.json');
  const config = {
    inputFile, outputDir, sheetName: String(body.sheetName || '岗位数据'), platform, jobFamily, sampleSize, batchSize,
    samplingMode: platform === 'rules' ? 'first' : 'spread',
    ...labelPolicy(platform, body),
    platformRuntimePath: path.join(labelPlatformRuntimeDir, `${platform}.json`),
    navigationTimeoutMs: Math.max(45000, Math.min(300000, Number(body.navigationTimeoutMs || 120000))),
    inputTimeoutMs: Math.max(10000, Math.min(120000, Number(body.inputTimeoutMs || 45000))),
    cooldownJitterRatio: 0.35,
    typingChunkMinChars: 120,
    typingChunkMaxChars: 260,
    typingPauseMinMs: platform === 'kimi' ? 60 : 35,
    typingPauseMaxMs: platform === 'kimi' ? 180 : 140,
    beforeSendMinMs: 900,
    beforeSendMaxMs: platform === 'kimi' ? 3200 : 2400,
  };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
  const platformName = platform === 'rules' ? '本地规则预标注' : platformDefinitions.find((item) => item.key === platform)?.name || platform;
  const item = {
    id, name: String(body.name || `${path.basename(inputFile, path.extname(inputFile))} · ${platformName}`).trim(),
    inputFile, outputDir, sheetName: config.sheetName, platform, platformName, jobFamily, sampleSize, batchSize, configPath,
    status: 'ready', message: '打标任务已创建', createdAt: now(), updatedAt: now(), archived: false,
  };
  labelJobs.unshift(item);
  await saveLabelJobs(labelJobs);
  await appendLabelLog(id, `[${new Date().toLocaleString('zh-CN')}] 打标任务已创建\n输入：${inputFile}\n输出：${outputDir}\n`);
  return item;
}

async function labelMetrics(item) {
  try {
    const report = JSON.parse(await fs.readFile(path.join(item.outputDir, '标注质量报告.json'), 'utf8'));
    return {
      total: Number(report.requested_rows || item.sampleSize), completed: Number(report.completed_rows || 0),
      failed: Number(report.failed_rows || 0), averageConfidence: Number(report.average_confidence || 0),
      riskRows: Number(report.risk_signal_rows || 0), schemaSuccessRate: Number(report.schema_success_rate || 0),
      skillsCoverageRate: Number(report.skills_coverage_rate || 0), tasksCoverageRate: Number(report.tasks_coverage_rate || 0),
      evidenceCoverageRate: Number(report.evidence_coverage_rate || 0), elapsedSeconds: Number(report.elapsed_seconds || 0),
      rowsPerMinute: Number(report.rows_per_minute || 0),
    };
  } catch {
    let completed = 0;
    try { completed = (await fs.readFile(path.join(item.outputDir, '标注结果.jsonl'), 'utf8')).split(/\r?\n/).filter(Boolean).length; } catch {}
    return { total: item.sampleSize, completed, failed: 0, averageConfidence: 0, riskRows: 0, schemaSuccessRate: 0, skillsCoverageRate: 0, tasksCoverageRate: 0, evidenceCoverageRate: 0, elapsedSeconds: 0, rowsPerMinute: 0 };
  }
}

async function publicLabelJob(item) {
  const running = activeLabels.get(item.id);
  const ownRuntime = await fs.readFile(path.join(item.outputDir, '平台运行状态.json'), 'utf8').then(JSON.parse).catch(() => null);
  const platformRuntime = item.platform === 'rules' ? null : await fs.readFile(path.join(labelPlatformRuntimeDir, `${item.platform}.json`), 'utf8').then(JSON.parse).catch(() => null);
  const runtime = platformRuntime?.status === 'paused' && item.status !== 'completed' ? platformRuntime : ownRuntime;
  const resultsMissing = ['completed', 'partial'].includes(item.status) && !fsSync.existsSync(path.join(item.outputDir, '标注结果.jsonl'));
  return {
    id: item.id, name: item.name, inputFile: item.inputFile, outputDir: item.outputDir, sheetName: item.sheetName,
    platform: item.platform, platformName: item.platformName, jobFamily: item.jobFamily || '', sampleSize: item.sampleSize, batchSize: item.batchSize,
    status: item.status, message: resultsMissing ? '历史结果文件缺失，请检查输出目录；不会显示为已完成标签' : item.message, resultsMissing, createdAt: item.createdAt, updatedAt: item.updatedAt,
    runningSeconds: running ? Math.floor((Date.now() - running.startedAt) / 1000) : 0,
    metrics: await labelMetrics(item),
    runtime,
  };
}

async function runLabelJob(item, options = {}) {
  if (startingLabels.has(item.id) || activeLabels.has(item.id)) throw new Error('该打标任务已经在启动或运行');
  if (item.platform !== 'rules' && [...startingLabels.values(), ...activeLabels.values()].some(run => run.platform === item.platform)) throw new Error(`为保护账号，${item.platformName}同一时间仅运行一个打标任务`);
  startingLabels.set(item.id, { platform: item.platform });
  try { return await launchLabelJob(item, options); }
  finally { startingLabels.delete(item.id); }
}

async function launchLabelJob(item, options = {}) {
  if (activeLabels.has(item.id)) throw new Error('该打标任务已经在运行');
  if (!fsSync.existsSync(item.inputFile)) throw new Error(`输入 Excel 已不存在：${item.inputFile}。请创建使用新路径的任务，勿覆盖旧任务记录。`);
  if (item.platform !== 'rules') {
    if (activeLogins.has(item.platform)) throw new Error('该平台共享浏览器正在打开，请稍后启动打标；无需关闭浏览器');
    const webRuns = [...activeLabels.values()].filter((running) => running.platform !== 'rules');
    if (webRuns.some((running) => running.platform === item.platform)) throw new Error(`为保护账号，${item.platformName}同一时间仅运行一个打标任务`);
    if (webRuns.length >= 5) throw new Error('为控制风控风险，同一时间最多运行五个不同聊天平台');
    const runtimePath = path.join(labelPlatformRuntimeDir, `${item.platform}.json`);
    const saved = await fs.readFile(runtimePath, 'utf8').then(JSON.parse).catch(() => null);
    const block = resumeBlock(saved);
    if (block) {
      const cooling = saved.retryAfter && Date.parse(saved.retryAfter) > Date.now();
      if (cooling || !options.confirmedHumanResolution) throw new Error(block);
      await fs.writeFile(runtimePath, JSON.stringify({ ...saved, status: 'ready', requiresHuman: false, confirmedAt: now() }, null, 2), 'utf8');
    }
  }
  // Migrate old task configuration at run time so safety policy also covers legacy jobs.
  const savedConfig = JSON.parse(await fs.readFile(item.configPath, 'utf8'));
  if (!item.jobFamily && savedConfig.jobFamily) await setLabelJob(item.id, { jobFamily: savedConfig.jobFamily });
  if (item.batchSize !== labelPolicy(item.platform, savedConfig).batchSize) await setLabelJob(item.id, { batchSize: labelPolicy(item.platform, savedConfig).batchSize });
  await fs.writeFile(item.configPath, JSON.stringify({ ...savedConfig, ...labelPolicy(item.platform, savedConfig), platformRuntimePath: path.join(labelPlatformRuntimeDir, `${item.platform}.json`) }, null, 2), 'utf8');
  await setLabelJob(item.id, { status: 'running', message: `${item.platformName}打标中` });
  await appendLabelLog(item.id, `\n[${new Date().toLocaleString('zh-CN')}] ▶ ${item.platformName}打标\n`);
  const child = spawn(process.execPath, [path.join(root, 'work', 'label_job_data.mjs'), item.configPath], {
    cwd: root,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: item.platform === 'rules',
  });
  activeLabels.set(item.id, { child, platform: item.platform, startedAt: Date.now() });
  child.stdout.on('data', (chunk) => appendLabelLog(item.id, chunk.toString('utf8')));
  child.stderr.on('data', (chunk) => appendLabelLog(item.id, `[错误] ${chunk.toString('utf8')}`));
  child.once('error', async (error) => {
    activeLabels.delete(item.id);
    await setLabelJob(item.id, { status: 'failed', message: error.message });
  });
  child.once('exit', async (code, signal) => {
    const stopping = labelJobs.find((job) => job.id === item.id)?.status === 'stopping';
    activeLabels.delete(item.id);
    if (stopping) {
      await setLabelJob(item.id, { status: 'paused', message: '已暂停，可从已保存结果续标' });
      return;
    }
    if (code === 0) {
      await setLabelJob(item.id, { status: 'completed', message: '打标与质量汇总已完成' });
      await appendLabelLog(item.id, '\n[完成] 打标结果已保存。\n');
    } else {
      const runtime = await fs.readFile(path.join(item.outputDir, '平台运行状态.json'), 'utf8').then(JSON.parse).catch(() => null);
      const report = await fs.readFile(path.join(item.outputDir, '标注质量报告.json'), 'utf8').then(JSON.parse).catch(() => null);
      await setLabelJob(item.id, { status: runtime?.status === 'paused' ? 'paused' : 'failed', message: runtime?.status === 'paused' ? `${runtime.errorCode}：${runtime.recovery}` : report?.last_error || `打标程序退出，代码 ${code ?? signal}` });
    }
  });
}

async function appendLog(id, text) {
  const value = String(text || '');
  if (!value) return;
  await fs.appendFile(path.join(logDir, `${id}.log`), value, 'utf8').catch(() => {});
}

async function setTask(id, patch) {
  const task = tasks.find((item) => item.id === id);
  if (!task) return null;
  Object.assign(task, patch, { updatedAt: now() });
  await saveTasks(tasks);
  return task;
}

function runtimePython() {
  const candidates = [
    process.env.JOB_UI_PYTHON,
    path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe'),
    'python',
  ].filter(Boolean);
  return candidates.find((candidate) => candidate === 'python' || fsSync.existsSync(candidate)) || 'python';
}

function stageCommand(task, stage) {
  if (stage === 'public') return {
    command: process.execPath,
    args: [path.join(root, 'work', 'collect_public_job_platforms.mjs'), task.publicConfigPath, task.outputDir],
  };
  if (stage === 'zhaopin') return {
    command: process.execPath,
    args: [path.join(root, 'work', 'collect_logged_zhaopin_batch.mjs'), task.outputDir, String(task.candidateTarget), task.zhaopinConfigPath],
  };
  if (stage === 'yupao') return {
    command: process.execPath,
    args: [path.join(root, 'work', 'collect_logged_yupao.mjs'), task.outputDir, task.yupaoConfigPath],
  };
  if (stage === 'boss') return {
    command: process.execPath,
    args: [path.join(root, 'work', 'collect_logged_boss.mjs'), task.outputDir, task.bossConfigPath],
  };
  if (['login_zhaopin', 'login_yupao', 'login_boss'].includes(stage)) return {
    command: process.execPath,
    args: [path.join(root, 'work', 'login_job_platforms.mjs'), task.outputDir, stage.replace('login_', '')],
  };
  if (stage === 'finalize') return {
    command: runtimePython(),
    args: [path.join(root, 'work', 'finalize_configurable_dataset.py'), task.outputDir, task.profilePath, String(task.targetRows)],
  };
  if (stage === 'workbook') return {
    command: process.execPath,
    args: [path.join(root, 'work', 'build_configurable_job_workbook.mjs'), task.outputDir, task.profilePath],
  };
  throw new Error(`未知阶段：${stage}`);
}

const stageNames = {
  public: '公开渠道采集', zhaopin: '智联登录采集', yupao: '鱼泡登录采集',
  boss: 'BOSS页面采集（试验）', login_boss: 'BOSS人工登录',
  login_zhaopin: '智联人工登录', login_yupao: '鱼泡人工验证/登录', finalize: '合并去重', workbook: '导出Excel',
};

async function runChild(task, stage, pipeline = false) {
  if (active.has(task.id)||startingStages.has(task.id)) throw new Error('该任务已有程序正在运行或正在检查启动条件');
  const profileKey=stage.replace('login_','');
  if(activeLogins.has(profileKey)||[...active.values()].some(item=>item.stage==='login_'+profileKey || (stage.startsWith('login_')&&item.stage===profileKey))) throw new Error('该平台浏览器正在使用，请勿同时打开登录和采集会话');
  if (['boss','login_boss'].includes(stage) && (startingBoss || activeLogins.has('boss') || [...active.values()].some(item => ['boss','login_boss'].includes(item.stage)))) throw new Error('BOSS使用独立本地会话，同一时间只能登录或采集一个任务');
  if (stage === 'zhaopin' && (
    [...active.values()].some((item) => item.stage === 'zhaopin')
    || tasks.some((item) => item.id !== task.id && item.status === 'running' && item.currentStage === 'zhaopin')
  )) {
    throw new Error('为保护账号，同一时间只能运行一个智联采集任务');
  }
  if (stage === 'yupao' && (
    [...active.values()].some((item) => item.stage === 'yupao')
    || tasks.some((item) => item.id !== task.id && item.status === 'running' && item.currentStage === 'yupao')
  )) {
    throw new Error('鱼泡验证较严格，同一时间只能运行一个鱼泡采集任务');
  }
  const { command, args } = stageCommand(task, stage);
  startingStages.add(task.id);
  try { await assertCollectorResources(stage === 'workbook' ? 4*1024**3 : stage === 'finalize' ? 1024**3 : 2*1024**3); }
  catch(error) {
    startingStages.delete(task.id);
    await appendLog(task.id, `\n[资源保护暂停] ${error.message}\n`);
    await setTask(task.id,{status:'paused',currentStage:stage,lastStage:stage,pipeline:false,message:error.message});
    return {paused:true,code:43};
  }
  const isBoss = ['boss','login_boss'].includes(stage);
  if (isBoss) startingBoss = true;
  try {
    await setTask(task.id, { status: 'running', currentStage: stage, message: `${stageNames[stage]}运行中`, pipeline });
    await appendLog(task.id, `\n[${new Date().toLocaleString('zh-CN')}] ▶ ${stageNames[stage]}\n`);
  } catch (error) { startingStages.delete(task.id); if (isBoss) startingBoss = false; throw error; }

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, JOB_COLLECTOR_TASK_ID:task.id, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      windowsHide: stage !== 'login',
    });
    active.set(task.id, { child, stage, startedAt: Date.now() });
    startingStages.delete(task.id);
    if (isBoss) startingBoss = false;
    const pipe = (stream, prefix = '') => stream.on('data', (chunk) => appendLog(task.id, `${prefix}${chunk.toString('utf8')}`));
    pipe(child.stdout);
    pipe(child.stderr, '[错误] ');
    child.once('error', async (error) => {
      active.delete(task.id);
      await appendLog(task.id, `\n启动失败：${error.message}\n`);
      await setTask(task.id, { status: 'failed', message: error.message, pipeline: false });
      reject(error);
    });
    child.once('exit', async (code, signal) => {
      const wasPaused = tasks.find((item) => item.id === task.id)?.status === 'stopping';
      active.delete(task.id);
      if (wasPaused) {
        await appendLog(task.id, `\n[已暂停] 下次运行将复用同一输出目录和断点文件。\n`);
        await setTask(task.id, { status: 'paused', message: '已暂停，可从断点续爬', pipeline: false, lastStage: stage });
        resolve({ paused: true, code, signal });
      } else if (code === 43 || nativeCrashMessage(code)) {
        const message=code === 43?'系统资源不足，采集已安全暂停；请释放资源后从当前阶段断点续采':nativeCrashMessage(code);
        await appendLog(task.id,`\n[资源/原生异常暂停] ${message}\n`);
        await setTask(task.id,{status:'paused',message,pipeline:false,lastStage:stage});
        resolve({paused:true,code});
      } else if (['boss','public','zhaopin','yupao'].includes(stage) && code === 42) {
        await setTask(task.id, { status: 'paused', message: `${stageNames[stage]}暂停：请查看日志和断点状态，人工处理登录、验证、文件占用或页面异常后再续爬`, pipeline: false, lastStage: stage });
        resolve({ paused: true, code });
      } else if (code === 0) {
        await appendLog(task.id, `\n[完成] ${stageNames[stage]}\n`);
        await setTask(task.id, { status: pipeline ? 'running' : 'ready', message: `${stageNames[stage]}已完成`, lastStage: stage });
        resolve({ code });
      } else {
        const message = `${stageNames[stage]}退出，代码 ${code ?? signal}`;
        await appendLog(task.id, `\n[失败] ${message}\n`);
        await setTask(task.id, { status: 'failed', message, pipeline: false, lastStage: stage });
        reject(new Error(message));
      }
    });
  });
}

async function runPipeline(task, resumeFrom = '') {
  const stages = [];
  const publicPlatforms = ['shixiseng', 'iguopin', 'mohrss', 'job51', 'jobonline'];
  if (task.platforms.some((key) => publicPlatforms.includes(key))) stages.push('public');
  if (task.platforms.includes('zhaopin')) stages.push('zhaopin');
  if (task.platforms.includes('yupao')) stages.push('yupao');
  if (task.platforms.includes('boss')) stages.push('boss');
  stages.push('finalize', 'workbook');
  if (resumeFrom) {
    const start = stages.indexOf(resumeFrom);
    if (start < 0) throw new Error('流水线恢复阶段不属于该任务');
    stages.splice(0, start);
  }
  try {
    for (const stage of stages) {
      const fresh = taskById(tasks, task.id);
      if (!fresh || fresh.status === 'paused' || fresh.status === 'stopping') return;
      const result = await runChild(fresh, stage, true);
      if (result.paused) return;
    }
    const fresh = taskById(tasks, task.id) || task;
    const metrics = await metricsFor(fresh);
    if (metrics.targetReached) {
      await setTask(task.id, { status: 'completed', currentStage: '', message: '采集、合并与导出全部完成', pipeline: false });
    } else {
      await appendLog(task.id, `\n[本轮完成] 最终 ${metrics.finalRows}/${fresh.targetRows} 条，尚未达到目标；可调整关键词/城市后续爬。\n`);
      await setTask(task.id, {
        status: 'partial', currentStage: '', pipeline: false,
        message: `本轮已导出 ${metrics.finalRows} 条，尚未达到 ${fresh.targetRows} 条目标`,
      });
    }
  } catch (error) {
    await appendLog(task.id, `\n流水线停止：${error.message}\n`);
  }
}

async function runSingle(task, stage) {
  try {
    await runChild(task, stage, false);
    if (stage === 'workbook') {
      const fresh = taskById(tasks, task.id) || task;
      const metrics = await metricsFor(fresh);
      await setTask(task.id, metrics.targetReached
        ? { status: 'completed', message: 'Excel 已导出，目标数据量已达到', currentStage: '' }
        : {
            status: 'partial', currentStage: '',
            message: `Excel 已导出 ${metrics.finalRows} 条，尚未达到 ${fresh.targetRows} 条目标`,
          });
    }
  } catch {}
}

async function createTask(body) {
  const label = String(body.label || '').trim();
  const primaryKeyword = String(body.primaryKeyword || label).trim();
  const keywords = splitTerms(body.keywords);
  if (!label || !primaryKeyword) throw new Error('请填写岗位名称和主关键词');
  if (!keywords.includes(primaryKeyword)) keywords.unshift(primaryKeyword);
  const targetRows = Math.max(1, Math.min(100000, Number(body.targetRows || 5000)));
  const candidateTarget = Math.max(targetRows, Math.min(150000, Number(body.candidateTarget || Math.ceil(targetRows * 1.55))));
  const cityNames = splitTerms(body.cities).filter((name) => zhaopinCities[name]);
  if (!cityNames.length) cityNames.push('北京', '上海', '广州', '深圳', '杭州', '成都');
  const allowedPlatforms = ['shixiseng', 'iguopin', 'mohrss', 'job51', 'jobonline', 'zhaopin', 'yupao', 'boss'];
  const platforms = splitTerms(body.platforms).filter((value) => allowedPlatforms.includes(value));
  if (!platforms.length) throw new Error('至少选择一个采集渠道');
  const stamp = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  const defaultOutput = path.join(os.homedir(), 'Desktop', `${safeName(label)}岗位_${targetRows}条_${stamp}`);
  const outputBaseDir = path.resolve(String(body.outputDir || defaultOutput).trim());
  const id = `${Date.now()}-${safeName(label).replace(/\s+/g, '-').slice(0, 32) || 'task'}`;
  const outputDir=isolatedDirectory(outputBaseDir,id);
  const configDir = path.join(taskDataDir, id);
  await fs.mkdir(configDir, { recursive: true });
  await fs.mkdir(outputDir, { recursive: true });

  const pace = String(body.pace || 'balanced');
  const requestSettings = pace === 'safe'
    ? { concurrency: 1, minimumIntervalMs: 900, jitterMs: 600, attempts: 4 }
    : pace === 'fast'
      ? { concurrency: 3, minimumIntervalMs: 350, jitterMs: 200, attempts: 4 }
      : { concurrency: 2, minimumIntervalMs: 550, jitterMs: 350, attempts: 4 };
  const publicCity = { name: '全国', code: '全国' };
  const publicConfig = {
    task_id:id,
    keywords: [primaryKeyword],
    platforms: {
      shixiseng: { enabled: platforms.includes('shixiseng'), cities: [publicCity] },
      zhaopin: { enabled: false, cities: [] },
      job51: { enabled: platforms.includes('job51'), cities: cityNames.map((name) => ({ name, code: job51Cities[name] })).filter((item) => item.code) },
      jobonline: { enabled: platforms.includes('jobonline'), cities: [publicCity], maxPages: 10, maxRows: Math.min(candidateTarget,1000) },
      iguopin: { enabled: platforms.includes('iguopin'), cities: [{ name: '全国', code: '' }] },
      mohrss: { enabled: platforms.includes('mohrss'), cities: [{ name: '全国', code: '' }] },
    },
    request: requestSettings,
  };
  const zhaopinConfig = { task_id:id,keywords, cities: cityNames.map((name) => ({ name, code: zhaopinCities[name] })) };
  const bossConfig = {
    task_id:id,
    keywords, cities: cityNames.map(name => ({ name, code: bossCities[name] })),
    maxPagesPerCombo: 3, maxRows: Math.min(candidateTarget, 100),
    minimumIntervalMs: 6000, jitterMs: 2000, sessionStatusPath: platformStatusPath,
  };
  const yupaoConfig = {
    task_id:id,
    keywords,
    cities: cityNames.map((name) => ({ name })),
    maxPagesPerCombo: pace === 'safe' ? 12 : pace === 'fast' ? 24 : 18,
    detailLimitPerCombo: pace === 'safe' ? 80 : pace === 'fast' ? 160 : 120,
    minimumIntervalMs: pace === 'safe' ? 3200 : pace === 'fast' ? 1600 : 2400,
    jitterMs: pace === 'safe' ? 1800 : pace === 'fast' ? 900 : 1400,
  };
  const profile = {
    task_id:id,collection_relevance_filter:false,
    label,
    primary_keyword: primaryKeyword,
    keywords,
    target_rows: targetRows,
    source_directories: splitTerms(body.sourceDirectories),
    relevance: {
      title_terms: splitTerms(body.titleTerms).length ? splitTerms(body.titleTerms) : keywords,
      direct_terms: splitTerms(body.directTerms).length ? splitTerms(body.directTerms) : keywords,
      skill_terms: splitTerms(body.skillTerms),
      role_terms: splitTerms(body.roleTerms).length ? splitTerms(body.roleTerms) : ['开发', '工程师', '架构', '研发', '技术', '程序员', '实习'],
      exclude_terms: splitTerms(body.excludeTerms),
      allow_platform_match: body.allowPlatformMatch !== false,
      levels: ['标题直接匹配', '职责直接匹配', '技术栈匹配', '平台关键词匹配'],
    },
  };
  const publicConfigPath = path.join(configDir, '公开渠道配置.json');
  const zhaopinConfigPath = path.join(configDir, '智联批量配置.json');
  const yupaoConfigPath = path.join(configDir, '鱼泡批量配置.json');
  const bossConfigPath = path.join(configDir, 'BOSS批量配置.json');
  const profilePath = path.join(configDir, '岗位配置.json');
  await fs.writeFile(publicConfigPath, JSON.stringify(publicConfig, null, 2), 'utf8');
  await fs.writeFile(zhaopinConfigPath, JSON.stringify(zhaopinConfig, null, 2), 'utf8');
  await fs.writeFile(yupaoConfigPath, JSON.stringify(yupaoConfig, null, 2), 'utf8');
  await fs.writeFile(bossConfigPath, JSON.stringify(bossConfig, null, 2), 'utf8');
  await fs.writeFile(profilePath, JSON.stringify(profile, null, 2), 'utf8');
  await fs.copyFile(profilePath, path.join(outputDir, '岗位配置.json'));
  await fs.writeFile(path.join(outputDir,'任务归属.json'),JSON.stringify({task_id:id,label},null,2),'utf8');

  const task = {
    id, label, primaryKeyword, keywords, targetRows, candidateTarget, cities: cityNames, platforms, pace,
    outputDir, outputBaseDir,datasetScopeVersion:2, configDir, publicConfigPath, zhaopinConfigPath, yupaoConfigPath, bossConfigPath, profilePath,
    status: 'ready', currentStage: '', message: '任务已创建', createdAt: now(), updatedAt: now(), archived: false,
  };
  tasks.unshift(task);
  await saveTasks(tasks);
  await appendLog(id, `[${new Date().toLocaleString('zh-CN')}] 任务已创建\n输出目录：${outputDir}\n`);
  return task;
}

async function countCsvRows(filePath) {
  try {
    const stat = await fs.stat(filePath);
    const cached = rowCountCache.get(filePath);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.rows;
    const stream = fsSync.createReadStream(filePath);
    let rows = 0;
    let quoted = false;
    let pendingQuote = false;
    for await (const chunk of stream) {
      // Parse bytes so UTF-8 characters split across chunks cannot affect CSV
      // record counting. pendingQuote also handles escaped quotes across chunks.
      for (const byte of chunk) {
        if (byte === 34) {
          if (!quoted) quoted = true;
          else pendingQuote = !pendingQuote;
          continue;
        }
        if (quoted && pendingQuote) {
          quoted = false;
          pendingQuote = false;
        }
        if (byte === 10 && !quoted) rows += 1;
      }
    }
    // Writer output has no trailing newline: newline separators equal data rows
    // (header + N data records have N separators).
    const value = Math.max(0, rows);
    rowCountCache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, rows: value });
    return value;
  } catch { return 0; }
}

async function metricsFor(task) {
  let quality = null;
  let manifest = null;
  try { quality = JSON.parse(await fs.readFile(path.join(task.outputDir, '数据质量报告.json'), 'utf8')); } catch {}
  try { manifest = JSON.parse(await fs.readFile(path.join(task.outputDir, '采集清单.json'), 'utf8')); } catch {}
  quality=ownedReport(quality,task)?quality:null;
  manifest=ownedReport(manifest,task)?manifest:null;
  const publicRows = Number(manifest?.total_rows || 0);
  const zhaopinRows = await countCsvRows(path.join(task.outputDir, 'zhaopin_标准化数据.csv'));
  const yupaoRows = await countCsvRows(path.join(task.outputDir, 'yupao_标准化数据.csv'));
  const bossRows = await countCsvRows(path.join(task.outputDir, 'boss_标准化数据.csv'));
  const finalRows = Number(quality?.output_rows || 0);
  return {
    publicRows, zhaopinRows, yupaoRows, bossRows, finalRows,
    hasFinalResult:Boolean(quality),finalResultMessage:quality?'本任务最终结果':'本任务尚未生成最终结果',
    candidates: publicRows + zhaopinRows + yupaoRows + bossRows,
    targetReached: Boolean(quality?.target_reached),
    duplicatesRemoved: Number(quality?.duplicates_removed || 0),
    platformCounts: quality?.platform_counts || {},
  };
}

async function readManualSession(task) {
  const running=active.get(task.id);
  if(!['zhaopin','yupao'].includes(running?.stage))return null;
  const session=await fs.readFile(path.join(task.outputDir,sessionFileName(running.stage)),'utf8').then(JSON.parse).catch(()=>null);
  return session?.task_id===task.id && session.pid===running.child.pid && session.browser_open ? session : null;
}
async function publicTask(task) {
  const running = active.get(task.id);
  const browserSession=await readManualSession(task);
  return {
    id: task.id, label: task.label, primaryKeyword: task.primaryKeyword, keywords: task.keywords,
    targetRows: task.targetRows, candidateTarget: task.candidateTarget, cities: task.cities, platforms: task.platforms,
    pace: task.pace, outputDir: task.outputDir, legacyOutputDir:task.legacyOutputDir||null,status: task.status, currentStage: task.currentStage,
    message: browserSession?.verification_status==='waiting_human'?'等待人工验证：请处理已打开的搜索页，不要关闭浏览器，完成后点击继续当前会话':task.message, createdAt: task.createdAt, updatedAt: task.updatedAt,
    browserSession,
    runningSeconds: running ? Math.floor((Date.now() - running.startedAt) / 1000) : 0,
    metrics: await metricsFor(task),
  };
}

function json(res, status, value) {
  const data = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data), 'cache-control': 'no-store' });
  res.end(data);
}

async function bodyJson(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 2_000_000) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

async function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const target = path.resolve(publicDir, relative);
  if (!target.startsWith(publicDir)) return json(res, 403, { error: '禁止访问' });
  try {
    const content = await fs.readFile(target);
    const ext = path.extname(target);
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.geojson': 'application/geo+json; charset=utf-8' };
    res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(content);
  } catch { json(res, 404, { error: '未找到' }); }
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${host}:${port}`);
  const pathname = decodeURIComponent(requestUrl.pathname);
  try {
    if (req.method === 'GET' && pathname === '/api/state') {
      const visible = tasks.filter((task) => !task.archived);
      return json(res, 200, { tasks: await Promise.all(visible.map(publicTask)), version: '1.9.6', capabilities: { bossCollection: true, jobonlineCollection: true, publicChannelCheckpoints: true, nativeDatasets: true, labelReview: true, labelPacing: true, resourceRouting: true, insightSelection: true, taskInsightTransfer: true, finalDatasetCatalog: true }, activeCount: active.size });
    }
    if (req.method === 'GET' && pathname === '/api/insights/datasets') {
      return json(res, 200, { root: insightDatasetRoot, catalog: 'final-only-v1', datasets: await discoverInsightDatasets() });
    }
    if (req.method === 'GET' && pathname === '/api/insights') {
      return json(res, 200, await publicInsight());
    }
    if (req.method === 'POST' && pathname === '/api/insights/run') {
      const body = await bodyJson(req);
      return json(res, 202, { ok: true, state: await startInsight(body), message: String(body.analysisMode || '') === 'full' ? '全量岗位匹配分析已启动' : '抽样分析已启动' });
    }
    if (req.method === 'GET' && pathname === '/api/insights/logs') {
      let content = '';
      try { content = await fs.readFile(insightLogPath, 'utf8'); } catch {}
      return json(res, 200, { content: content.slice(-100000) });
    }
    if (req.method === 'GET' && pathname === '/api/platforms') {
      return json(res, 200, { platforms: await publicPlatforms() });
    }
    if (req.method === 'POST' && pathname === '/api/platforms/yupao/switch-browser') {
      if(activeLogins.has('yupao')||[...active.values()].some(item=>item.stage==='yupao'))return json(res,409,{error:'鱼泡登录或采集正在运行，请等待登录完成或暂停采集后再切换'});
      if(!await managedBrowserState('yupao'))return json(res,409,{error:'请先打开鱼泡登录浏览器，登录后再切换'});
      activeLogins.set('yupao',{kill(){}});
      try{
        const browser=await switchManagedBrowser('yupao');
        return json(res,200,{ok:true,browserSessionId:browser.session_id,message:'Cookie 已迁移到新浏览器，后续鱼泡采集将复用此实例；请在新窗口确认登录状态'});
      }finally{activeLogins.delete('yupao');}
    }
    const platformLoginMatch = pathname.match(/^\/api\/platforms\/([^/]+)\/login$/);
    if (req.method === 'POST' && platformLoginMatch) {
      startPlatformLogin(platformLoginMatch[1]);
      return json(res, 202, { ok: true, message: platformLoginMatch[1]==='yupao'?'将打开或聚焦鱼泡浏览器；首次访问前随机等待 3–8 秒，再由你人工登录和验证':'将打开或聚焦共享浏览器，请人工登录和验证；无需关闭窗口，采集将复用同一实例' });
    }
    if (req.method === 'GET' && pathname === '/api/labels') {
      const visible = labelJobs.filter((item) => !item.archived);
      return json(res, 200, { jobs: await Promise.all(visible.map(publicLabelJob)), activeCount: activeLabels.size });
    }
    if (req.method === 'POST' && pathname === '/api/labels') {
      return json(res, 201, { job: await createLabelJob(await bodyJson(req)) });
    }
    const labelResourceMatch = pathname.match(/^\/api\/labels\/([^/]+)$/);
    if (req.method === 'GET' && labelResourceMatch) {
      const item = labelJobs.find(job => job.id === labelResourceMatch[1] && !job.archived);
      return item ? json(res, 200, { job: await publicLabelJob(item) }) : json(res, 404, { error: '打标任务不存在' });
    }
    const labelReviewMatch = pathname.match(/^\/api\/labels\/([^/]+)\/review$/);
    if (labelReviewMatch) {
      const item = labelJobs.find((job) => job.id === labelReviewMatch[1] && !job.archived);
      if (!item) return json(res, 404, { error: '打标任务不存在' });
      const state = await reviewState(item.outputDir);
      if (req.method === 'GET') {
        const audit = selectReviewAuditRows(state.records, state.decisions, 12);
        return json(res, 200, {
          total: state.records.length,
          approved: [...state.decisions.values()].filter((decision) => decision === 'approved').length,
          rejected: [...state.decisions.values()].filter((decision) => decision === 'rejected').length,
          pending: audit.pending,
          rows: audit.rows.map((record) => ({ row_no: record.row_no, job_id: record.job_id, job_name: record.job_name, skills_text: String(record.skills_text || '').slice(0, 700), job_description: String(record.job_description || '').slice(0, 1400), skills: record.skills || [], tasks: record.tasks || [], evidence_json: (record.evidence_json || []).slice(0, 8), label_status: record.label_status, relevance_grade: record.relevance_grade, confidence: record.confidence, employment_type: record.employment_type, evidence_coverage: record.evidence_coverage })),
        });
      }
      if (req.method === 'POST') {
        const body = await bodyJson(req);
        if (!['approved', 'rejected'].includes(body.decision)) throw new Error('复核决定无效');
        const record = state.records.find((candidate) => Number(candidate.row_no) === Number(body.row_no) && String(candidate.job_id) === String(body.job_id));
        if (!record) throw new Error('标注记录不存在或已变化，请刷新');
        await fs.appendFile(state.reviewPath, `${JSON.stringify({ row_no: record.row_no, job_id: record.job_id, label_digest: labelDigest(record), decision: body.decision, reviewer: '本机人工复核', reviewed_at: now() })}\n`, 'utf8');
        return json(res, 200, { ok: true, message: body.decision === 'approved' ? '已批准该条标签' : '已驳回该条标签' });
      }
    }
    const labelActionMatch = pathname.match(/^\/api\/labels\/([^/]+)\/(run|pause|open|archive)$/);
    if (req.method === 'POST' && labelActionMatch) {
      const [, id, action] = labelActionMatch;
      const item = labelJobs.find((job) => job.id === id && !job.archived);
      if (!item) return json(res, 404, { error: '打标任务不存在' });
      if (action === 'run') {
        if (['running', 'stopping'].includes(item.status)) throw new Error('该打标任务已经在运行');
        await runLabelJob(item, await bodyJson(req));
        return json(res, 202, { ok: true, message: '打标任务已启动' });
      }
      if (action === 'pause') {
        const running = activeLabels.get(id);
        if (!running) return json(res, 409, { error: '打标任务当前未运行' });
        await setLabelJob(id, { status: 'stopping', message: '正在保存进度并停止' });
        if (process.platform === 'win32') spawn('taskkill', ['/PID', String(running.child.pid), '/T', '/F'], { windowsHide: true });
        else running.child.kill('SIGTERM');
        return json(res, 202, { ok: true, message: '正在暂停，已完成结果可继续使用' });
      }
      if (action === 'open') {
        spawn('explorer.exe', [item.outputDir], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
        return json(res, 200, { ok: true });
      }
      if (action === 'archive') {
        if (activeLabels.has(id)) throw new Error('请先暂停打标任务');
        item.archived = true;
        await saveLabelJobs(labelJobs);
        return json(res, 200, { ok: true, message: '任务已从列表移除，结果文件未删除' });
      }
    }
    const labelLogMatch = pathname.match(/^\/api\/labels\/([^/]+)\/logs$/);
    if (req.method === 'GET' && labelLogMatch) {
      let content = '';
      try { content = await fs.readFile(path.join(labelLogDir, `${labelLogMatch[1]}.log`), 'utf8'); } catch {}
      return json(res, 200, { content: content.slice(-180000) });
    }
    if (req.method === 'POST' && pathname === '/api/tasks') {
      return json(res, 201, { task: await createTask(await bodyJson(req)) });
    }
    if (req.method === 'GET' && pathname === '/api/tasks') {
      return json(res, 200, { tasks: await Promise.all(tasks.filter(task => !task.archived).map(publicTask)), activeCount: active.size });
    }
    const taskResourceMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
    const taskInsightMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/insight-source$/);
    if (req.method === 'GET' && taskInsightMatch) {
      const item = taskById(tasks, taskInsightMatch[1]);
      if (!item || item.archived) return json(res, 404, { error: '采集任务不存在' });
      return json(res, 200, await taskInsightSource(item));
    }
    if (req.method === 'GET' && taskResourceMatch) {
      const item = taskById(tasks, taskResourceMatch[1]);
      return item && !item.archived ? json(res, 200, { task: await publicTask(item) }) : json(res, 404, { error: '采集任务不存在' });
    }
    const actionMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/(run|pause|login|open|archive|confirm-verification)$/);
    if (req.method === 'POST' && actionMatch) {
      const [, id, action] = actionMatch;
      const task = taskById(tasks, id);
      if (!task) return json(res, 404, { error: '任务不存在' });
      if(action==='confirm-verification') {
        const session=await readManualSession(task);
        if(session?.verification_status!=='waiting_human')return json(res,409,{error:'没有正在等待人工验证的当前浏览器会话'});
        await writeJsonAtomic(path.join(task.outputDir,sessionFileName(session.platform)+'.confirm.json'),{task_id:task.id,session_id:session.session_id,confirmed_at:now()});
        return json(res,202,{message:'已提交人工确认；程序将检查当前搜索页，验证通过后继续同一会话'});
      }
      if (action === 'run') {
        if (active.has(id) || startingStages.has(id) || ['running', 'stopping'].includes(task.status)) throw new Error('该任务已有程序正在运行或正在检查启动条件');
        const { stage = 'all', resumeFrom = '' } = await bodyJson(req);
        if (stage === 'all') {
          if (resumeFrom && !['public', 'zhaopin', 'yupao', 'boss', 'finalize', 'workbook'].includes(resumeFrom)) throw new Error('恢复阶段无效');
          if (resumeFrom === 'public' && !task.platforms.some(key=>['shixiseng','iguopin','mohrss','job51','jobonline'].includes(key)) || ['zhaopin','yupao','boss'].includes(resumeFrom) && !task.platforms.includes(resumeFrom)) throw new Error('恢复阶段不属于该任务');
          // Clear the old pause marker before entering the pipeline's cancellation checks.
          await setTask(task.id, { status: 'ready', pipeline: true, message: '准备恢复采集流水线' });
          void runPipeline(task, resumeFrom);
        }
        else {
          if (!['public', 'zhaopin', 'yupao', 'boss', 'finalize', 'workbook'].includes(stage)) throw new Error('不支持的运行阶段');
          if (stage === 'boss' && !task.platforms.includes('boss')) throw new Error('该任务未选择BOSS渠道，请新建包含BOSS的任务');
          void runSingle(task, stage);
        }
        return json(res, 202, { ok: true, message: '已启动' });
      }
      if (action === 'login') {
        const { platform = 'zhaopin' } = await bodyJson(req);
        if (!['zhaopin', 'yupao', 'boss'].includes(platform)) throw new Error('不支持的登录平台');
        startPlatformLogin(platform);
        return json(res,202,{ok:true,message:'将打开或聚焦对应平台的共享浏览器，请人工登录/验证，无需关闭窗口'});
      }
      if (action === 'pause') {
        const running = active.get(id);
        if (!running) return json(res, 409, { error: '任务当前未运行' });
        await setTask(id, { status: 'stopping', message: '正在安全停止当前进程' });
        if (process.platform === 'win32') {
          const killer = spawn('taskkill', ['/PID', String(running.child.pid), '/T', '/F'], { windowsHide: true });
          killer.on('error', () => running.child.kill('SIGTERM'));
        } else running.child.kill('SIGTERM');
        return json(res, 202, { ok: true, message: '正在暂停；当前未落盘的小段将在续爬时自动重采并去重' });
      }
      if (action === 'open') {
        spawn('explorer.exe', [task.outputDir], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
        return json(res, 200, { ok: true });
      }
      if (action === 'archive') {
        if (active.has(id)) throw new Error('请先暂停任务');
        task.archived = true;
        await saveTasks(tasks);
        return json(res, 200, { ok: true, message: '任务已从控制台移除，输出文件未删除' });
      }
    }
    const logMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/logs$/);
    if (req.method === 'GET' && logMatch) {
      const filePath = path.join(logDir, `${logMatch[1]}.log`);
      let content = '';
      try {
        const stat = await fs.stat(filePath);
        const start = Math.max(0, stat.size - 180_000);
        const handle = await fs.open(filePath, 'r');
        const buffer = Buffer.alloc(stat.size - start);
        await handle.read(buffer, 0, buffer.length, start);
        await handle.close();
        content = buffer.toString('utf8');
      } catch {}
      return json(res, 200, { content });
    }
    if (pathname.startsWith('/api/')) return json(res, 404, { error: '接口不存在' });
    if (req.method === 'GET' && /^\/(?:tasks|labels)(?:\/[^/]+)?\/?$|^\/(?:platforms|insights)\/?$/.test(pathname)) return await serveStatic(req, res, '/');
    return await serveStatic(req, res, pathname);
  } catch (error) {
    console.error(error);
    return json(res, 400, { error: error.message || String(error) });
  }
});

server.listen(port, host, () => {
  console.log(`岗位采集控制台已启动：${consoleUrl()}`);
  console.log(`任务数据：${dataDir}`);
  if (process.env.JOB_UI_OPEN_BROWSER === '1') openBrowser();
});

server.on('error', async (error) => {
  if (error.code === 'EADDRINUSE' && await existingConsoleIsReady()) {
    console.log(`岗位采集控制台已在运行：${consoleUrl()}`);
    if (process.env.JOB_UI_OPEN_BROWSER === '1') openBrowser();
    process.exit(0);
  }
  if (error.code === 'EADDRINUSE') {
    console.error(`端口 ${port} 已被其他程序占用，无法启动岗位采集控制台。`);
  } else {
    console.error('岗位采集控制台启动失败：', error);
  }
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const { child } of active.values()) child.kill('SIGTERM');
    for (const { child } of activeLabels.values()) child.kill('SIGTERM');
    for (const child of activeLogins.values()) child.kill('SIGTERM');
    if (activeInsight?.child) activeInsight.child.kill('SIGTERM');
    server.close(() => process.exit(0));
  });
}
