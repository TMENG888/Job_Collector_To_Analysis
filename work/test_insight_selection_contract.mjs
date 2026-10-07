import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { datasetOwner } from './insight-dataset-owner.mjs';
import { literalRoleFamily, selectManualRole } from './insight-role-selection.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'job-insight-selection-'));
const parent = path.join(testDir, 'datasets');
const childDir = path.join(parent, '爬虫工程师');
const unowned = path.join(parent, '未登记数据');
for (const directory of [parent, childDir, unowned]) await fs.mkdir(directory, { recursive: true });
const inputA = path.join(parent, '多平台岗位标准化汇总.csv');
const inputB = path.join(childDir, '多平台岗位标准化汇总.csv');
const inputC = path.join(unowned, '岗位数据.csv');
const headers = '岗位ID,岗位名称,岗位描述,查询关键词,薪资,工作城市,经验要求,学历要求,用工类型,公司名称,公司规模,技能';
await fs.writeFile(inputA, headers + '\n' + [
  'a,沉浸叙事设计师,负责叙事创作,沉浸叙事设计师,12-18K,北京,1-3年,本科,全职,A公司,20-99人,Python',
  'b,沉浸 叙事设计师,从事内容创作,沉浸叙事设计师,16-20K,北京,1-3年,本科,全职,B公司,20-99人,Python',
  'c,智能体开发工程师,开发大模型LLM RAG应用,沉浸叙事设计师,20-30K,北京,1-3年,本科,全职,C公司,20-99人,LLM',
  'd,软件开发工程师,Java Spring Boot接口开发,沉浸叙事设计师,25-35K,北京,1-3年,本科,全职,D公司,20-99人,Java',
].join('\n'), 'utf8');
await fs.writeFile(inputB, headers + '\nx,爬虫工程师,Scrapy网页采集,爬虫工程师,10-20K,北京,1-3年,本科,全职,X公司,20-99人,Scrapy', 'utf8');
// Positive fixture supplies actual production duties and independent keywords;
// a target title alone is no longer sufficient under validated keyword selection.
await fs.writeFile(inputC, headers + '\ny,AI漫剧制作师,负责按剧本制作分镜并完成后期剪辑 ComfyUI,ai漫剧师,10-15K,上海,1-3年,本科,全职,Y公司,20-99人,ComfyUI\nz,智能体开发工程师,大模型LLM RAG,ai漫剧师,30-40K,上海,1-3年,本科,全职,Z公司,20-99人,LLM', 'utf8');
const tasks = [
  { id: 'parent', label: 'ai漫剧师', outputDir: parent, status: 'completed', createdAt: '2026-10-05', platforms: [], cities: [] },
  { id: 'child', label: '爬虫工程师', outputDir: childDir, status: 'completed', createdAt: '2026-10-04', platforms: [], cities: [] },
];
await fs.writeFile(path.join(testDir, 'tasks.json'), JSON.stringify(tasks));
await fs.writeFile(path.join(parent, '最终交付清单.json'), JSON.stringify({ label: 'ai漫剧师', rows: 4, named_dataset: path.basename(inputA) }));
await fs.writeFile(path.join(childDir, '最终交付清单.json'), JSON.stringify({ label: '爬虫工程师', rows: 1, named_dataset: path.basename(inputB) }));
assert.equal(datasetOwner(tasks, inputB)?.id, 'child');
assert.equal(datasetOwner(tasks, inputC), null);
assert.equal(datasetOwner(tasks, inputA)?.id, 'parent');
assert.ok(literalRoleFamily('C++专家').title.test('高级C++专家'));
assert.ok(!literalRoleFamily('C++专家').title.test('CCCC专家'));
assert.ok(literalRoleFamily('ai漫剧师').title.test('AI 漫剧师'));
assert.equal(selectManualRole([], '自动识别'), null);
assert.equal(selectManualRole([], 'ai漫剧师').name, 'ai漫剧师');

