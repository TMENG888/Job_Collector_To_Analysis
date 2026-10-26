import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const origin = process.env.JOB_INSIGHT_TEST_URL || 'http://127.0.0.1:8766';
const insight = await (await fetch(`${origin}/api/insights`)).json();
assert.equal(insight.status, 'completed');
const report = insight.report;
assert.equal(report.total_rows, 5000);
assert.equal(report.label_provenance.total, 5000);
assert.match(report.label_provenance.mode, /未经人工或 AI 复核/);
assert.ok(report.label_provenance.excluded_by_prelabel > 0);
assert.ok(report.label_provenance.included_by_external_label > 0);
assert.equal(report.salary_model.status, 'ready');
assert.equal(Object.values(report.salary_model.quality.label_source).reduce((a, b) => a + b, 0), report.salary_model.sample_count);
assert.equal(report.salary_model.selection.candidate_metrics.length, 10);

const browser = await chromium.launch({ headless: true, executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
try {
  const page = await browser.newPage({ locale: 'zh-CN' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.locator('[data-view="insights"]').click();
  await page.locator('#salaryEstimator').waitFor();
  assert.match(await page.locator('#insightStatus').innerText(), /分析完成：342\/5,000 条/);
  const provenance = await page.locator('.insight-label-provenance').innerText();
  assert.match(provenance, /已预标注 5,000 条/);
  assert.match(provenance, /未经人工或 AI 复核/);
  assert.match(provenance, /从关键词匹配样本排除/);
  assert.match(provenance, /标签补充纳入/);
  const qualityDetails = page.locator('.salary-model-comparison').filter({ hasText: '数据质量与时间验证' });
  await qualityDetails.locator('summary').click();
  assert.match(await qualityDetails.innerText(), /本地规则预标注 \d+ 条/);
  const initial = await page.locator('#salaryEstimateValue').innerText();
  assert.match(initial, /K\/月$/);
  const supportedProfiles = new Map();
  for (const item of report.salary_model.observed_samples || []) {
    const profile = Object.fromEntries(['city', 'experience', 'education', 'company_size', 'employment_type'].map((field) => [field, item[field]]));
    const key = JSON.stringify(profile);
    supportedProfiles.set(key, { profile, count: (supportedProfiles.get(key)?.count || 0) + 1 });
  }
  let changed = false;
  for (const { profile, count } of [...supportedProfiles.values()].filter((item) => item.count >= 5)) {
    for (const [field, value] of Object.entries(profile)) await page.locator(`[data-salary-profile="${field}"]`).selectOption(value);
    const current = await page.locator('#salaryEstimateValue').innerText();
    if (/K\/月$/.test(current) && current !== initial) { changed = true; break; }
  }
  assert.ok(changed, '切换到另一个有真实样本支撑的完整画像应重新计算条件薪资');
  const comparison = page.locator('.salary-model-comparison').filter({ hasText: '候选算法' });
  await comparison.locator('summary').click();
  assert.equal(await comparison.locator('tbody tr').count(), 10);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ total: report.total_rows, prelabels: report.label_provenance.total, focused: report.sample_rows, training: report.salary_model.sample_count, selected: report.salary_model.selection.selected, city_recalculated: changed }));
} finally {
  await browser.close();
}
