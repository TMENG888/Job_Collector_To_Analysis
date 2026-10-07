import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { approvedLabelsForWorkbook, consensusLabelsForWorkbook, prelabelsForWorkbook, labelDigest, reviewState, selectReviewAuditRows } from './reviewed_job_labels.mjs';

const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'job-label-review-'));
try {
  const inputFile = path.join(outputDir, 'fixture.xlsx');
  const row = { row_no: 2, '岗位ID': 'agent-1', '岗位名称': '智能体工程师', '技能': 'Python、RAG', '岗位描述': '负责使用 Python 构建 RAG 知识库' };
  const label = {
    row_no: 2, job_id: 'agent-1', job_name: '智能体工程师', label_platform: 'DeepSeek',
    skills: ['Python', 'RAG', '幻觉技能'], tasks: ['RAG知识库建设'],
    evidence_json: [
      { label_type: 'skill', label: 'Python', quote: '…Python…' },
      { label_type: 'skill', label: 'RAG', quote: 'RAG' },
      { label_type: 'skill', label: '幻觉技能', quote: '幻觉技能' },
      { label_type: 'task', label: 'RAG知识库建设', quote: '构建 RAG 知识库' },
    ],
  };
  await fs.writeFile(path.join(outputDir, '标注结果.jsonl'), `${JSON.stringify(label)}\n`);
  await fs.writeFile(path.join(outputDir, '标注质量报告.json'), JSON.stringify({ input_file: inputFile, completed_rows: 1 }));
  await fs.writeFile(path.join(outputDir, '人工复核.jsonl'), `${JSON.stringify({ row_no: 2, job_id: 'agent-1', label_digest: labelDigest(label), decision: 'approved' })}\n`);
  const imported = await approvedLabelsForWorkbook(outputDir, inputFile, [row], new Set(['Python', 'RAG', '幻觉技能']));
  assert.equal(imported.quality.human_approved, 1);
  assert.equal(imported.quality.matched, 1);
  assert.deepEqual(imported.accepted.get(2).skills, ['Python', 'RAG']);
  assert.deepEqual(imported.accepted.get(2).tasks, ['RAG知识库建设']);
  const sample = selectReviewAuditRows([
    { row_no: 2, job_id: 'a', employment_type: '全职', confidence: 0.9, evidence_coverage: 1 },
    { row_no: 3, job_id: 'b', employment_type: '全职', confidence: 0.9, evidence_coverage: 1 },
    { row_no: 4, job_id: 'c', employment_type: '实习', confidence: 0.5, evidence_coverage: 0.2 },
  ], new Map(), 2);
  assert.equal(sample.pending, 3);
  assert.ok(sample.rows.some((item) => item.employment_type === '实习'));
  const consensusDirs = [path.join(outputDir, 'deepseek'), path.join(outputDir, 'kimi')];
  for (const [index, directory] of consensusDirs.entries()) {
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, '标注质量报告.json'), JSON.stringify({ input_file: inputFile, platform: index ? 'kimi' : 'deepseek' }));
    const candidate = { ...label, relevance_grade: '高', label_status: '已确认', skills: ['Python', 'RAG'], tasks: [], evidence_json: index ? [{ label_type: '技能', label: 'Python', quote: 'Python' }] : label.evidence_json };
    await fs.writeFile(path.join(directory, '标注结果.jsonl'), `${JSON.stringify(candidate)}\n`);
  }
  const consensus = await consensusLabelsForWorkbook(consensusDirs, inputFile, [row], new Set(['Python', 'RAG']));
  assert.deepEqual(consensus.accepted.get(2).skills, ['Python']);
  assert.equal(consensus.quality.matched, 1);
  const ruleDir = path.join(outputDir, 'rules');
  await fs.mkdir(ruleDir);
  await fs.writeFile(path.join(ruleDir, '标注质量报告.json'), JSON.stringify({ input_file: inputFile, platform: 'rules' }));
  await fs.writeFile(path.join(ruleDir, '标注结果.jsonl'), `${JSON.stringify({ ...label, relevance_grade: '高', label_status: '待AI复核' })}\n`);
  const prelabels = await prelabelsForWorkbook(ruleDir, inputFile, [row], new Set(['Python', 'RAG']));
  assert.equal(prelabels.quality.matched, 1);
  assert.deepEqual(prelabels.accepted.get(2).skills, ['Python', 'RAG']);
  assert.match(prelabels.quality.mode, /未经人工或 AI 复核/);
  assert.equal(prelabels.nonTargetRows.size, 0);
  await fs.appendFile(path.join(ruleDir, '标注结果.jsonl'), `${JSON.stringify({ ...label, row_no: 3, job_id: 'agent-2', job_name: '智能体运营', relevance_grade: '非目标', label_status: '非目标岗位' })}\n`);
  const nonTargetRow = { row_no: 3, '岗位ID': 'agent-2', '岗位名称': '智能体运营', '技能': '', '岗位描述': '' };
  const withNonTarget = await prelabelsForWorkbook(ruleDir, inputFile, [row, nonTargetRow], new Set(['Python', 'RAG']));
  assert.ok(withNonTarget.nonTargetRows.has(3));
  await assert.rejects(approvedLabelsForWorkbook(outputDir, path.join(outputDir, 'other.xlsx'), [row], new Set(['Python'])), /来源不一致/);
  const changed = { ...label, skills: ['Python'] };
  await fs.writeFile(path.join(outputDir, '标注结果.jsonl'), `${JSON.stringify(changed)}\n`);
  assert.equal((await reviewState(outputDir)).decisions.size, 0);
  assert.equal((await approvedLabelsForWorkbook(outputDir, inputFile, [row], new Set(['Python']))).quality.matched, 0);
  console.log('reviewed label provenance and evidence checks passed');
} finally {
  const resolved = path.resolve(outputDir);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('job-label-review-')) throw new Error('临时测试目录校验失败，未清理');
  await fs.rm(resolved, { recursive: true, force: true });
}
