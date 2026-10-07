// Read-only documentation preview. Synthetic UI data, never a collector.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cohortSalaryStatistics, summarizeCohort } from '../job_collector_ui/public/insight-cohorts.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'job_collector_ui', 'public');
const port = Number(process.env.JOB_DOCS_PORT || 18979);
const generatedAt = '2026-10-07T13:00:00+08:00';
const inputFile = 'D:\\JobCollectorDemo\\demo-agent.csv';
const cities = ['北京', '上海', '杭州', '深圳'];
const observations = Array.from({ length: 96 }, (_, i) => ({
  row_no: i + 2, job_id: `DEMO-${i + 1}`, job_name: '智能体应用工程师（合成示例）',
  city: cities[i % 4], experience: ['1-3年', '3-5年', '经验不限'][Math.floor(i / 4) % 3],
  education: i % 3 ? '本科' : '硕士', company_size: i % 2 ? '100-299人' : '20-99人',
  employment_type: i % 6 ? '全职' : '实习', salary_midpoint_k: i % 8 ? 12 + (i % 13) * 1.5 : null,
  company_key: `demo-company-${i % 24}`, industry: i % 2 ? '企业服务' : '软件与信息技术',
  skills: ['LLM', ...(i % 4 ? ['Python'] : []), ...(i % 2 ? ['RAG'] : ['Dify'])],
  tasks: ['智能体应用开发', '知识库集成'], domains: [i % 2 ? '企业知识助手' : '业务流程自动化'],
  evidence: [{ label: '企业知识助手', quote: '合成示例：开发企业知识助手及检索增强工作流。' }],
}));
const salary = cohortSalaryStatistics(observations);
const summary = summarizeCohort(observations);
const report = {
  generated_at: generatedAt, input_file: inputFile, role: '智能体/大模型应用', analysis_mode: 'full',
  selection_contract: 'role-evidence-v2', sample_rows: 96, total_rows: 120,
  relevant_sample_rows: 96, filtered_out_rows: 24, relevance_rate: .8,
  detected_role: { name: '智能体/大模型应用', mode: 'manual_override', confidence: .9, evidence: {} },
  salary, quality: { salary_rows: salary.count, salary_coverage: salary.count / 96, skill_coverage: 1, task_coverage: 1 },
  cohort_observations: observations, skills: summary.skills, tasks: summary.tasks,
  business_domains: summary.business_domains, industries: summary.industries,
  cities: cities.map(name => ({ name, count: 24, median_salary_k: cohortSalaryStatistics(observations.filter(r => r.city === name)).median })),
  topic_model: { discovered_terms: [], match_methods: [] },
  label_provenance: { mode: '演示规则标签（合成数据）', used_in_focused_rows: 0 },
  selection_review: { pending_rows: 0, rows: [], note: '只读演示不包含真实待复核记录。' },
};
const task = {
  id: 'docs-demo-agent', label: '智能体开发（演示）', status: 'completed',
  targetRows: 120, candidateTarget: 180, message: '合成示例：演示交付已完成，未实际采集',
  platforms: ['iguopin', 'zhaopin'], cities, pace: 'balanced', outputDir: 'D:\\JobCollectorDemo',
  metrics: { hasFinalResult: true, finalRows: 120, publicRows: 80, zhaopinRows: 60, yupaoRows: 0, candidates: 140, duplicatesRemoved: 20 },
};
const dataset = { path: inputFile, name: '智能体开发（演示）', format: 'csv', size: 48000, canonical: true, taskId: task.id, expectedRows: 120 };
const platforms = [
  ['zhaopin', '智联招聘', '招聘平台'], ['yupao', '鱼泡直聘', '招聘平台'], ['boss', 'BOSS直聘', '招聘平台'],
  ['liepin', '猎聘', '招聘平台'], ['jobonline', '就业在线', '招聘平台'], ['job51', '前程无忧', '招聘平台'],
  ['deepseek', 'DeepSeek', 'AI聊天平台'], ['kimi', 'Kimi', 'AI聊天平台'], ['tongyi', '通义', 'AI聊天平台'],
  ['zhipu', '智谱清言', 'AI聊天平台'], ['doubao', '豆包', 'AI聊天平台'],
].map(([key, name, group]) => ({ key, name, group, status: 'not_logged_in', browserOpen: false,
  canSwitchBrowser: false, description: '演示页面：未连接真实账户，操作不可执行' }));
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (req.method !== 'GET') return json(res, 403, { error: '说明书演示为只读模式：不会采集、登录、打标或更改真实数据。' });
    if (url.pathname === '/api/tasks') return json(res, 200, { tasks: [task] });
    if (url.pathname.endsWith('/logs')) return json(res, 200, { content: '[演示] 候选 140 条 → 去重后 120 条。\n[演示] 请在真实任务的交付清单中核对 Excel 与目标数量。\n本页面所有数字均为合成示例，未实际启动采集。' });
    if (url.pathname === '/api/platforms') return json(res, 200, { platforms });
    if (url.pathname === '/api/labels') return json(res, 200, { jobs: [] });
    if (url.pathname === '/api/state') return json(res, 200, { version: 'docs-readonly-demo', capabilities: {} });
    if (url.pathname === '/api/insights/datasets') return json(res, 200, { datasets: [dataset] });
    if (url.pathname.endsWith('/insight-source')) return json(res, 200, { dataset });
    if (url.pathname === '/api/insights') return json(res, 200, { status: 'completed', report, config: { inputFile, role: report.role } });
    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: '演示接口不存在' });
    const pageRoute = /^\/(?:tasks|platforms|labels|insights)(?:\/[^/]+)?\/?$/;
    const file = url.pathname === '/' || pageRoute.test(url.pathname) ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const target = path.resolve(publicDir, file);
    if (!target.startsWith(publicDir + path.sep)) return json(res, 403, { error: 'Forbidden' });
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.geojson': 'application/json' };
    let content = await fs.readFile(target);
    if (file === 'index.html') content = Buffer.from(content.toString().replace('</body>', '<aside style="position:fixed;bottom:12px;right:18px;z-index:99999;padding:9px 14px;background:#fff2cb;border:1px solid #e1bd5f;border-radius:9px;font:13px sans-serif;color:#624300">说明书演示 · 合成数据 · 只读</aside></body>'));
    res.writeHead(200, { 'Content-Type': (types[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(content);
  } catch (error) { json(res, error.code === 'ENOENT' ? 404 : 500, { error: error.message }); }
});
server.listen(port, '127.0.0.1', () => console.log(`只读说明书演示 http://127.0.0.1:${server.address().port}（合成数据，不运行采集）`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
