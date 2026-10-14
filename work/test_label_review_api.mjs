import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'job-label-api-'));
const dataDir = path.join(directory, 'data');
const baseUrl = 'http://127.0.0.1:18766';
const child = spawn(process.execPath, ['job_collector_ui/server.mjs', '18766'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  env: { ...process.env, JOB_UI_DATA_DIR: dataDir, JOB_UI_OPEN_BROWSER: '0' },
  stdio: 'ignore', windowsHide: true,
});
let browser;
try {
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { ready = (await fetch(`${baseUrl}/api/state`)).ok; } catch {}
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, '隔离测试服务未启动');
  const create = await fetch(`${baseUrl}/api/labels`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ inputFile: process.env.JOB_TEST_DATASET || path.resolve('outputs','爬虫工程师岗位_5000条.xlsx'), outputDir: path.join(directory, 'labels'), jobFamily: '爬虫/数据采集', platform: 'rules', sampleSize: 1 }),
  });
  assert.equal(create.status, 201);
  const { job } = await create.json();
  const createdConfig = JSON.parse(await fs.readFile(job.configPath, 'utf8'));
  assert.equal(createdConfig.jobFamily, '爬虫/数据采集');
  const record = { row_no: 2, job_id: 'row-2', job_name: '测试岗位', skills: ['Python'], tasks: [], skills_text: 'Python', job_description: '使用 Python', evidence_json: [{ label_type: 'skill', label: 'Python', quote: 'Python' }] };
  await fs.writeFile(path.join(job.outputDir, '标注结果.jsonl'), `${JSON.stringify(record)}\n`);
  const pending = await (await fetch(`${baseUrl}/api/labels/${job.id}/review`)).json();
  assert.equal(pending.pending, 1);
  browser = await chromium.launch({ headless: true, executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
  const page = await browser.newPage({ locale: 'zh-CN' });
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.locator('[data-view="labels"]').click();
  await page.locator('.label-review-row').waitFor();
  assert.ok((await page.locator('.label-review-row').innerText()).includes('使用 Python'));
  await page.locator('.label-review-row [data-review="approved"]').click();
  await page.getByText('已批准 1').waitFor();
  const reviewed = await (await fetch(`${baseUrl}/api/labels/${job.id}/review`)).json();
  assert.equal(reviewed.approved, 1);
  assert.equal(reviewed.pending, 0);
  console.log('isolated label creation and review API passed');
} finally {
  if (browser) await browser.close();
  child.kill('SIGTERM');
  if (child.exitCode == null) await new Promise((resolve) => child.once('exit', resolve));
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('job-label-api-')) throw new Error('临时测试目录校验失败，未清理');
  await fs.rm(resolved, { recursive: true, force: true });
}
