import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { taskInsightSource } from './task-insight-source.mjs';

const origin = 'http://127.0.0.1:8765';
const tasks = JSON.parse(await fs.readFile('ui_data/tasks.json', 'utf8'));
const task = tasks.find((item) => item.id === '1791187833495-ai漫剧师');
assert.ok(task);
const source = await taskInsightSource(task);
const state = await (await fetch(origin + '/api/state')).json();
const labels = await (await fetch(origin + '/api/labels')).json();
const insight = await (await fetch(origin + '/api/insights')).json();
assert.equal(state.activeCount, 0); assert.equal(labels.activeCount, 0); assert.notEqual(insight.status, 'running');
const browser = await chromium.launch({ headless: true, executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
let submitted = null;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') return route.continue();
    if (new URL(request.url()).pathname === '/api/insights/run' && !submitted) {
      const body = request.postDataJSON();
      assert.equal(body.inputFile, source.dataset.path);
      assert.equal(body.role, task.label); assert.equal(body.analysisMode, 'full');
      assert.equal(body.sourceTaskId, task.id);
      submitted = body; return route.continue();
    }
    return route.fulfill({ status: 409, json: { error: 'Live transfer test blocks unrelated mutations' } });
  });
  await page.goto(origin + '/tasks/' + encodeURIComponent(task.id));
  await page.locator('[data-action="insights"]').click();
  await page.waitForFunction((expected) => document.querySelector('#insightForm input[name="inputFile"]').value === expected, source.dataset.path);
  assert.equal(await page.locator('#insightAnalysisMode').inputValue(), 'full');
  assert.match(await page.locator('#insightTransferSource').textContent(), /3,150 条/);
  const badNames = await page.locator('#insightDataset option').evaluateAll((options) => options.filter((option) => option.value.includes('大数据开发工程师岗位_5000条')).map((option) => option.textContent));
  assert.ok(badNames.every((name) => !name.startsWith('ai漫剧师')));
  const started = page.waitForResponse((response) => response.url().endsWith('/api/insights/run') && response.request().method() === 'POST');
  await page.locator('#runInsight').click();
  assert.ok((await started).ok());
  await page.waitForFunction(() => document.querySelector('#insightFilterAudit')?.textContent.includes('读入 3,150 条') && document.querySelector('#insightStatus').textContent.includes('分析完成'), null, { timeout: 90000 });
  const result = await (await fetch(origin + '/api/insights')).json();
  for (let index = 0; index < 60 && (result.status !== 'completed' || result.report?.generated_at === insight.report?.generated_at); index++) {
    await page.waitForTimeout(500);
    Object.assign(result, await (await fetch(origin + '/api/insights')).json());
  }
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.report.input_file, source.dataset.path);
  assert.equal(result.report.total_rows, source.dataset.expectedRows);
  assert.equal(result.report.requested_sample_rows, source.dataset.expectedRows);
  assert.equal(result.report.profiles.role_segments.reduce((sum, item) => sum + item.count, 0), result.report.sample_rows);
  assert.ok(result.report.joint_expansion.merged_into_insights);
  assert.ok(result.report.joint_expansion.included_rows > 0);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: 'ui_data/task-insight-transfer-live-20261006.png' });
  console.log(JSON.stringify({ ok: true, serverVersion: state.version, inputFile: result.report.input_file, totalRows: result.report.total_rows, scannedRows: result.report.requested_sample_rows, matchedRows: result.report.sample_rows, salaryRows: result.report.quality.salary_rows, jointAdded: result.report.joint_expansion.included_rows, role: result.report.role, usedLegacyCompatibility: !state.capabilities?.taskInsightTransfer, unrelatedHistoricalFileRejected: true, browserErrors: errors.length }));
} finally { await browser.close(); }
