import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { SpreadsheetFile, FileBlob } from '@oai/artifact-tool';
import { labelDigest } from './reviewed_job_labels.mjs';

const run = promisify(execFile);
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const baseConfig = JSON.parse(await fs.readFile(new URL('salary_model_crawler_config.json', import.meta.url), 'utf8'));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'job-insight-label-'));
try {
  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(baseConfig.inputFile));
  const values = workbook.worksheets.getItem('岗位数据').getUsedRange(true).values;
  const headers = values[0].map(String);
  let selected;
  for (let index = 1; index < values.length; index += 1) {
    const row = Object.fromEntries(headers.map((header, column) => [header, values[index][column]]));
    if (/爬虫/.test(String(row['岗位名称'] || '')) && /Python/i.test(`${row['技能'] || ''}\n${row['岗位描述'] || ''}`)) { selected = { row, rowNo: index + 1 }; break; }
  }
  assert.ok(selected, '未找到测试岗位');
  const label = {
    row_no: selected.rowNo, job_id: String(selected.row['岗位ID'] || `row-${selected.rowNo}`), job_name: String(selected.row['岗位名称']).trim(),
    label_platform: 'DeepSeek', skills: ['Python'], tasks: [], evidence_json: [{ label_type: 'skill', label: 'Python', quote: 'Python' }],
  };
  await fs.writeFile(path.join(temporary, '标注结果.jsonl'), `${JSON.stringify(label)}\n`);
  await fs.writeFile(path.join(temporary, '人工复核.jsonl'), `${JSON.stringify({ row_no: label.row_no, job_id: label.job_id, decision: 'approved', label_digest: labelDigest(label) })}\n`);
  await fs.writeFile(path.join(temporary, '标注质量报告.json'), JSON.stringify({ input_file: baseConfig.inputFile, completed_rows: 1 }));
  const configPath = path.join(temporary, 'config.json');
  const reportPath = path.join(temporary, 'report.json');
  await fs.writeFile(configPath, JSON.stringify({ ...baseConfig, reviewedLabelDir: temporary, reviewedLabelJobId: 'integration-fixture' }));
  await run(process.execPath, ['work/analyze_job_market_sample.mjs', configPath, reportPath], { cwd: projectRoot, timeout: 120000 });
  const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
  assert.equal(report.label_provenance.human_approved, 1);
  assert.equal(report.label_provenance.matched, 1);
  assert.equal(report.label_provenance.used_in_focused_rows, 1);
  console.log('reviewed Excel label is used by salary insight');
} finally {
  const resolved = path.resolve(temporary);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('job-insight-label-')) throw new Error('临时测试目录校验失败，未清理');
  await fs.rm(resolved, { recursive: true, force: true });
}
