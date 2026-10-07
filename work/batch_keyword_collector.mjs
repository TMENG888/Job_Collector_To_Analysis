import fs from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const catalogPath = path.resolve(args.find((arg) => !arg.startsWith('--')) || path.join('ui_data', 'keyword_catalog', '岗位检索关键词目录.json'));
const outputRoot = path.resolve(args.filter((arg) => !arg.startsWith('--'))[1] || 'outputs');
const baseUrl = process.env.JOB_COLLECTOR_URL || 'http://127.0.0.1:8765';
const batchRoot = path.join(outputRoot, '批量岗位采集');
const datasetRoot = path.join(outputRoot, '岗位分析数据集', '新采集');
const statePath = path.join(batchRoot, '批量采集计划状态.json');
const logPath = path.join(batchRoot, '批量采集日志.log');
const cities = ['北京', '天津', '上海', '重庆', '南京', '苏州', '杭州', '武汉', '广州', '深圳', '成都', '西安'];
const yupaoCategories = new Set(['销售商务与客户服务', '采购供应链与物流', '制造工程与质量', '建筑地产与工程']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stamp = () => new Date().toISOString();
const safeName = (value) => String(value || '').replace(/[\\/:*?"<>|]/g, '_').trim();

await fs.mkdir(batchRoot, { recursive: true });
await fs.mkdir(datasetRoot, { recursive: true });

async function appendLog(message) {
  const line = `[${stamp()}] ${message}\n`;
  await fs.appendFile(logPath, line, 'utf8');
  console.log(line.trim());
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const text = await response.text();
  let value = {};
  try { value = text ? JSON.parse(text) : {}; } catch { value = { raw: text }; }
  if (!response.ok) throw new Error(`${response.status} ${value.error || value.raw || response.statusText}`);
  return value;
}

async function loadState(catalog) {
  try {
    const previous = JSON.parse(await fs.readFile(statePath, 'utf8'));
    if (Array.isArray(previous.items) && previous.items.length === catalog.keywords.length) return previous;
  } catch {}
  return {
    version: 'job-batch-collector-v1',
    created_at: stamp(),
    updated_at: stamp(),
    status: 'ready',
    target_rows_per_keyword: 10000,
    total_keywords: catalog.keywords.length,
    completed_keywords: 0,
    partial_keywords: 0,
    failed_keywords: 0,
    output_root: outputRoot,
    items: catalog.keywords.map((item) => ({
      id: item.id,
      category: item.category,
      keyword: item.keyword,
      target_rows: 10000,
      status: 'pending',
      task_id: '',
      output_dir: '',
      final_rows: 0,
      message: '',
    })),
  };
}

async function saveState(state) {
  state.updated_at = stamp();
  state.completed_keywords = state.items.filter((item) => item.status === 'completed').length;
  state.partial_keywords = state.items.filter((item) => item.status === 'partial').length;
  state.failed_keywords = state.items.filter((item) => item.status === 'failed').length;
  const temp = `${statePath}.tmp`;
  await fs.writeFile(temp, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(temp, statePath);
}

async function getConsoleState() {
  return requestJson(`${baseUrl}/api/state`);
}

function taskBody(item) {
  const platforms = ['shixiseng', 'iguopin', 'mohrss', 'zhaopin'];
  if (yupaoCategories.has(item.category)) platforms.push('yupao');
  return {
    label: item.keyword,
    primaryKeyword: item.keyword,
    keywords: [item.keyword],
    targetRows: 10000,
    candidateTarget: 15500,
    cities,
    platforms,
    pace: 'safe',
    outputDir: path.join(batchRoot, item.category, `${safeName(item.keyword)}_10000条`),
    titleTerms: [item.keyword],
    directTerms: [item.keyword],
    roleTerms: ['工程师', '开发', '研发', '经理', '专员', '顾问', '分析师', '设计师', '运营', '销售', '教师', '医生', '护士'],
    allowPlatformMatch: false,
  };
}

async function copyFinalWorkbook(item) {
  const files = await fs.readdir(item.output_dir, { withFileTypes: true }).catch(() => []);
  const workbook = files.find((entry) => entry.isFile() && /\.xlsx$/i.test(entry.name));
  if (!workbook) return '';
  const categoryDir = path.join(datasetRoot, item.category);
  await fs.mkdir(categoryDir, { recursive: true });
  const destination = path.join(categoryDir, workbook.name);
  await fs.copyFile(path.join(item.output_dir, workbook.name), destination);
  return destination;
}

async function pruneIntermediates(item) {
  const keep = new Set(['岗位配置.json', '数据质量报告.json', '最终交付清单.json']);
  const entries = await fs.readdir(item.output_dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isFile() && (/\.xlsx$/i.test(entry.name) || keep.has(entry.name))) continue;
    await fs.rm(path.join(item.output_dir, entry.name), { recursive: true, force: true });
  }
}

const catalog = JSON.parse(await fs.readFile(catalogPath, 'utf8'));
if (!Array.isArray(catalog.keywords) || !catalog.keywords.length) throw new Error('岗位关键词目录为空');
const state = await loadState(catalog);

if (dryRun) {
  await saveState(state);
  await appendLog(`预检通过：${state.total_keywords} 个岗位，理论目标 ${state.total_keywords * 10000} 条，未发起外部请求`);
  process.exit(0);
}

await getConsoleState();
state.status = 'running';
await saveState(state);
await appendLog(`批量计划启动：${state.total_keywords} 个岗位，每岗目标 10000 条`);

for (const item of state.items) {
  if (['completed', 'partial'].includes(item.status)) continue;
  try {
    let consoleState = await getConsoleState();
    let task = item.task_id ? consoleState.tasks.find((entry) => entry.id === item.task_id) : null;
    if (!task) {
      const created = await requestJson(`${baseUrl}/api/tasks`, { method: 'POST', body: JSON.stringify(taskBody(item)) });
      task = created.task;
      item.task_id = task.id;
      item.output_dir = task.outputDir;
      item.status = 'ready';
      item.message = '已在采集中心创建任务';
      await saveState(state);
      await appendLog(`已创建 ${item.id}/${state.total_keywords}：${item.keyword}`);
    }

    if (!['running', 'stopping'].includes(task.status)) {
      await requestJson(`${baseUrl}/api/tasks/${encodeURIComponent(task.id)}/run`, { method: 'POST', body: JSON.stringify({ stage: 'all' }) });
      item.status = 'running';
      item.message = '采集流水线运行中';
      await saveState(state);
      await appendLog(`已启动 ${item.keyword}`);
    }

    let consecutiveStateErrors = 0;
    while (true) {
      await sleep(20000);
      try {
        consoleState = await getConsoleState();
        consecutiveStateErrors = 0;
      } catch (error) {
        consecutiveStateErrors += 1;
        await appendLog(`控制台状态读取失败 ${consecutiveStateErrors}/6：${error.message}`);
        if (consecutiveStateErrors >= 6) throw new Error('控制台连续 6 次无响应，批量计划已暂停');
        continue;
      }
      task = consoleState.tasks.find((entry) => entry.id === item.task_id);
      if (!task) throw new Error('采集中心任务丢失');
      item.final_rows = Number(task.metrics?.finalRows || 0);
      item.message = task.message || '';
      if (['completed', 'partial', 'failed', 'paused'].includes(task.status)) break;
      await saveState(state);
    }

    item.final_rows = Number(task.metrics?.finalRows || 0);
    item.status = task.status;
    item.message = task.message || '';
    item.workbook = await copyFinalWorkbook(item);
    if (item.workbook) await pruneIntermediates(item);
    await saveState(state);
    await appendLog(`${item.keyword} 结束：${item.status}，${item.final_rows}/10000 条${item.workbook ? '，Excel 已归档' : ''}`);

    if (['failed', 'paused'].includes(item.status)) {
      state.status = 'paused';
      state.message = `${item.keyword} 出现 ${item.status}：${item.message}`;
      await saveState(state);
      await appendLog(`为保护账号，批量计划已暂停：${state.message}`);
      process.exit(2);
    }

    const cooldownMs = 60000 + Math.floor(Math.random() * 60000);
    await appendLog(`下一任务前冷却 ${Math.ceil(cooldownMs / 1000)} 秒`);
    await sleep(cooldownMs);
  } catch (error) {
    item.status = 'failed';
    item.message = error.message;
    state.status = 'paused';
    state.message = `${item.keyword}：${error.message}`;
    await saveState(state);
    await appendLog(`批量计划暂停：${state.message}`);
    process.exit(2);
  }
}

state.status = 'completed';
state.message = '全部岗位已处理';
await saveState(state);
await appendLog('批量采集计划全部完成');
