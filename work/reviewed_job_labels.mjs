import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const labelKey = (item) => `${Number(item.row_no)}:${String(item.job_id || '')}`;
export const labelDigest = (item) => createHash('sha256').update(JSON.stringify(item)).digest('hex');

export async function readJsonLines(filePath) {
  const content = await fs.readFile(filePath, 'utf8');
  return content.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch { throw new Error(`${path.basename(filePath)} 第 ${index + 1} 行不是有效 JSON`); }
  });
}

export async function reviewState(outputDir) {
  const resultPath = path.join(outputDir, '标注结果.jsonl');
  const reviewPath = path.join(outputDir, '人工复核.jsonl');
  const records = await readJsonLines(resultPath);
  const reviews = await readJsonLines(reviewPath).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const latestRecords = new Map(records.map((item) => [labelKey(item), item]));
  const latestReviews = new Map(reviews.map((item) => [labelKey(item), item]));
  const decisions = new Map();
  for (const [key, record] of latestRecords) {
    const review = latestReviews.get(key);
    if (review?.label_digest === labelDigest(record) && ['approved', 'rejected'].includes(review.decision)) decisions.set(key, review.decision);
  }
  return { records: [...latestRecords.values()], decisions, reviewPath };
}

function validEvidence(record, kind, label, source) {
  const normalizedSource = String(source).replace(/\s+/g, ' ');
  const aliases = { skill: new Set(['skill', '技能']), task: new Set(['task', '职责', '任务']), domain: new Set(['domain','业务方向']) };
  return (record.evidence_json || []).some((item) => {
    if (!aliases[kind]?.has(String(item?.label_type || '')) || String(item.label || '') !== label) return false;
    const quote = String(item.quote || '').replace(/^[…\.]+|[…\.]+$/g, '').replace(/\s+/g, ' ').trim();
    return quote.length >= 2 && normalizedSource.includes(quote);
  });
}

