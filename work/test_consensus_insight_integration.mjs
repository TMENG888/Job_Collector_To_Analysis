import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { SpreadsheetFile, FileBlob } from '@oai/artifact-tool';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const baseConfig = JSON.parse(await fs.readFile(new URL('salary_model_crawler_config.json', import.meta.url), 'utf8'));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'job-insight-consensus-'));
try {
  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(baseConfig.inputFile));
  const values = workbook.worksheets.getItem('岗位数据').getUsedRange(true).values;
  const headers = values[0].map(String);
  let selected;
  for (let index = 1; index < values.length; index++) {
    const row = Object.fromEntries(headers.map((header, column) => [header, values[index][column]]));
    if (/爬虫/.test(String(row['岗位名称'] || '')) && /Python/i.test(`${row['技能'] || ''}\n${row['岗位描述'] || ''}`)) { selected = { row, rowNo: index + 1 }; break; }
  }
  assert.ok(selected);
  const label = { row_no: selected.rowNo, job_id: String(selected.row['岗位ID'] || `row-${selected.rowNo}`), job_name: String(selected.row['岗位名称']).trim(), relevance_grade: '高', label_status: '已确认', skills: ['Python'], tasks: [], evidence_json: [{ label_type: 'skill', label: 'Python', quote: 'Python' }] };
  const dirs = [path.join(temporary, 'deepseek'), path.join(temporary, 'kimi')];
  for (const [index, directory] of dirs.entries()) {
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, '标注质量报告.json'), JSON.stringify({ input_file: baseConfig.inputFile, platform: index ? 'kimi' : 'deepseek', completed_rows: 1 }));
    await fs.writeFile(path.join(directory, '标注结果.jsonl'), `${JSON.stringify(label)}\n`);
  }
  const configPath = path.join(temporary, 'config.json');
  const outputPath = path.join(temporary, 'report.json');
  await fs.writeFile(configPath, JSON.stringify({ ...baseConfig, consensusLabelDirs: dirs }));
  await run(process.execPath, ['work/analyze_job_market_sample.mjs', configPath, outputPath], { cwd: root, timeout: 120000 });
  const report = JSON.parse(await fs.readFile(outputPath, 'utf8'));
  assert.equal(report.label_provenance.mode, '双平台一致且各有原文证据；未经人工复核');
  assert.equal(report.label_provenance.matched, 1);
  assert.equal(report.label_provenance.used_in_focused_rows, 1);
  assert.ok(report.salary_model.quality.label_source['双平台一致标注'] >= 0);
  console.log('dual-platform evidence-matched labels reach experimental salary fit');
} finally {
  const resolved = path.resolve(temporary);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('job-insight-consensus-')) throw new Error('临时测试目录校验失败，未清理');
  await fs.rm(resolved, { recursive: true, force: true });
}
