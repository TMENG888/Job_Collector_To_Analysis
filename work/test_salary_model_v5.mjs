import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const agent = JSON.parse(await fs.readFile(new URL('salary_model_eval_v5.json', import.meta.url), 'utf8'));
const crawler = JSON.parse(await fs.readFile(new URL('salary_model_crawler_eval_v5.json', import.meta.url), 'utf8'));
const backend = JSON.parse(await fs.readFile(new URL('salary_model_backend_eval_v5.json', import.meta.url), 'utf8'));
for (const report of [agent, crawler, backend]) {
  const model = report.salary_model;
  assert.equal(model.version, 'conditional-salary-selected-v5');
  assert.equal(model.selection.candidate_metrics.length, 8);
  const baseline = model.selection.candidate_metrics.find((item) => item.id === 'profile');
  const winner = model.selection.candidate_metrics.find((item) => item.id === model.selection.selected);
  if (model.selection.skill_model_selected) assert.ok(baseline.mae_k_precise - winner.mae_k_precise >= model.selection.minimum_skill_gain_k - 0.01);
  else assert.equal(model.selection.selected, 'profile');
}
assert.equal(agent.salary_model.selection.selected, 'profile');
assert.equal(agent.salary_model.skill_effects.every((item) => item.adjusted_delta_k == null), true);

const browser = await chromium.launch({ headless: true, executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
const page = await browser.newPage({ locale: 'zh-CN' });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.route(/\/api\/insights$/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'completed', message: '测试报告', report: agent }) }));
await page.goto('http://127.0.0.1:8765/', { waitUntil: 'networkidle' });
await page.locator('[data-view="insights"]').click();
await page.locator('#salaryEstimator').waitFor();
assert.ok((await page.locator('.insight-label-provenance').innerText()).includes('规则抽取'));
assert.ok((await page.locator('.salary-skill-head').innerText()).includes('暂不对技能组合报价'));
const baselineValue = await page.locator('#salaryEstimateValue').innerText();
assert.ok(/K\/月$/.test(baselineValue));
await page.locator('[data-salary-skill][value="LLM"]').locator('..').click();
assert.equal(await page.locator('#salaryEstimateValue').innerText(), '样本不足');
assert.ok((await page.locator('#salaryEstimateReliability').innerText()).includes('技能模型未明显优于条件基线'));
assert.deepEqual(errors, []);
console.log(JSON.stringify({ agent: agent.salary_model.selection, crawler: crawler.salary_model.selection.selected, backend: backend.salary_model.selection.selected, browser: 'passed' }, null, 2));
await browser.close();
