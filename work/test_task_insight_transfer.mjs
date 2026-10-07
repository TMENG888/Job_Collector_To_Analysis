import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { taskInsightSource } from './task-insight-source.mjs';
import { selectLegacyTaskDataset, finalDatasetCatalog } from '../job_collector_ui/public/insight-transfer.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'job-transfer-test-'));
const directory = path.join(testDir, 'datasets');
const history = path.join(directory, '历史数据集');
await fs.mkdir(history, { recursive: true });
const input = path.join(directory, 'ai漫剧师岗位_4条_标准化数据.csv');
const wrong = path.join(history, '大数据开发工程师岗位_5000条.xlsx');
await fs.writeFile(wrong, 'Unrelated historical file, must never be selected');
await fs.writeFile(input, '岗位ID,岗位名称,岗位描述,查询关键词,薪资,工作城市,用工类型,公司名称\na,AI漫剧师,根据剧本制作分镜与剧情画面 ComfyUI,ai漫剧师,10-20K,北京,全职,A公司\nb,AI漫剧实习生,根据剧本完成视频剪辑后期制作,ai漫剧师,150-200元/天,北京,实习,B公司\nc,AI应用工程师,LLM RAG开发,ai漫剧师,20-30K,北京,全职,C公司\nd,AI短剧编导,公司介绍：AI短剧创作工具。岗位职责：开发服务接口。,ai短剧,15-25K,上海,全职,D公司');
const task = { id: 'ai-task', label: 'ai漫剧师', outputDir: directory, status: 'partial', platforms: [], cities: [], targetRows: 5000 };
await fs.writeFile(path.join(testDir, 'tasks.json'), JSON.stringify([task]));
const manifestFile = path.join(directory, '最终交付清单.json');
const manifest = { label: task.label, rows: 4, named_dataset: path.basename(input) };
await fs.writeFile(manifestFile, JSON.stringify(manifest));
assert.equal((await taskInsightSource(task)).dataset.path, input);
await fs.writeFile(manifestFile, JSON.stringify({ ...manifest, label: '其他任务' }));
await assert.rejects(taskInsightSource(task), /岗位与当前任务不一致/);
await fs.writeFile(manifestFile, JSON.stringify({ ...manifest, named_dataset: '历史数据集/大数据开发工程师岗位_5000条.xlsx' }));
await assert.rejects(taskInsightSource(task), /不属于任务目录/);
await fs.writeFile(manifestFile, JSON.stringify(manifest));
const poisoned = [{ path: wrong, format: 'xlsx', taskId: task.id }, { path: input, format: 'csv', taskId: task.id }];
const redundant = [...poisoned, { path: path.join(directory, 'ai漫剧师岗位_4条.xlsx'), format: 'xlsx' }, { path: path.join(directory, 'zhaopin_标准化数据.csv'), format: 'csv' }, { path: path.join(directory, '最终合并数据.csv'), format: 'csv' }];
assert.deepEqual(finalDatasetCatalog(redundant, [task]).map((item) => item.path), [input]);
assert.equal(finalDatasetCatalog(redundant, [{ ...task, archived: true }]).length, 0);
assert.equal(finalDatasetCatalog([...redundant, { path: path.join(directory, 'ai漫剧师岗位_2条_标准化数据.csv') }], [task])[0].path, path.join(directory, '最终合并数据.csv'));
assert.equal(finalDatasetCatalog([{ path: path.join(directory, '最终合并数据.csv') }], [task, { ...task, id: 'other', label: '其他岗位' }]).length, 0, 'Generic merged files cannot be assigned across shared task directories');
assert.equal(selectLegacyTaskDataset(task, poisoned).path, input);
assert.throws(() => selectLegacyTaskDataset(task, [poisoned[0]]), /不会选择历史岗位文件/);

