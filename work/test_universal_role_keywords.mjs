import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { learnUniversalRoleKeywords, matchUniversalRoleKeywords } from './universal-role-keywords.mjs';
import { literalRoleFamily } from './insight-role-selection.mjs';

const row = (id, title, jd) => ({ row_no: id + 2, '岗位ID': String(id), '岗位名称': title, '岗位描述': jd, '查询关键词': '智能体开发', '平台': '测试', '公司名称': `企业${id}`, '薪资': '10-20K', '工作城市': '北京' });
const seeds = Array.from({ length: 8 }, (_, i) => row(i, '智能体开发工程师', `岗位职责：负责AI Agent研发、RAG开发、知识检索和工具编排，交付智能体应用。场景编号${i}。任职要求：本科`));
const background = Array.from({ length: 20 }, (_, i) => row(i + 20, '销售顾问', `岗位职责：客户拜访及合同签订，地区${i}。任职要求：熟悉大模型 Prompt Dify`));
const roles = [
  'AI漫剧创作', '智能体/大模型应用', '大模型算法', '机器学习/算法', '大数据开发', '爬虫/数据采集',
  '全栈开发', '前端开发', '后端开发', '网络安全', '数据安全', '网络运维', 'Linux系统开发',
  '嵌入式开发', '测试工程', '运维/云平台', '数据运营', '人力资源', '通用软件开发', '自定义岗位',
];
for (const name of roles) {
  const family = literalRoleFamily(name);
  const fixture = Array.from({ length: 8 }, (_, i) => row(i, name === 'AI漫剧创作' ? 'AI漫剧制作师' : name,
    name === 'AI漫剧创作' ? `岗位职责：编写剧本、设计分镜、制作漫剧视频和剪辑成片。场景${i}` : seeds[i]['岗位描述']));
  const model = learnUniversalRoleKeywords([...fixture, ...background], family);
  assert.equal(model.family, name);
  assert.equal(model.algorithm, 'tfidf');
  assert.equal(matchUniversalRoleKeywords(fixture[0], model).matched, true, name);
  assert.equal(matchUniversalRoleKeywords(background[0], model).matched, false, name);
}
for (const algorithm of ['tfidf', 'textrank', 'contrast', 'fusion']) {
  const model = learnUniversalRoleKeywords([...seeds, ...background], literalRoleFamily('智能体开发'), { algorithm });
  assert.equal(matchUniversalRoleKeywords(seeds[0], model).matched, true, algorithm);
  assert.equal(matchUniversalRoleKeywords(row(99, '智能体开发', '无具体职责'), model).matched, false, '标题不能直通');
  assert.equal(matchUniversalRoleKeywords(row(99, 'Python开发', '岗位职责：负责知识检索和工具编排'), model).matched, true, '名称不明确但职责匹配');
  assert.equal(matchUniversalRoleKeywords(background[0], model).matched, false, '技术词不能直通');
}
assert.throws(() => learnUniversalRoleKeywords(seeds.slice(0, 2), literalRoleFamily('智能体开发')), /至少需要5条/);

// Run the real analysis script on a temporary dataset; never overwrite live reports.
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'universal-role-keywords-'));
const input = path.join(dir, '测试.csv');
const config = path.join(dir, 'config.json');
const output = path.join(dir, 'report.json');
const rows = [...seeds, ...background];
const headers = Object.keys(rows[0]).filter(key => key !== 'row_no');
const csv = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
await fs.writeFile(input, [headers.map(csv).join(','), ...rows.map(item => headers.map(key => csv(item[key])).join(','))].join('\n'));
await fs.writeFile(config, JSON.stringify({ inputFile: input, role: '智能体开发', analysisMode: 'full' }));
const child = spawn(process.execPath, ['work/analyze_job_market_sample.mjs', config, output], { windowsHide: true });
let logs = '';
child.stdout.on('data', chunk => logs += chunk);
child.stderr.on('data', chunk => logs += chunk);
const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
assert.equal(code, 0, logs);
const report = JSON.parse(await fs.readFile(output, 'utf8'));
assert.equal(report.selection_contract, 'role-evidence-v2');
assert.equal(report.sample_rows, seeds.length);
assert.equal(report.filtered_out_rows, background.length);
assert.equal(report.keyword_selection.version, 'role-evidence-v2');
assert.equal(report.selection_review.included_rows, seeds.length);
assert.equal(report.selection_review.pending_rows, 0);
assert.equal(report.selection_review.excluded_rows, background.length);
assert.equal(report.selection_review.included_in_statistics, false);
assert.equal(report.joint_expansion, null);
assert.match(report.sampling_method, /TF-IDF/);
console.log(JSON.stringify({ ok: true, roleFamilies: roles.length, algorithms: 4, focused: report.sample_rows, rejected: report.filtered_out_rows, testDir: dir }));
