import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true, executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
try {
  const { report } = await (await fetch('http://127.0.0.1:8788/api/insights')).json();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let submitted;
  await page.route('**/api/**', async route => {
    if (route.request().method() === 'GET') return route.continue();
    if (new URL(route.request().url()).pathname === '/api/insights/run') {
      submitted = route.request().postDataJSON();
      return route.fulfill({ status: 202, json: { message: '测试拦截，未启动分析' } });
    }
    return route.fulfill({ status: 409, json: { error: '测试禁止写操作' } });
  });
  await page.goto('http://127.0.0.1:8788/insights');
  await page.waitForFunction(() => document.querySelector('#insightStatus').textContent.includes('分析完成'));
  const form = page.locator('#insightForm');
  for (const selector of ['#insightAnalysisMode', '#insightSampleSize', '#insightLabelJob', '[name="sheetName"]']) {
    assert.equal(await form.locator(selector).count(), 0, selector);
  }
  assert.equal(await form.locator('[name="role"]').inputValue(), report.detected_role?.manual_label || report.role);
  assert.equal(await page.locator('#runInsight').textContent(), '生成全量分析');
  await page.locator('#runInsight').click();
  await page.waitForTimeout(500);
  assert.ok(submitted);
  assert.equal(submitted.analysisMode, 'full');
  assert.equal(submitted.labelJobId, 'auto');
  assert.equal(submitted.sheetName, '岗位数据');
  assert.equal(submitted.inputFile, report.input_file);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, removedControls: 4, defaults: submitted.analysisMode, externalLabels: submitted.labelJobId, noAnalysisStarted: true }));
} finally {
  await browser.close();
}
