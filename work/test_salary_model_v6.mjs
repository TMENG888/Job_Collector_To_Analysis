import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const reports = await Promise.all(['salary_empirical_candidate.json', 'salary_model_crawler_eval_v6.json', 'salary_model_backend_eval_v6.json'].map(async (name) => JSON.parse(await fs.readFile(new URL(name, import.meta.url), 'utf8'))));
for (const report of reports) {
  const model = report.salary_model;
  assert.equal(model.version, 'conditional-salary-selected-v6');
  assert.equal(model.selection.candidate_metrics.length, 10);
  assert.equal(model.quality.training_rows, model.sample_count);
  assert.equal(model.quality.label_source['人工复核标注'] + model.quality.label_source['规则抽取'], model.sample_count);
  const baseline = model.selection.candidate_metrics.find((item) => item.id === model.selection.baseline);
  const chosen = model.selection.candidate_metrics.find((item) => item.id === model.selection.selected);
  assert.ok(baseline && chosen);
  if (model.selection.skill_model_selected) {
    assert.ok(baseline.mae_k_precise - chosen.mae_k_precise >= model.selection.minimum_skill_gain_k - 0.01);
    if (model.quality.time_holdout.status === 'evaluated') assert.ok(model.quality.time_holdout[model.selection.selected].mae_k_precise <= model.quality.time_holdout[model.selection.baseline].mae_k_precise);
  }
}

const browser = await chromium.launch({ headless: true, executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
const page = await browser.newPage({ locale: 'zh-CN' });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.route(/\/api\/insights$/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'completed', message: '测试报告', report: reports[0] }) }));
await page.goto('http://127.0.0.1:8765/', { waitUntil: 'networkidle' });
await page.locator('[data-view="insights"]').click();
await page.locator('#salaryEstimator').waitFor();
const first = await page.locator('#salaryEstimateValue').innerText();
assert.match(first, /K\/月$/);
const city = page.locator('[data-salary-profile="city"]');
const options = await city.locator('option').allTextContents();
let changed = false;
for (const option of options.slice(1)) {
  await city.selectOption({ label: option });
  if (await page.locator('#salaryEstimateValue').innerText() !== first) { changed = true; break; }
}
assert.ok(changed, '改变城市应改变条件基线');
await page.locator('[data-salary-profile="employment_type"]').selectOption('兼职/临时');
assert.equal(await page.locator('#salaryEstimateValue').innerText(), '暂无可靠估价');
assert.match(await page.locator('#salaryEstimateSupport').innerText(), /^\d+ 条$/);
assert.match(await page.locator('#salaryEstimateReliability').innerText(), /精确匹配|未使用其他用工类型/);
await page.locator('[data-salary-profile="employment_type"]').selectOption('全职');
await city.selectOption(reports[0].salary_model.defaults.city);
const conditionBaseline = await page.locator('#salaryEstimateValue').innerText();
assert.match(conditionBaseline, /K\/月$/);
await page.locator('[data-salary-skill][value="LLM"]').locator('..').click();
assert.notEqual(await page.locator('#salaryEstimateValue').innerText(), conditionBaseline);
assert.match(await page.locator('#salaryEstimateBasis').innerText(), /实际岗位薪资中点中位数/);
assert.match(await page.locator('#salaryEstimateReliability').innerText(), /基线/);
const boosted = await page.evaluate(() => {
  const model = {
    status: 'ready', feature_names: ['intercept', 'city:上海', 'skill:Java'],
    feature_spec: { pairs: [], triples: [] }, interval_log_half_width: 0.2,
    selection: { skill_model_selected: true },
    baseline_predictor: { kind: 'boosted_trees', base: Math.log(10), learning_rate: 1, trees: [] },
    predictor: { kind: 'boosted_trees', base: Math.log(10), learning_rate: 1, trees: [
      { feature: 1, left: { value: 0.2 }, right: { value: -0.2 } },
      { feature: 2, left: { value: 0.1 }, right: { value: 0 } },
    ] },
  };
  return [salaryModelPrediction(model, { city: '上海' }, ['Java']).estimate, salaryModelPrediction(model, { city: '上海' }, []).estimate];
});
assert.ok(Math.abs(boosted[0] - 10 * Math.exp(0.3)) < 1e-7);
assert.ok(Math.abs(boosted[1] - 10) < 1e-7);
const crawlerPage = await browser.newPage({ locale: 'zh-CN' });
crawlerPage.on('pageerror', (error) => errors.push(error.message));
await crawlerPage.route(/\/api\/insights$/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'completed', message: '测试报告', report: reports[1] }) }));
await crawlerPage.goto('http://127.0.0.1:8765/', { waitUntil: 'networkidle' });
await crawlerPage.locator('[data-view="insights"]').click();
await crawlerPage.locator('[data-salary-profile="city"]').selectOption('杭州');
await crawlerPage.locator('[data-salary-profile="experience"]').selectOption('1-3年');
await crawlerPage.locator('[data-salary-profile="education"]').selectOption('本科');
await crawlerPage.locator('[data-salary-profile="company_size"]').selectOption('10000人以上');
await crawlerPage.locator('[data-salary-profile="employment_type"]').selectOption('全职');
const crawlerBaseline = await crawlerPage.locator('#salaryEstimateValue').innerText();
assert.match(crawlerBaseline, /K\/月$/);
await crawlerPage.locator('[data-salary-skill][value="Python"]').locator('..').click();
const crawlerSkill = await crawlerPage.locator('#salaryEstimateValue').innerText();
assert.match(crawlerSkill, /K\/月$/);
assert.notEqual(crawlerSkill, crawlerBaseline, '足够样本的技能选择应更新薪资');
const livePage = await browser.newPage({ locale: 'zh-CN' });
livePage.on('pageerror', (error) => errors.push(error.message));
await livePage.goto('http://127.0.0.1:8765/', { waitUntil: 'networkidle' });
await livePage.locator('[data-view="insights"]').click();
await livePage.locator('#salaryEstimator').waitFor();
const liveBaseline = await livePage.locator('#salaryEstimateValue').innerText();
assert.match(liveBaseline, /K\/月$/);
await livePage.locator('[data-salary-skill][value="LLM"]').locator('..').click();
assert.notEqual(await livePage.locator('#salaryEstimateValue').innerText(), liveBaseline);
assert.match(await livePage.locator('#salaryEstimateBasis').innerText(), /实际岗位薪资中点中位数/);
await livePage.locator('[data-salary-skill][value="LLM"]').locator('..').click();
const liveSkills = livePage.locator('[data-salary-skill]');
for (let index = 0; index < await liveSkills.count(); index += 1) {
  const input = liveSkills.nth(index);
  await input.locator('..').click();
  assert.match(await livePage.locator('#salaryEstimateValue').innerText(), /K\/月$|暂无可靠估价/);
  await input.locator('..').click();
}
assert.deepEqual(errors, []);
await browser.close();
console.log(JSON.stringify({ models: reports.map((report) => ({ role: report.role, selected: report.salary_model.selection.selected, cv_mae_k: report.salary_model.metrics.mae_k, time_holdout: report.salary_model.quality.time_holdout.status })), browser: 'passed' }));