const port = 8772;
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [path.join(root, 'job_collector_ui/server.mjs'), String(port)], { cwd: root, env: { ...process.env, JOB_UI_DATA_DIR: testDir, JOB_UI_OPEN_BROWSER: '0', JOB_UI_PORT: String(port) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (chunk) => serverLog += chunk);
server.stderr.on('data', (chunk) => serverLog += chunk);
const request = async (route, body) => {
  const response = await fetch(origin + route, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await response.json(); assert.ok(response.ok, JSON.stringify(data)); return data;
};
async function analyze(inputFile, role) {
  await request('/api/insights/run', { inputFile, role, analysisMode: 'full', labelJobId: '' });
  for (let index = 0; index < 100; index++) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    const result = await request('/api/insights');
    if (result.status !== 'running') return result;
  }
  throw new Error('Analysis timeout');
}
let browser;
try {
  let ready = false;
  for (let index = 0; index < 60; index++) {
    if (server.exitCode != null) throw new Error(serverLog);
    try { await request('/api/state'); ready = true; break; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  assert.ok(ready, serverLog);
  const datasets = (await request('/api/insights/datasets')).datasets;
  assert.equal(datasets.find((item) => item.path === inputB).taskId, 'child');
  assert.ok(!datasets.some((item) => item.path === inputC), 'Unregistered files must not be listed as final datasets');
  assert.equal(datasets.length, 2);
  const custom = await analyze(inputA, '沉浸叙事设计师');
  assert.equal(custom.status, 'completed', custom.error);
  assert.equal(custom.report.role, '沉浸叙事设计师');
  assert.equal(custom.report.detected_role.mode, 'manual_keyword');
  assert.equal(custom.report.sample_rows, 2);
  assert.equal(custom.report.total_rows, 4);
  assert.equal(custom.report.topic_model.discovered_terms.length, 0);
  assert.deepEqual(custom.report.cohort_observations.map((item) => item.salary_midpoint_k).sort((a, b) => a - b), [15, 18]);
  assert.equal(custom.report.salary.median, 16.5);
  const creative = await analyze(inputC, 'ai漫剧师');
  assert.equal(creative.status, 'completed', creative.error);
  assert.equal(creative.report.role, 'AI漫剧创作');
  assert.equal(creative.report.detected_role.manual_label, 'ai漫剧师');
  assert.equal(creative.report.sample_rows, 1);
  assert.ok(creative.report.skills.some((skill) => skill.name === 'ComfyUI'));
  const known = await analyze(inputB, '爬虫工程师');
  assert.equal(known.status, 'completed', known.error);
  assert.equal(known.report.role, '爬虫/数据采集');
  assert.equal(known.report.detected_role.manual_label, '爬虫工程师');
  const failure = await analyze(inputA, '量子漫剧设计师');
  assert.equal(failure.status, 'failed');
  assert.match(failure.message, /未找到.*量子漫剧设计师.*不会自动改为其他岗位族/);
  assert.equal(failure.report.generated_at, known.report.generated_at, 'Failure must preserve previous report');
  assert.equal((await analyze(inputB, '爬虫工程师')).status, 'completed');

  browser = await chromium.launch({ headless: true, executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  let releaseInitial; const initialGate = new Promise((resolve) => releaseInitial = resolve);
  let held = false, posted;
  await page.route('**/api/**', async (route) => {
    const req = route.request(), url = new URL(req.url());
    if (req.method() !== 'GET') {
      if (url.pathname === '/api/insights/run') posted = req.postDataJSON();
      return route.fulfill({ status: 409, json: { error: '诊断提交已拦截' } });
    }
    if (url.pathname === '/api/insights' && !held) {
      held = true; const response = await route.fetch(); await initialGate; return route.fulfill({ response });
    }
    if (url.pathname === '/api/labels') return route.fulfill({ json: { jobs: [
      { id: 'label-a', name: 'A标签', inputFile: inputA, platform: 'deepseek', metrics: { completed: 2 } },
      { id: 'label-b', name: 'B标签', inputFile: inputB, platform: 'kimi', metrics: { completed: 1 } },
    ] } });
    return route.continue();
  });
  await page.goto(origin + '/insights', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction((value) => [...document.querySelector('#insightDataset').options].some((option) => option.value === value), inputA);
  await page.selectOption('#insightDataset', inputA);
  await page.locator('#insightForm input[name="role"]').fill('ai漫剧师');
  await page.selectOption('#insightAnalysisMode', 'full');
  await page.selectOption('#insightLabelJob', '');
  releaseInitial();
  await page.waitForFunction(() => document.querySelector('#insightStatus').textContent.includes('选择已更改'));
  assert.equal(await page.locator('#insightForm input[name="inputFile"]').inputValue(), inputA);
  assert.equal(await page.locator('#insightForm input[name="role"]').inputValue(), 'ai漫剧师');
  assert.equal(await page.locator('#insightLabelJob').inputValue(), '');
  await page.waitForFunction(() => [...document.querySelector('#insightLabelJob').options].some((option) => option.value === 'label-a'));
  await page.selectOption('#insightLabelJob', 'label-a');
  await page.selectOption('#insightDataset', inputB);
  assert.equal(await page.locator('#insightLabelJob').inputValue(), 'auto', 'Incompatible label choice must be cleared immediately');
  await page.waitForFunction(() => [...document.querySelector('#insightLabelJob').options].some((option) => option.value === 'label-b'));
  assert.ok(!await page.locator('#insightLabelJob option[value="label-a"]').count());
  await page.selectOption('#insightLabelJob', '');
  await page.selectOption('#insightDataset', inputA);
  await page.locator('#runInsight').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('诊断提交已拦截'));
  assert.equal(posted.inputFile, inputA);
  assert.equal(posted.role, 'ai漫剧师');
  assert.equal(posted.labelJobId, '');
  assert.equal(posted.analysisMode, 'full');
  await page.locator('#insightForm input[name="inputFile"]').fill(inputC);
  await page.locator('#insightForm input[name="inputFile"]').dispatchEvent('change');
  assert.equal(await page.locator('#insightDataset').inputValue(), '', 'Manual paths remain supported without polluting the final catalog');
  await page.waitForTimeout(3200); // Exercise periodic report poll, not only initial loading.
  assert.equal(await page.locator('#insightForm input[name="inputFile"]').inputValue(), inputC);
  assert.equal(await page.locator('#insightLabelJob').inputValue(), '');
  assert.deepEqual(errors, []);
  const restored = await browser.newPage();
  await restored.goto(origin + '/insights');
  await restored.waitForFunction(() => document.querySelector('#insightForm input[name="role"]').value === '爬虫工程师');
  assert.equal(await restored.locator('#insightForm input[name="inputFile"]').inputValue(), inputB);
  console.log(JSON.stringify({ ok: true, testDir, checks: ['directory ownership', 'custom keyword role and noise exclusion', 'known role alias', 'no match and previous report preservation', 'delayed initial load', 'periodic poll preserves selection', 'no-label selection', 'manual path sync', 'submitted parameters', 'restored manual role'], browserErrors: errors.length, customRows: custom.report.sample_rows }));
} finally {
  await browser?.close();
  const exit = new Promise((resolve) => server.once('exit', resolve));
  if (server.exitCode == null) { server.kill(); await exit; }
}
