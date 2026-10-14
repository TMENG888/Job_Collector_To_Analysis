// Read-only documentation preview. Synthetic UI data, never a collector.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cohortSalaryStatistics, summarizeCohort } from '../job_collector_ui/public/insight-cohorts.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'job_collector_ui', 'public');
const port = Number(process.env.JOB_DOCS_PORT || 18979);
const generatedAt = '2026-10-14T13:00:00+08:00';
const inputFile = 'kb://task/docs-demo-agent';
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
  id: 'docs-demo-agent', label: '智能体开发（演示）', status: 'running', currentStage:'collection',
  targetRows: 200, candidateTarget: 300, message: '合成示例：多平台并发，自动去重入库；未实际采集',
  platforms: ['shixiseng','iguopin', 'jobonline','job51','zhaopin'], cities, pace: 'balanced', outputDir: 'outputs/demo-agent',
  metrics: { knowledgeRows:120, hasFinalResult: true, finalRows: 120, publicRows: 80, zhaopinRows: 60, yupaoRows: 0, candidates: 140, duplicatesRemoved: 20,
    liveCollection:{platformCounts:{shixiseng:40,iguopin:20,jobonline:20,job51:0,zhaopin:60},details:[]}},
};
const dataset = { path: inputFile, name: '智能体开发（演示）', role:'智能体开发', resolution:'knowledge', format: 'sqlite', size: 0, canonical: true, taskId: task.id, expectedRows: 120 };
const demoModel={configured:false,provider:'deepseek',model:'deepseek-flash'};
const sessions=[
  {id:'docs-compare',title:'智能体与嵌入式怎么选？（演示）',updated:Date.now(),turn_count:1},
  {id:'docs-collection',title:'测试工程师采集方案（演示）',updated:Date.now()-86400000,turn_count:1},
];
const comparisonTurn={conversationId:'docs-compare',execution:'local',answer:'## 先比较需求，再核验具体岗位\n\n下表为**合成演示**，不能用于真实择业结论。\n\n| 方向 | 常见技术 | 招聘月薪中位数 |\n| --- | --- | --- |\n| 智能体应用 | Python、RAG、LLM | 18K |\n| 嵌入式开发 | C/C++、STM32、RTOS | 16K |\n\n技术数量不等于学习难度，招聘月薪也不等于个人可获得薪资。可继续问同城市、经验与学历的岗位证据。',trace:[{tool:'compare_roles',rows:24,status:'ready'}],filters:{},result:{mode:'compare',comparisons:[
  {role:'智能体/大模型应用',matched_jobs:12,statistics:{valid_salary_rows:12,median_salary_k:18,p25_salary_k:14,p75_salary_k:22}},
  {role:'嵌入式开发',matched_jobs:12,statistics:{valid_salary_rows:12,median_salary_k:16,p25_salary_k:12,p75_salary_k:20}},
],notice:'合成数据只读演示；真实比较需核验同条件岗位证据。'}};
const actionTurn={conversationId:'docs-collection',execution:'local',answer:'已准备采集方案，**尚未执行**。请核对下方关键词、城市、渠道和目标数量；正式服务需点击确认执行。本页只读，按钮不能启动任务。',filters:{},trace:[{tool:'collection_prepare',rows:0,status:'ready'}],result:{action:{
  id:'docs-action',status:'pending',title:'创建并启动采集',expires_at:Date.now()+10*60000,
  config:{label:'测试工程师-北京-8000',keywords:['测试工程师'],target_rows:8000,cities:['北京'],platforms:['shixiseng','iguopin','mohrss','jobonline','job51','zhaopin'],pace:'balanced'},
  warning:'目标不是交付保证；部分公开渠道城市筛选不生效。登录和验证人工处理。本页只读，不能执行采集。',
}}};
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
    // The UI uses POST to read a conversation. Only fixed synthetic replay is allowed.
    if(req.method==='POST'&&url.pathname==='/api/assistant/session'){
      let body='';for await(const chunk of req){body+=chunk;if(body.length>1024)return json(res,413,{error:'请求过大'});}
      let payload;try{payload=JSON.parse(body);}catch{return json(res,400,{error:'无效JSON'});}
      if(payload.action==='read'&&sessions.some(s=>s.id===payload.id)){
        const turn=payload.id==='docs-compare'?comparisonTurn:{...actionTurn,result:{action:{...actionTurn.result.action,expires_at:Date.now()+10*60000}}};
        return json(res,200,{id:payload.id,has_resume:false,turns:[{message:payload.id==='docs-compare'?'智能体岗位和嵌入式岗位有什么区别？（演示）':'创建北京测试工程师采集，目标8000条（演示）',turn}]});
      }
    }
    if (req.method !== 'GET') return json(res, 403, { error: '说明书演示为只读模式：不会采集、登录、打标或更改真实数据。' });
    if (url.pathname === '/api/tasks') return json(res, 200, { tasks: [task] });
    if (url.pathname.endsWith('/logs')) return json(res, 200, { content: '[演示] 候选 140 条 → 去重后 120 条。\n[演示] 请在真实任务的交付清单中核对 Excel 与目标数量。\n本页面所有数字均为合成示例，未实际启动采集。' });
    if (url.pathname === '/api/platforms') return json(res, 200, { platforms });
    if (url.pathname === '/api/labels') return json(res, 200, { jobs: [] });
    if (url.pathname === '/api/state') return json(res, 200, { version: 'docs-readonly-demo', capabilities: {} });
    if (url.pathname === '/api/insights/datasets') return json(res, 200, { datasets: [dataset] });
    if (url.pathname === '/api/knowledge/datasets') return json(res,200,{catalog:'knowledge-v1',datasets:[dataset]});
    if (url.pathname.endsWith('/source')) return json(res,200,{taskId:task.id,role:dataset.role,dataset});
    if (url.pathname === '/api/knowledge/status') return json(res,200,{revision:1,jobs:120});
    if (url.pathname === '/api/assistant/sessions') return json(res,200,{sessions,persistent:true,collection_flow_version:2});
    if (url.pathname === '/api/assistant/model') return json(res,200,demoModel);
    if (url.pathname === '/api/assistant/context') return json(res,200,{knowledge:true,revision:1,candidate_rows:120,indexed_jobs:96,roles:['智能体/大模型应用','嵌入式开发'],model:demoModel,collection_control:true});
    if (url.pathname.endsWith('/insight-source')) return json(res, 200, { dataset });
    if (url.pathname === '/api/insights') return json(res, 200, { status: 'completed', report, config: { inputFile, role: report.role } });
    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: '演示接口不存在' });
    const pageRoute = /^\/(?:tasks|platforms|labels|insights|assistant)(?:\/[^/]+)?\/?$/;
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