const port = 8773, origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [path.join(root, 'job_collector_ui/server.mjs'), String(port)], { cwd: root, env: { ...process.env, JOB_UI_DATA_DIR: testDir, JOB_UI_PORT: String(port), JOB_UI_OPEN_BROWSER: '0' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; server.stdout.on('data', (chunk) => log += chunk); server.stderr.on('data', (chunk) => log += chunk);
let browser;
try {
  let ready = false;
  for (let index = 0; index < 60; index++) {
    try { if ((await fetch(origin + '/api/state')).ok) { ready = true; break; } } catch {}
    if (server.exitCode != null) throw new Error(log);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, log);
  const source = await (await fetch(origin + `/api/tasks/${task.id}/insight-source`)).json();
  assert.equal(source.dataset.path, input); assert.equal(source.dataset.expectedRows, 4);
  const tampered = await fetch(origin + '/api/insights/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inputFile: wrong, role: task.label, sourceTaskId: task.id }) });
  assert.ok(!tampered.ok); assert.match((await tampered.json()).error, /不是该任务的当前交付文件/);
  browser = await chromium.launch({ headless: true, executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
  const page = await browser.newPage(); const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin + `/tasks/${task.id}`);
  await page.locator('[data-action="insights"]').click();
  await page.waitForFunction((expected) => document.querySelector('#insightForm input[name="inputFile"]').value === expected, input);
  assert.equal(await page.locator('#insightForm input[name="role"]').inputValue(), task.label);
  assert.equal(await page.locator('#insightAnalysisMode').inputValue(), 'full');
  assert.ok(await page.locator('#insightSampleSize').isDisabled());
  assert.match(await page.locator('#insightTransferSource').textContent(), /交付 4 条.*按任务交付清单验证/);
  await page.locator('#runInsight').click();
  await page.waitForFunction(() => document.querySelector('#insightStatus').textContent.includes('分析完成：2/4'));
  const result = await (await fetch(origin + '/api/insights')).json();
  assert.equal(result.report.total_rows, 4); assert.equal(result.report.sample_rows, 2);
  assert.equal(result.report.input_file, input); assert.equal(result.report.transfer_provenance.task_id, task.id);
  assert.equal(result.report.transfer_provenance.expected_rows, 4);
  assert.equal(result.report.profiles.role_segments.reduce((sum, item) => sum + item.count, 0), 2);
  assert.equal(result.report.input_role_segments.reduce((sum, item) => sum + item.count, 0), 4);
  assert.match(await page.locator('#insightFilterAudit').textContent(), /读入 4 条.*全量扫描 4 条.*岗位匹配 2 条/);

  const legacy = await browser.newPage(); legacy.on('pageerror', (error) => errors.push(error.message));
  await legacy.route('**/api/tasks/*/insight-source', (route) => route.fulfill({ status: 404, json: { error: 'legacy server' } }));
  await legacy.route('**/api/insights/datasets', (route) => route.fulfill({ json: { datasets: poisoned.map((item) => ({ ...item, name: 'ai漫剧师 · 历史文件', size: 500 })) } }));
  await legacy.goto(origin + `/tasks/${task.id}`);
  await legacy.locator('[data-action="insights"]').click();
  await legacy.waitForFunction((expected) => document.querySelector('#insightForm input[name="inputFile"]').value === expected && document.querySelector('#insightTransferSource').textContent.includes('旧服务'), input);
  assert.match(await legacy.locator('#insightTransferSource').textContent(), /旧服务/);
  const oldName = await legacy.locator('#insightDataset option').evaluateAll((items) => items.find((item) => item.value.includes('大数据开发'))?.textContent);
  assert.ok(!oldName, 'Unrelated history is excluded from final catalog');
  await legacy.goto(origin + `/tasks/${task.id}`);
  await legacy.locator('[data-action="labels"]').click();
  await legacy.waitForFunction((expected) => document.querySelector('#labelForm input[name="inputFile"]').value === expected && document.querySelector('#labelDialog').open, input);
  assert.equal(await legacy.locator('#labelForm input[name="inputFile"]').inputValue(), input);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, testDir, checks: ['manifest source', 'manifest role mismatch rejected', 'cross-directory path rejected', 'server rejects tampered transfer', 'task button to actual full analysis', 'input and matched counts separated', 'legacy poisoned dataset list handled', 'label transfer source'], readRows: 4, matchedRows: 2, browserErrors: errors.length }));
} finally {
  await browser?.close();
  const done = new Promise((resolve) => server.once('exit', resolve));
  if (server.exitCode == null) { server.kill(); await done; }
}