export function selectReviewAuditRows(records, decisions, limit = 12) {
  const pending = records.filter((record) => !decisions.has(labelKey(record)));
  const groups = new Map();
  for (const record of pending) {
    const employment = String(record.employment_type || '未明确');
    const confidence = Number(record.confidence || 0) < 0.75 ? '低置信' : '高置信';
    const key = `${employment}:${confidence}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  const score = (record) => (Number(record.evidence_coverage || 0) < 0.7 ? 0 : 1) * 100000 + Number(record.row_no || 0);
  for (const rows of groups.values()) rows.sort((a, b) => score(a) - score(b));
  const ordered = [...groups.entries()].sort((a, b) => a[1].length - b[1].length || a[0].localeCompare(b[0], 'zh-CN'));
  const selected = [];
  while (selected.length < limit && ordered.some(([, rows]) => rows.length)) {
    for (const [, rows] of ordered) if (rows.length && selected.length < limit) selected.push(rows.shift());
  }
  return { pending: pending.length, rows: selected };
}

export async function approvedLabelsForWorkbook(outputDir, inputFile, rows, knownSkills) {
  const report = JSON.parse(await fs.readFile(path.join(outputDir, '标注质量报告.json'), 'utf8'));
  if (path.resolve(report.input_file).toLowerCase() !== path.resolve(inputFile).toLowerCase()) throw new Error('标注结果与本次洞察的 Excel 来源不一致');
  const { records, decisions } = await reviewState(outputDir);
  const byRow = new Map(rows.map((row) => [Number(row.row_no), row]));
  const accepted = new Map();
  const quality = { total: records.length, human_approved: 0, matched: 0, rejected_identity: 0, approved_despite_ai_non_target: 0, skills_with_evidence: 0, tasks_with_evidence: 0 };
  for (const record of records) {
    if (decisions.get(labelKey(record)) !== 'approved') continue;
    quality.human_approved += 1;
    const row = byRow.get(Number(record.row_no));
    if (!row || String(row['岗位ID'] || `row-${row.row_no}`) !== String(record.job_id) || String(row['岗位名称'] || '').trim() !== String(record.job_name || '').trim()) {
      quality.rejected_identity += 1;
      continue;
    }
    if (record.relevance_grade === '非目标' || record.label_status === '非目标岗位') quality.approved_despite_ai_non_target += 1;
    const source = [row['岗位名称'], row['技能'], row['岗位描述']].map((value) => String(value || '')).join('\n');
    const skills = [...new Set((Array.isArray(record.skills) ? record.skills : []).map(String).filter((skill) => knownSkills.has(skill) && validEvidence(record, 'skill', skill, source)))];
    const tasks = [...new Set((Array.isArray(record.tasks) ? record.tasks : []).map(String).filter((task) => validEvidence(record, 'task', task, source)))];
    if (!skills.length && !tasks.length) continue;
    quality.matched += 1;
    quality.skills_with_evidence += skills.length;
    quality.tasks_with_evidence += tasks.length;
    const domains = (record.business_domains || []).filter(name=>validEvidence(record,'domain',name,source));
    accepted.set(Number(row.row_no), { skills, tasks, domains, platform: record.label_platform || report.platform });
  }
  return { accepted, quality };
}

export async function prelabelsForWorkbook(outputDir, inputFile, rows, knownSkills) {
  const report = JSON.parse(await fs.readFile(path.join(outputDir, '标注质量报告.json'), 'utf8'));
  if (report.platform !== 'rules') throw new Error('本地预标注来源必须是规则任务');
  if (path.resolve(report.input_file).toLowerCase() !== path.resolve(inputFile).toLowerCase()) throw new Error('本地预标注与洞察 Excel 来源不一致');
  const records = await readJsonLines(path.join(outputDir, '标注结果.jsonl'));
  const byRow = new Map(rows.map((row) => [Number(row.row_no), row]));
  const accepted = new Map();
  const nonTargetRows = new Set();
  const quality = { mode: '本地规则预标注；未经人工或 AI 复核，仅采用原文有证据的标签', total: records.length, matched: 0, rejected_identity: 0, non_target: 0, skills_with_evidence: 0, tasks_with_evidence: 0 };
  for (const record of records) {
    const row = byRow.get(Number(record.row_no));
    if (!row || String(row['岗位ID'] || `row-${row.row_no}`) !== String(record.job_id) || String(row['岗位名称'] || '').trim() !== String(record.job_name || '').trim()) {
      quality.rejected_identity += 1;
      continue;
    }
    if (record.relevance_grade === '非目标' || record.label_status === '非目标岗位') {
      quality.non_target += 1;
      nonTargetRows.add(Number(row.row_no));
      continue;
    }
    const source = [row['岗位名称'], row['技能'], row['岗位描述']].map((value) => String(value || '')).join('\n');
    const skills = [...new Set((Array.isArray(record.skills) ? record.skills : []).map(String).filter((skill) => knownSkills.has(skill) && validEvidence(record, 'skill', skill, source)))];
    const tasks = [...new Set((Array.isArray(record.tasks) ? record.tasks : []).map(String).filter((task) => validEvidence(record, 'task', task, source)))];
    if (!skills.length && !tasks.length) continue;
    const domains = (record.business_domains || []).filter(name=>validEvidence(record,'domain',name,source));
    accepted.set(Number(row.row_no), { skills, tasks, domains, platform: 'rules' });
    quality.matched += 1;
    quality.skills_with_evidence += skills.length;
    quality.tasks_with_evidence += tasks.length;
  }
  return { accepted, nonTargetRows, quality, sourceName: '本地规则预标注' };
}

export async function consensusLabelsForWorkbook(outputDirs, inputFile, rows, knownSkills) {
  if (!Array.isArray(outputDirs) || outputDirs.length !== 2 || path.resolve(outputDirs[0]) === path.resolve(outputDirs[1])) throw new Error('双平台一致性标注需要两个不同的输出目录');
  const sources = await Promise.all(outputDirs.map(async (directory) => {
    const report = JSON.parse(await fs.readFile(path.join(directory, '标注质量报告.json'), 'utf8'));
    if (path.resolve(report.input_file).toLowerCase() !== path.resolve(inputFile).toLowerCase()) throw new Error('双平台标注与洞察 Excel 来源不一致');
    if (report.platform === 'rules') throw new Error('本地规则结果不能充当第二个 AI 平台');
    const records = await readJsonLines(path.join(directory, '标注结果.jsonl'));
    return { report, records: [...new Map(records.map((record) => [labelKey(record), record])).values()] };
  }));
  if (sources[0].report.platform === sources[1].report.platform) throw new Error('双平台一致性标注要求不同聊天平台');
  const byRow = new Map(rows.map((row) => [Number(row.row_no), row]));
  const right = new Map(sources[1].records.map((record) => [labelKey(record), record]));
  const accepted = new Map();
  const quality = { platforms: sources.map((source) => source.report.platform), first_rows: sources[0].records.length, second_rows: sources[1].records.length, paired_rows: 0, role_agreement_rows: 0, matched: 0, skills_with_dual_evidence: 0, tasks_with_dual_evidence: 0, mode: '双平台一致且各有原文证据；未经人工复核' };
  for (const first of sources[0].records) {
    const second = right.get(labelKey(first));
    if (!second) continue;
    quality.paired_rows += 1;
    const row = byRow.get(Number(first.row_no));
    if (!row || [first, second].some((record) => String(row['岗位ID'] || `row-${row.row_no}`) !== String(record.job_id) || String(row['岗位名称'] || '').trim() !== String(record.job_name || '').trim())) continue;
    const firstTarget = first.relevance_grade !== '非目标' && first.label_status !== '非目标岗位';
    const secondTarget = second.relevance_grade !== '非目标' && second.label_status !== '非目标岗位';
    if (firstTarget === secondTarget) quality.role_agreement_rows += 1;
    if (!firstTarget || !secondTarget) continue;
    const source = [row['岗位名称'], row['技能'], row['岗位描述']].map((value) => String(value || '')).join('\n');
    const skills = [...new Set((Array.isArray(first.skills) ? first.skills : []).map(String))].filter((skill) => knownSkills.has(skill) && (second.skills || []).includes(skill) && validEvidence(first, 'skill', skill, source) && validEvidence(second, 'skill', skill, source));
    const tasks = [...new Set((Array.isArray(first.tasks) ? first.tasks : []).map(String))].filter((task) => (second.tasks || []).includes(task) && validEvidence(first, 'task', task, source) && validEvidence(second, 'task', task, source));
    if (!skills.length && !tasks.length) continue;
    const domains = (first.business_domains || []).filter(name=>(second.business_domains || []).includes(name) && validEvidence(first,'domain',name,source) && validEvidence(second,'domain',name,source));
    accepted.set(Number(row.row_no), { skills, tasks, domains, platform: `${sources[0].report.platform}+${sources[1].report.platform}` });
    quality.matched += 1;
    quality.skills_with_dual_evidence += skills.length;
    quality.tasks_with_dual_evidence += tasks.length;
  }
  return { accepted, quality, sourceName: '双平台一致标注' };
}
