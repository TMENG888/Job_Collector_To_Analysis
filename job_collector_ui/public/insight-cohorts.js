// Shared by report generation and the interactive browser cohort explorer.
export function cityName(value) {
  return String(value || '').trim().split(/[|、,，/]/)[0].split(/[-—·]/)[0].replace(/市$/, '') || '未明确';
}

export function quantile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const at = (sorted.length - 1) * p;
  const lo = Math.floor(at);
  return Number((sorted[lo] + ((sorted[lo + 1] ?? sorted[lo]) - sorted[lo]) * (at - lo)).toFixed(2));
}

export function labelFrequency(rows, field) {
  const counts = new Map();
  for (const row of rows) for (const name of new Set(row[field] || [])) {
    if (!name) continue;
    if (!counts.has(name)) counts.set(name, { name, count: 0, salaries: [], evidence: [] });
    const item = counts.get(name); item.count++;
    if (Number.isFinite(row.salary_midpoint_k)) item.salaries.push(row.salary_midpoint_k);
    if (item.evidence.length < 3) item.evidence.push({ job_id: row.job_id, job_name: row.job_name, row_no: row.row_no, quote: row.evidence?.find((e) => e.label === name)?.quote || '' });
  }
  return [...counts.values()].map(({ salaries, ...item }) => ({ ...item, rate: rows.length ? item.count / rows.length : 0, salary_count: salaries.length, median_salary_k: quantile(salaries, .5) })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'));
}

export function summarizeCohort(rows) {
  const salaries = rows.map((row) => row.salary_midpoint_k).filter(Number.isFinite);
  const companies = new Map();
  for (const row of rows) {
    // Without an identifiable company, company-level shares cannot be inferred.
    if (!row.company_key) continue;
    if (!companies.has(row.company_key)) companies.set(row.company_key, new Set());
    if (row.industry && !/^(未明确|其他|不限|未知)$/.test(row.industry)) companies.get(row.company_key).add(row.industry);
  }
  const industryWeights = new Map();
  let knownCompanies = 0;
  for (const labels of companies.values()) {
    if (!labels.size) continue;
    knownCompanies++;
    for (const name of labels) industryWeights.set(name, (industryWeights.get(name) || 0) + 1 / labels.size);
  }
  const industries = [...industryWeights].map(([name, weight]) => ({ name, company_weight: Number(weight.toFixed(2)), share: knownCompanies ? weight / knownCompanies : 0 })).sort((a, b) => b.share - a.share);
  return { count: rows.length, salary_count: salaries.length, salary: { median: quantile(salaries, .5), p25: quantile(salaries, .25), p75: quantile(salaries, .75) },
    skills: labelFrequency(rows, 'skills'), tasks: labelFrequency(rows, 'tasks'), business_domains: labelFrequency(rows, 'domains'),
    industries, company_count: companies.size, industry_known_companies: knownCompanies, industry_coverage: companies.size ? knownCompanies / companies.size : 0,
    employment_types: [...new Set(rows.map((r) => r.employment_type))].map((name) => ({ name, count: rows.filter((r) => r.employment_type === name).length })),
  };
}

export function experienceCohorts(rows) {
  return [...new Set(rows.map((r) => r.experience))].map((name) => ({ name, ...summarizeCohort(rows.filter((r) => r.experience === name)) })).sort((a, b) => b.count - a.count);
}

export const cohortFilterFields = ['city', 'experience', 'education', 'company_size', 'employment_type'];
export function cohortConditionValue(row, field) {
  const value = String(row[field] ?? '').normalize('NFKC').trim();
  return field === 'city' ? cityName(value) : value || '未明确';
}
export function filterCohort(rows, profile, exceptField = '') {
  return rows.filter(row => cohortFilterFields.every(field => field === exceptField ||
    !profile[field] || cohortConditionValue(row, field) === profile[field]));
}
export function cohortFilterOptions(rows, profile, field) {
  const counts = new Map();
  for (const row of filterCohort(rows, profile, field)) {
    const value = cohortConditionValue(row, field);
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts].map(([value, count]) => ({ value, count })).sort((a,b) => a.value.localeCompare(b.value,'zh-CN'));
}
export function cohortSalaryStatistics(rows) {
  // Same 3K–200K/month quality range as the report's salary-model preparation.
  // Salary is a subset of the selected jobs, not a second condition/sample pool.
  const values = rows.map(row => row.salary_midpoint_k).filter(value =>
    typeof value === 'number' && Number.isFinite(value) && value >= 3 && value <= 200);
  return { count: values.length, excluded: rows.length - values.length,
    median: quantile(values,.5), p25: quantile(values,.25), p75: quantile(values,.75),
    mean: values.length ? values.reduce((a,b)=>a+b,0)/values.length : null };
}
