import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const reports = await Promise.all(['salary_model_eval.json', 'salary_model_crawler_eval.json', 'salary_model_backend_eval.json'].map(async (name) => JSON.parse(await fs.readFile(new URL(name, import.meta.url), 'utf8'))));
for (const report of reports) {
  const model = report.salary_model;
  assert.equal(model.status, 'ready');
  assert.equal(model.version, 'conditional-salary-selected-v4');
  assert.equal(model.coefficients.length, model.feature_names.length);
  assert.equal(model.baseline_coefficients.length, model.feature_names.length);
  assert.equal(model.selection.candidate_metrics.length, 7);
  assert.equal(model.selection.candidate_metrics.every((item) => item.test_rows === model.sample_count), true);
  assert.equal(model.coefficients.every(Number.isFinite), true);
  const baseline = model.selection.candidate_metrics.find((item) => item.id === 'profile');
  const selected = model.selection.candidate_metrics.find((item) => item.id === model.selection.selected);
  assert.ok(selected.metrics.mae_k <= baseline.metrics.mae_k + 0.11);
}
const agentModel = reports[0].salary_model;
assert.equal(agentModel.selection.selected, 'three_way');
assert.ok(agentModel.feature_names.some((name, index) => name.startsWith('triple:') && Math.abs(agentModel.coefficients[index]) > 0.001));
const predict = (skills) => {
  const selected = new Set(skills);
  const coefficients = skills.length ? agentModel.coefficients : agentModel.baseline_coefficients;
  let logSalary = 0;
  agentModel.feature_names.forEach((name, index) => {
    if (name === 'intercept') logSalary += coefficients[index];
    else {
      const colon = name.indexOf(':');
      const type = name.slice(0, colon);
      const value = name.slice(colon + 1);
      const active = type === 'skill' ? selected.has(value) : type === 'pair' || type === 'triple' ? value.split(' + ').every((skill) => selected.has(skill)) : agentModel.defaults[type] === value;
      if (active) logSalary += coefficients[index];
    }
  });
  return `${Math.exp(logSalary).toFixed(1)}K/月`;
};

const browser = await chromium.launch({ headless: true, executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1440, height: 950 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.route(/\/api\/insights$/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'completed', message: '历史模型兼容测试', report: reports[0] }) }));
await page.goto('http://127.0.0.1:8765/', { waitUntil: 'networkidle' });
await page.locator('[data-view="insights"]').click();
await page.locator('#salaryEstimator').waitFor();
const read = async () => ({ value: await page.locator('#salaryEstimateValue').innerText(), delta: await page.locator('#salaryEstimateDelta').innerText(), support: await page.locator('#salaryEstimateSupport').innerText(), reliability: await page.locator('#salaryEstimateReliability').innerText() });
const baseline = await read();
await page.locator('[data-salary-skill][value="LLM"]').locator('..').click();
const llm = await read();
await page.locator('[data-salary-skill][value="Python"]').locator('..').click();
await page.locator('[data-salary-skill][value="RAG"]').locator('..').click();
const triple = await read();
await page.locator('[data-salary-skill][value="MCP"]').locator('..').click();
const quadruple = await read();
await page.locator('#salaryEstimator').screenshot({ path: fileURLToPath(new URL('salary-model-selection-ui.png', import.meta.url)) });
await page.locator('#clearSalarySkills').click();
const cleared = await read();
await page.locator('[data-salary-profile="city"]').selectOption('成都');
const chengdu = await read();
await page.locator('[data-salary-profile="city"]').selectOption('北京');
for (const skill of ['JavaScript', 'FastAPI', 'TensorFlow']) await page.locator(`[data-salary-skill][value="${skill}"]`).locator('..').click();
const sparse = await read();
await page.locator('#clearSalarySkills').click();
await page.locator('[data-salary-profile="employment_type"]').selectOption('实习');
const unsupported = await read();
await page.locator('[data-salary-profile="employment_type"]').selectOption(agentModel.defaults.employment_type);
const reportedSkills = ['LLM', 'Prompt Engineering', 'Python', 'RAG'];
const combinationRows = agentModel.observed_samples.filter((item) => reportedSkills.every((skill) => item.skills.includes(skill)));
assert.equal(combinationRows.length, 513);
const grouped = new Map();
for (const item of combinationRows) {
  const key = JSON.stringify([item.city, item.experience, item.employment_type]);
  grouped.set(key, (grouped.get(key) || 0) + 1);
}
const sparseGroup = [...grouped.entries()].find(([, count]) => count === 4);
assert.ok(sparseGroup);
const [city, experience, employmentType] = JSON.parse(sparseGroup[0]);
const education = agentModel.feature_spec.categories.education[0];
const companySize = agentModel.feature_spec.categories.company_size.find((size) =>
  !combinationRows.some((item) => item.city === city && item.experience === experience && item.employment_type === employmentType && item.education === education && item.company_size === size));
assert.ok(companySize);
for (const skill of reportedSkills) await page.locator(`[data-salary-skill][value="${skill}"]`).locator('..').click();
for (const [field, value] of Object.entries({ city, experience, employment_type: employmentType, education, company_size: companySize })) {
  await page.locator(`[data-salary-profile="${field}"]`).selectOption(value);
}
const reportedSparse = await read();
assert.equal(errors.length, 0);
assert.deepEqual(cleared, baseline);
assert.notEqual(llm.value, baseline.value);
assert.notEqual(triple.value, baseline.value);
assert.notEqual(quadruple.value, triple.value);
assert.equal(baseline.value, predict([]));
assert.equal(llm.value, predict(['LLM']));
assert.equal(triple.value, predict(['LLM', 'Python', 'RAG']));
assert.equal(quadruple.value, predict(['LLM', 'Python', 'RAG', 'MCP']));
assert.notEqual(chengdu.value, baseline.value);
assert.equal(sparse.value, '样本不足');
assert.equal(unsupported.value, '样本不足');
assert.equal(reportedSparse.value, '样本不足');
assert.equal(reportedSparse.support, '513 条');
assert.ok(reportedSparse.reliability.includes('仅 4 条'));
assert.ok(llm.reliability.includes('五条件'));
assert.ok((await page.locator('.salary-model-meta').innerText()).includes('三项技能交互岭回归'));
await page.locator('.salary-model-comparison summary').click();
assert.equal(await page.locator('.salary-model-comparison tbody tr').count(), 7);
console.log(JSON.stringify({ staticModels: reports.map((report) => ({ role: report.role, selected: report.salary_model.selection.selected, metrics: report.salary_model.metrics })), ui: { baseline, llm, triple, quadruple, chengdu, sparse, unsupported, reportedSparse }, errors }, null, 2));
await browser.close();
