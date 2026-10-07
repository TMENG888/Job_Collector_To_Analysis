import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const report = JSON.parse(await fs.readFile(new URL('salary_empirical_candidate.json', import.meta.url), 'utf8'));
const model = report.salary_model;
assert.equal(model.observed_samples.length, model.sample_count);
assert.ok(model.observed_samples.every((item) => Number.isFinite(item.salary_midpoint_k) && item.salary_midpoint_k > 0));

const profile = model.defaults;
const full = model.observed_samples.filter((item) => ['city', 'experience', 'education', 'company_size', 'employment_type'].every((field) => item[field] === profile[field]));
function median(rows) {
  const sorted = rows.map((item) => item.salary_midpoint_k).sort((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
}
assert.ok(full.length >= 20);
const expected = new Map(['LLM', 'Python', 'RAG'].map((skill) => {
  const rows = full.filter((item) => item.skills.includes(skill));
  assert.ok(rows.length >= 20);
  return [skill, { count: rows.length, median: median(rows) }];
}));
assert.ok([...expected.values()].some((value) => Math.abs(value.median - median(full)) >= 0.5));

const browser = await chromium.launch({ headless: true, executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
const page = await browser.newPage({ locale: 'zh-CN' });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.route(/\/api\/insights$/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'completed', report }) }));
await page.goto('http://127.0.0.1:8765/', { waitUntil: 'networkidle' });
await page.locator('[data-view="insights"]').click();
await page.locator('#salaryEstimator').waitFor();
assert.equal(await page.locator('#salaryEstimateValue').innerText(), `${median(full).toFixed(1)}K/月`);
assert.match(await page.locator('#salaryEstimateRangeLabel').innerText(), /P25–P75/);
await page.locator('[data-salary-profile="employment_type"]').selectOption('实习');
assert.equal(await page.locator('#salaryEstimateValue').innerText(), '暂无可靠估价');
assert.equal(await page.locator('#salaryEstimateSupport').innerText(), '0 条');
assert.match(await page.locator('#salaryEstimateBasis').innerText(), /五项条件没有匹配岗位/);
assert.match(await page.locator('#salaryEstimateReliability').innerText(), /未使用其他用工类型或放宽条件的数据/);
await page.locator('[data-salary-profile="employment_type"]').selectOption('全职');
assert.equal(await page.locator('#salaryEstimateValue').innerText(), `${median(full).toFixed(1)}K/月`);
for (const [skill, value] of expected) {
  await page.locator(`[data-salary-skill][value="${skill}"]`).locator('..').click();
  assert.equal(await page.locator('#salaryEstimateValue').innerText(), `${value.median.toFixed(1)}K/月`);
  assert.equal(await page.locator('#salaryEstimateSupport').innerText(), `${value.count} 条`);
  assert.match(await page.locator('#salaryEstimateBasis').innerText(), /实际岗位薪资中点中位数/);
  await page.locator(`[data-salary-skill][value="${skill}"]`).locator('..').click();
}
for (const skill of ['Dify', 'MCP', 'TensorFlow', 'React']) await page.locator(`[data-salary-skill][value="${skill}"]`).locator('..').click();
const fourSkillEstimate = await page.locator('#salaryEstimateValue').innerText();
assert.match(fourSkillEstimate, /K\/月$/);
assert.match(await page.locator('#salaryEstimateBasis').innerText(), /探索性技能模型外推/);
assert.match(await page.locator('#salaryEstimateReliability').innerText(), /未达正式报价门槛/);
await page.locator('[data-salary-skill][value="React"]').locator('..').click();
assert.match(await page.locator('#salaryEstimateBasis').innerText(), /探索性技能模型外推/);
await page.locator('[data-salary-skill][value="React"]').locator('..').click();
for (const skill of ['Dify', 'MCP', 'TensorFlow', 'React']) await page.locator(`[data-salary-skill][value="${skill}"]`).locator('..').click();
await page.locator('[data-salary-skill]').evaluateAll((inputs) => inputs.forEach((input) => { input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true })); }));
assert.equal(await page.locator('#salaryEstimateValue').innerText(), '暂无可靠估价');
assert.match(await page.locator('#salaryEstimateReliability').innerText(), /超过 4 项技能/);
const live = await browser.newPage({ locale: 'zh-CN' });
live.on('pageerror', (error) => errors.push(error.message));
await live.goto('http://127.0.0.1:8765/', { waitUntil: 'networkidle' });
await live.locator('[data-view="insights"]').click();
await live.locator('#salaryEstimator').waitFor();
assert.match(await live.locator('#salaryEstimateValue').innerText(), /K\/月$/);
assert.match(await live.locator('#salaryEstimateSupport').innerText(), /\d+ 条/);
assert.deepEqual(errors, []);
await browser.close();
console.log(JSON.stringify({ browser: 'passed', full_count: full.length, baseline_median_k: median(full), skills: Object.fromEntries(expected) }));
