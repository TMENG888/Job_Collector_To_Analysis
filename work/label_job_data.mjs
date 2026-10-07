import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJobDataset } from './job_dataset.mjs';
import { labelPolicy, classifyPlatformFailure, visiblePlatformNotice, pacingDelay, resumeBlock } from './label_runtime_policy.mjs';
import { chromium } from 'playwright';
import {openContext} from './browser_public_channels.mjs';
import { businessRules, businessLabels } from '../job_collector_ui/public/business-rules.js';

const configPath = path.resolve(process.argv[2] || '');
if (!configPath || !fsSync.existsSync(configPath)) throw new Error('缺少AI打标配置文件');
const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
const inputFile = path.resolve(config.inputFile);
const outputDir = path.resolve(config.outputDir);
const engine = String(config.platform || 'rules');
const targetFamily = String(config.jobFamily || (engine === 'rules' ? '爬虫/数据采集' : '')).trim();
if (!targetFamily) throw new Error('AI打标缺少目标岗位族配置，已停止；请使用新版控制台创建任务，勿将其他岗位按爬虫岗位标注');
const sampleSize = Math.max(1, Math.min(20000, Number(config.sampleSize || 20)));
const policy = labelPolicy(engine, config);
const batchSize = policy.batchSize;
const samplingMode = config.samplingMode === 'spread' ? 'spread' : 'first';
const runStartedAt = Date.now();
let currentBatchIds = [];
let executionError = null;
const resultPath = path.join(outputDir, '标注结果.jsonl');
const csvPath = path.join(outputDir, '标注结果.csv');
const reportPath = path.join(outputDir, '标注质量报告.json');
const runtimePath = path.join(outputDir, '平台运行状态.json');
const platformRuntimePath = config.platformRuntimePath || '';
let runtimeState = { status: 'ready', platform: engine, policy };
const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const profileRoot = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'CodexJobCollectorProfilesV2');

const platformConfigs = {
  deepseek: { name: 'DeepSeek', url: 'https://chat.deepseek.com/' },
  kimi: { name: 'Kimi', url: 'https://kimi.com/' },
  tongyi: { name: '通义', url: 'https://www.qianwen.com/' },
  zhipu: { name: '智谱清言', url: 'https://chatglm.cn/' },
  doubao: { name: '豆包', url: 'https://www.doubao.com/chat/' },
};

await fs.mkdir(outputDir, { recursive: true });

function valueText(value) {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value).trim();
}

function unique(values) { return [...new Set(values.filter(Boolean))]; }

function randomInteger(minimum, maximum) {
  const low = Math.ceil(Math.min(minimum, maximum));
  const high = Math.floor(Math.max(minimum, maximum));
  return low + Math.floor(Math.random() * (high - low + 1));
}

function sameJobIds(rows, batch) {
  if (!Array.isArray(rows) || rows.length !== batch.length) return false;
  const expected = batch.map((job) => job.job_id).sort();
  const actual = rows.map((row) => String(row.job_id || '')).sort();
  return expected.every((id, index) => id === actual[index]);
}

function cooldownDelay(offset) {
  const completedBatches = Math.floor((offset + batchSize) / batchSize);
  return pacingDelay(policy, completedBatches, runtimeState.lastResponseMs || 0);
}

async function writeRuntime(patch) {
  runtimeState = { ...runtimeState, ...patch, currentJobIds: currentBatchIds, updatedAt: new Date().toISOString() };
  for (const destination of [runtimePath, platformRuntimePath].filter(Boolean)) {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(`${destination}.tmp`, JSON.stringify(runtimeState, null, 2), 'utf8');
    await fs.rename(`${destination}.tmp`, destination);
  }
}

async function assertPlatformReady(page) {
  const challenge = await securityChallengeMessage(page);
  if (challenge) throw new Error(`${platformConfigs[engine].name}出现安全验证，请人工处理后续跑：${challenge}`);
  const failure = visiblePlatformNotice(await page.locator('body').innerText().catch(() => ''));
  if (failure) {
    const error = new Error(`${platformConfigs[engine].name}：${failure.notice}。${failure.recovery}`);
    error.platformFailure = failure;
    throw error;
  }
}

async function pacedPromptEntry(page, input, prompt) {
  const chunkMin = Math.max(40, Number(config.typingChunkMinChars || 120));
  const chunkMax = Math.max(chunkMin, Number(config.typingChunkMaxChars || 260));
  const pauseMin = Math.max(10, Number(config.typingPauseMinMs || 35));
  const pauseMax = Math.max(pauseMin, Number(config.typingPauseMaxMs || 140));
  await input.click();
  await page.keyboard.press('Control+A').catch(() => {});
  await page.keyboard.press('Backspace').catch(() => {});
  if (engine === 'kimi') {
    await input.fill(prompt);
  } else {
    for (let offset = 0; offset < prompt.length;) {
      const size = randomInteger(chunkMin, chunkMax);
      await page.keyboard.insertText(prompt.slice(offset, offset + size));
      offset += size;
      if (offset < prompt.length) await page.waitForTimeout(randomInteger(pauseMin, pauseMax));
    }
  }
  const beforeSendMin = Math.max(300, Number(config.beforeSendMinMs || 900));
  const beforeSendMax = Math.max(beforeSendMin, Number(config.beforeSendMaxMs || 2400));
  await page.waitForTimeout(randomInteger(beforeSendMin, beforeSendMax));
}

function securityChallengeFromText(bodyText) {
  const match = bodyText.match(/请完成(?:安全|人机)?验证|访问过于频繁|请求过于频繁|异常请求|操作过于频繁|当前(?:网络|环境)存在风险|滑动[^\n]{0,20}(?:完成|通过)验证|拖动[^\n]{0,20}滑块/);
  return match?.[0] || '';
}

async function securityChallengeMessage(page) {
  const url = page.url();
  if (/captcha|challenge|security[_-]?check|verify(?:\/|\?|$)/i.test(url)) return `验证页面：${url}`;
  const bodyText = await page.locator('body').innerText().catch(() => '');
  return securityChallengeFromText(bodyText);
}

function safeRecord(row, index) {
  return {
    row_no: index + 2,
    job_id: valueText(row['岗位ID']) || `row-${index + 2}`,
    job_name: valueText(row['岗位名称']),
    source_platform: valueText(row['平台']),
    source_relevance: valueText(row['相关度分级']),
    source_relevance_reason: valueText(row['相关度依据']),
    salary: valueText(row['薪资']),
    city: valueText(row['工作城市']),
    experience: valueText(row['经验要求']),
    education: valueText(row['学历要求']),
    employment_type: valueText(row['用工类型']),
    industry: valueText(row['行业']),
    tags_text: valueText(row['福利/标签']),
    skills_text: valueText(row['技能']),
    job_description: valueText(row['岗位描述']).slice(0, 6000),
  };
}

async function readJobs() {
  const { rows } = await readJobDataset(inputFile, config.sheetName);
  const jobs = rows.map(row => safeRecord(row, row.row_no - 2));
  if (samplingMode !== 'spread' || jobs.length <= sampleSize) return jobs.slice(0, sampleSize);
  if (sampleSize === 1) return [jobs[Math.floor((jobs.length - 1) / 2)]];
  const selected = new Set();
  for (let index = 0; index < sampleSize; index += 1) selected.add(Math.floor(index * (jobs.length - 1) / (sampleSize - 1)));
  return [...selected].map((index) => jobs[index]);
}

const skillDictionary = [
  'Python', 'Java', 'JavaScript', 'TypeScript', 'Go', 'C++', 'SQL', 'Linux', 'Git', 'Docker', 'Kubernetes',
  'Scrapy', 'Requests', 'BeautifulSoup', 'Selenium', 'Playwright', 'Pyppeteer', 'Puppeteer', 'Appium',
  'MySQL', 'PostgreSQL', 'MongoDB', 'Redis', 'Elasticsearch', 'Kafka', 'RabbitMQ', 'Hadoop', 'Spark',
  'HTTP', 'HTTPS', 'TCP/IP', 'XPath', '正则表达式', '数据清洗', '数据采集', '分布式爬虫', '反爬虫',
];

function canonicalEmploymentType(job) {
  const raw = valueText(job.employment_type);
  const context = `${raw}\n${job.job_name}\n${job.job_description}`;
  if (/兼职|临时|众包|灵活用工|接单/.test(context)) return '兼职/临时';
  if (/实习/.test(context) || job.source_platform === '实习僧') return '实习';
  if (/校园|校招|应届招聘/.test(context)) return '校园招聘';
  if (/全职|社会招聘|社招/.test(context)) return '全职';
  return '未明确';
}

function sentenceQuote(value, pattern, maxLength = 120) {
  const normalized = valueText(value).replace(/\s+/g, ' ');
  if (!normalized) return '';
  const match = normalized.match(pattern);
  if (!match) return '';
  const start = Math.max(0, match.index - 35);
  const end = Math.min(normalized.length, match.index + match[0].length + 65);
  const quote = normalized.slice(start, end).trim();
  return `${start > 0 ? '…' : ''}${quote}${end < normalized.length ? '…' : ''}`.slice(0, maxLength);
}

function addEvidence(items, labelType, label, sourceField, sourceValue, pattern) {
  const quote = sentenceQuote(sourceValue, pattern);
  if (quote) items.push({ label_type: labelType, label, source_field: sourceField, quote });
}

function skillPattern(skill) {
  if (!/^[A-Za-z0-9+#/.]+$/.test(skill)) return new RegExp(skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9+#])${escaped}(?=$|[^A-Za-z0-9+#])`, 'i');
}

function ruleLabel(job) {
  const fullText = `${job.job_name}\n${job.tags_text}\n${job.skills_text}\n${job.job_description}`;
  const title = job.job_name;
  const description = job.job_description;
  const skills = unique(skillDictionary.filter((skill) => skillPattern(skill).test(fullText)));
  const excludedCollectionDomain = /用电信息采集|信号采集|图像采集|音视频采集|采集卡|数据采集器|硬件采集|医学采集|样本采集|地质采集/;
  const directTitleCue = !excludedCollectionDomain.test(title) && /爬虫|反爬|网页抓取|数据抓取|采集开发|采集工程师.*爬虫|爬虫.*采集工程师/i.test(title);
  const strongWebCue = /爬虫|反爬|网页抓取|数据抓取|网络抓取|scrapy|requests|beautifulsoup|selenium|playwright|puppeteer|xpath/i.test(`${job.skills_text}\n${description}`);
  const collectionCue = /数据采集系统|信息抽取|网页采集|采集程序|抓取数据|爬取数据|爬虫/i.test(fullText);
  const weakSource = job.source_relevance === '平台关键词匹配';
  let relevanceGrade = '低';
  if (directTitleCue || strongWebCue || job.source_relevance === '职责直接匹配') relevanceGrade = '高';
  else if (job.source_relevance === '采集技术匹配' || collectionCue) relevanceGrade = '中';
  if (weakSource && !directTitleCue && !strongWebCue && !collectionCue) relevanceGrade = '非目标';

  const taskRules = [
    ['数据采集系统开发', /爬虫|数据采集系统|信息抽取|网页采集|采集程序|数据抓取|抓取数据|爬取数据/i],
    ['数据清洗与入库', /数据清洗|清洗数据|清洗、|清洗，|入库|ETL|结构化处理|数据处理与存储/i],
    ['分布式任务调度', /分布式|任务调度|调度系统|消息队列|去重/i],
    ['采集稳定性与合规处理', /反爬|验证码|限流|封禁|风控|合规|稳定性/i],
    ['数据接口与服务开发', /(?:接口|API|服务化).{0,18}(?:开发|设计|研发|构建|维护)|(?:开发|设计|研发|构建|维护).{0,18}(?:接口|API|服务化)/i],
    ['采集系统运维', /(?:爬虫|采集)(?:系统|平台|程序|任务).{0,22}(?:维护|监控|告警|运维|部署)|(?:维护|监控|告警|运维|部署).{0,22}(?:爬虫|采集)(?:系统|平台|程序|任务)/i],
  ];
  const tasks = relevanceGrade === '非目标' ? [] : taskRules.filter(([, pattern]) => pattern.test(fullText)).map(([task]) => task);
  let seniority = '未明确';
  if (/实习|应届|经验不限|1年以下/.test(`${job.job_name} ${job.experience}`)) seniority = '入门/初级';
  else if (/1-3年|2年|3年/.test(job.experience)) seniority = '初中级';
  else if (/3-5年|5-10年|高级|专家|架构/.test(`${job.job_name} ${job.experience}`)) seniority = '中高级';
  let standardJob = '其他';
  if (relevanceGrade !== '非目标') {
    if (/爬虫|反爬/i.test(`${title}\n${description}`)) standardJob = '爬虫工程师';
    else if (collectionCue || /数据采集|信息抽取|抓取/.test(title)) standardJob = '数据采集工程师';
    else if (/数据开发|数据工程|ETL|数仓/.test(title) && relevanceGrade !== '低') standardJob = '数据开发工程师';
  }
  const labelStatus = relevanceGrade === '非目标'
    ? '非目标岗位'
    : relevanceGrade === '高' && standardJob !== '其他' && (skills.length || tasks.length) ? '已确认' : '待AI复核';
  const riskSignals = unique([
    /兼职|接单|在家|多劳多得|日结/.test(fullText) ? '兼职或众包描述' : '',
    /培训机构|课程招生|收费培训|缴纳学费|保证就业|付费学习/.test(fullText) ? '培训招生信号' : '',
    job.job_description.length < 80 ? '岗位描述过短' : '',
    labelStatus === '非目标岗位' ? '岗位相关性弱' : '',
  ]);
  const evidenceItems = [];
  const standardPattern = standardJob === '爬虫工程师' ? /爬虫|反爬/i : standardJob === '数据采集工程师' ? /数据采集|信息抽取|抓取/i : /数据开发|数据工程|ETL|数仓/i;
  if (standardJob !== '其他') {
    addEvidence(evidenceItems, 'standard_job', standardJob, '岗位名称', title, standardPattern);
    if (!evidenceItems.some((item) => item.label_type === 'standard_job')) addEvidence(evidenceItems, 'standard_job', standardJob, '岗位描述', description, standardPattern);
  } else {
    const quote = job.source_relevance_reason || title;
    if (quote) evidenceItems.push({ label_type: 'standard_job', label: '其他', source_field: job.source_relevance_reason ? '相关度依据' : '岗位名称', quote: quote.slice(0, 120) });
  }
  for (const skill of skills) {
    const pattern = skillPattern(skill);
    const before = evidenceItems.length;
    addEvidence(evidenceItems, 'skill', skill, '技能', job.skills_text, pattern);
    if (evidenceItems.length === before) addEvidence(evidenceItems, 'skill', skill, '岗位描述', description, pattern);
  }
  for (const [task, pattern] of taskRules) {
    if (!tasks.includes(task)) continue;
    const before = evidenceItems.length;
    addEvidence(evidenceItems, 'task', task, '岗位描述', description, pattern);
    if (evidenceItems.length === before) addEvidence(evidenceItems, 'task', task, '技能', job.skills_text, pattern);
    if (evidenceItems.length === before) addEvidence(evidenceItems, 'task', task, '福利/标签', job.tags_text, pattern);
    if (evidenceItems.length === before) addEvidence(evidenceItems, 'task', task, '岗位名称', title, pattern);
  }
  if (seniority !== '未明确') addEvidence(evidenceItems, 'seniority', seniority, '经验要求', job.experience, /.+/);
  const normalizedEmployment = canonicalEmploymentType(job);
  if (normalizedEmployment !== '未明确') {
    const employmentQuote = job.employment_type || job.job_name;
    evidenceItems.push({ label_type: 'employment_type', label: normalizedEmployment, source_field: job.employment_type ? '用工类型' : '岗位名称', quote: employmentQuote.slice(0, 120) });
  }
  const labeledCount = 1 + skills.length + tasks.length;
  const coveredCount = evidenceItems.filter((item) => ['standard_job', 'skill', 'task'].includes(item.label_type)).length;
  const evidenceCoverage = labeledCount ? Math.min(1, coveredCount / labeledCount) : 0;
  const sourceCompleteness = [job.job_name, job.job_description, job.skills_text, job.experience, normalizedEmployment !== '未明确' ? normalizedEmployment : ''].filter(Boolean).length / 5;
  let confidence = 0.3
    + (relevanceGrade === '高' ? 0.25 : relevanceGrade === '中' ? 0.15 : relevanceGrade === '低' ? 0.06 : 0.12)
    + Math.min(0.1, skills.length * 0.02)
    + Math.min(0.1, tasks.length * 0.03)
    + evidenceCoverage * 0.12
    + sourceCompleteness * 0.08;
  if (labelStatus === '待AI复核') confidence = Math.min(confidence, 0.74);
  if (labelStatus === '非目标岗位') confidence = strongWebCue || directTitleCue ? 0.62 : 0.82;
  if (!evidenceItems.length) confidence = Math.min(confidence, 0.5);
  confidence = Number(Math.max(0, Math.min(0.95, confidence)).toFixed(3));
  const evidence = evidenceItems.slice(0, 6).map((item) => `${item.label_type}[${item.label}]@${item.source_field}:${item.quote}`).join(' || ');
  return {
    standard_job: standardJob,
    job_family: standardJob === '其他' ? '其他' : '数据采集与处理',
    relevance_grade: relevanceGrade,
    relevance_reason: job.source_relevance_reason || (directTitleCue ? '岗位标题包含明确爬虫或网页采集职责' : strongWebCue ? '岗位描述包含明确爬虫技术' : '缺少明确爬虫或网页数据采集依据'),
    label_status: labelStatus,
    seniority,
    source_employment_type: job.employment_type,
    employment_type: normalizedEmployment,
    skills,
    tasks,
    risk_signals: riskSignals,
    evidence,
    evidence_json: evidenceItems,
    evidence_coverage: Number(evidenceCoverage.toFixed(3)),
    confidence,
  };
}

function agentRuleLabel(job) {
  const title = valueText(job.job_name);
  const description = valueText(job.job_description);
  const skillsText = valueText(job.skills_text);
  const skillRules = [
    ['LLM', /大语言模型|大模型|\bLLM\b/i], ['Python', /\bPython\b/i], ['RAG', /\bRAG\b|检索增强生成/i],
    ['Prompt Engineering', /Prompt|提示词工程|提示工程/i], ['LangChain', /LangChain/i], ['Dify', /\bDify\b/i],
    ['FastAPI', /FastAPI/i], ['MCP', /\bMCP\b|Model Context Protocol/i], ['LlamaIndex', /LlamaIndex/i],
    ['Linux', /\bLinux\b/i], ['Docker', /Docker/i], ['MySQL', /MySQL/i], ['Redis', /Redis/i],
    ['SQL', /\bSQL\b/i], ['Kubernetes', /Kubernetes|\bK8s\b/i], ['Git', /\bGit\b/i],
    ['Java', /\bJava\b(?!Script)/i], ['PyTorch', /PyTorch/i], ['C/C++', /C\+\+|C\/C\+\+/i],
    ['TensorFlow', /TensorFlow/i], ['模型微调', /模型微调|指令微调|Fine.?tuning|\bSFT\b|\bLoRA\b/i],
    ['JavaScript', /JavaScript|\bJS\b/i], ['React', /React/i], ['微服务', /微服务|Microservices?/i],
    ['Spring Boot', /Spring.?Boot/i], ['Vue', /Vue(?:\.js)?/i],
  ];
  const taskRules = [
    ['智能体编排与工作流', /智能体.{0,12}(编排|工作流|流程)|Agent.{0,12}(workflow|orchestration)|工作流.{0,12}(搭建|开发|设计)/i],
    ['RAG知识库建设', /RAG|知识库|检索增强|向量检索/i],
    ['Prompt与效果优化', /Prompt|提示词|模型评测|幻觉|效果优化/i],
    ['模型接入与推理服务', /模型接入|推理服务|模型部署|Function.?Calling|工具调用|MCP/i],
  ];
  const titleCue = /智能体|AI.?Agent|Agent开发|大模型应用|AI应用|LLM应用/i.test(title);
  const developmentCue = /开发|研发|构建|搭建|设计|部署|编排|工程|技术/i.test(`${title}\n${description}`);
  const contentCue = /智能体|\bAgent\b|\bRAG\b|LangChain|\bLLM\b|大模型应用/i.test(`${skillsText}\n${description}`);
  const nonTechnicalTitle = /产品经理|产品规划|市场分析|运营|销售|课程|培训|主播|客服|商务拓展|训练师|测试|评测|标注/i.test(title) && !/开发|工程师|研发/i.test(title);
  const titleDevelopmentCue = /开发|研发|工程师|构建|搭建|技术|算法/i.test(title);
  const relevanceGrade = nonTechnicalTitle ? '非目标' : titleCue && titleDevelopmentCue ? '高' : contentCue && developmentCue ? '中' : '非目标';
  const standardJob = relevanceGrade === '非目标' ? '其他'
    : /实习/.test(title) ? '智能体应用开发实习生'
      : /算法|模型训练|微调/.test(title) ? '大模型应用算法工程师' : '智能体应用开发工程师';
  const evidenceJson = [];
  const evidence = (labelType, label, sourceField, source, regex) => {
    const match = source.match(regex);
    if (match) evidenceJson.push({ label_type: labelType, label, source_field: sourceField, quote: match[0] });
  };
  if (titleCue) evidence('standard_job', standardJob, 'job_name', title, /智能体|AI.?Agent|Agent|大模型应用|AI应用|LLM应用/i);
  else if (contentCue) evidence('standard_job', standardJob, 'job_description', description, /智能体|\bAgent\b|\bRAG\b|LangChain|\bLLM\b|大模型应用/i);
  else evidence('standard_job', standardJob, 'job_name', title, /.+/);
  const skills = [];
  for (const [name, regex] of skillRules) {
    if (regex.test(skillsText)) { skills.push(name); evidence('skill', name, 'skills_text', skillsText, regex); }
    else if (regex.test(description)) { skills.push(name); evidence('skill', name, 'job_description', description, regex); }
  }
  const tasks = [];
  if (relevanceGrade !== '非目标') for (const [name, regex] of taskRules) {
    if (regex.test(description)) { tasks.push(name); evidence('task', name, 'job_description', description, regex); }
  }
  const expectedEvidence = 1 + skills.length + tasks.length;
  const riskSignals = unique([
    /培训机构|课程招生|收费培训|缴纳学费|付费学习/.test(`${title}\n${description}`) ? '培训招生信号' : '',
    description.replace(/\s+/g, '').length < 80 ? '岗位描述过短' : '',
    relevanceGrade === '非目标' ? '岗位相关性待核实' : '',
  ]);
  return {
    standard_job: standardJob, job_family: relevanceGrade === '非目标' ? '其他' : targetFamily,
    relevance_grade: relevanceGrade, relevance_reason: titleCue ? '岗位标题含智能体或大模型应用线索' : contentCue ? '岗位描述含应用开发技术线索' : '缺少明确智能体应用开发职责',
    label_status: relevanceGrade === '非目标' ? '非目标岗位' : '待AI复核',
    seniority: /实习|应届|1年以下/.test(`${title} ${job.experience}`) ? '入门/初级' : /5-10年|高级|专家|架构/.test(`${title} ${job.experience}`) ? '中高级' : /1-3年|3-5年/.test(job.experience) ? '初中级' : '未明确',
    employment_type: canonicalEmploymentType(job), skills, tasks, risk_signals: riskSignals,
    evidence_json: evidenceJson, evidence_coverage: Number((evidenceJson.length / expectedEvidence).toFixed(3)),
    evidence: evidenceJson.slice(0, 6).map((item) => `${item.label_type}[${item.label}]@${item.source_field}:${item.quote}`).join(' || '),
    confidence: 0.5,
  };
}

function buildPrompt(batch) {
  const guidance = `补充结构要求：返回 business_domains（数组，只允许${businessRules.map(([name])=>name).join('、')}）及 industry_candidates（数组）。业务方向需有职责中的明确业务场景，通用文档或代码不代表业务领域；行业仅用industry字段或明确公司业务证据，客户行业不能当作雇主行业，无证据返回空数组。evidence_json额外允许label_type=domain、industry，source_field额外允许industry。每条最多6个规范职责，引用尽量小于90字符。`;
  return buildBasePrompt(batch).replace('\n输入：', `\n${guidance}\n输入：`);
}

function buildBasePrompt(batch) {
  const salaryBlindBatch = batch.map(({ salary, ...job }) => job);
  if (targetFamily !== '爬虫/数据采集') {
    const familyGuidance = targetFamily === '智能体/大模型应用'
      ? '“AI智能体开发”“Agent开发”“大模型应用开发”属于目标岗位；标题明确为智能体开发时不能仅因出现 Claude Code、Cursor 等工具名就判为非目标。只有纯工具使用、销售或培训且没有应用开发职责时才判为非目标。'
      : '标题明确指向目标岗位族且职责相符时应判为目标；不要仅凭通用技术名判定相关。';
    return `你是招聘岗位结构化标注员。目标岗位族：${targetFamily}。${familyGuidance}仅依据输入文本标注，不得补充原文没有的信息。返回严格 JSON 数组，不要 Markdown 或解释。每条包含 job_id、standard_job（根据岗位名称归一的具体岗位，非目标写其他）、job_family（目标岗位族或其他）、relevance_grade（高/中/低/非目标）、label_status（已确认/待AI复核/非目标岗位）、seniority、employment_type、skills（数组）、tasks（数组）、risk_signals（数组）、evidence_json（数组，每项含 label_type、label、source_field、quote）、confidence（0到1）。evidence_json.label_type 只能是 standard_job、skill、task，不要用“岗位类型”“技能”“职责”等中文值；source_field 只能是 job_name、skills_text、job_description；quote 必须是对应原文中的连续原样片段，不加省略号。岗位族相关性必须由标题或职责中的明确证据支持；只有弱关键词而无目标岗位职责时标为非目标。技能只提取 skills_text 或 job_description 明确出现的名称；职责必须有 job_description 原文支持。每个技能和职责都提供对应原文 quote，不要猜测隐含能力。风险仅标记原文明示内容，安全验证或账号信息不属于岗位技能。\n输入：${JSON.stringify(salaryBlindBatch)}`;
  }
  return `你是招聘岗位结构化标注员。仅依据输入文本标注，不得补充原文没有的信息。返回严格JSON数组，不要Markdown代码块和解释。\n字段：job_id、standard_job、job_family、relevance_grade（高/中/低/非目标）、label_status（已确认/待AI复核/非目标岗位）、seniority、employment_type（全职/实习/兼职\/临时/校园招聘/未明确）、skills（字符串数组）、tasks（字符串数组）、risk_signals（字符串数组）、evidence（原文引用摘要）、evidence_json（数组，每项含label_type、label、source_field、quote）、confidence（0到1）。\n标准岗位只使用“爬虫工程师、数据采集工程师、数据开发工程师、其他”。弱关键词匹配且缺少明确爬虫、网页抓取、信息抽取或采集开发证据时，必须标记standard_job=其他、relevance_grade=非目标、label_status=非目标岗位，不得用数据开发工程师兜底。seniority保留原文明示的经验等级。skills必须同时扫描skills_text和job_description，只提取原文明确出现的技能。任务标签必须有岗位描述原文支持；“数据接口与服务开发”须同时出现接口/API/服务化和开发/设计/研发语义；“采集系统运维”须明确指向爬虫或采集系统。evidence_json必须为每个岗位类型、技能和任务提供source_field与原文quote。风险仅标记原文明示的兼职众包、培训招生、疑似非招聘；仅当job_description去除空白后少于80个字符时才标记“描述过短”。\n输入：${JSON.stringify(salaryBlindBatch)}`;
}

function parseModelJson(text) {
  const raw = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const variants = [raw, raw.replace(/[“”]/g, '"').replace(/[‘’]/g, "'")];
  for (const cleaned of variants) {
    const starts = [];
    const ends = [];
    for (let index = 0; index < cleaned.length; index += 1) {
      if (cleaned[index] === '[') starts.push(index);
      if (cleaned[index] === ']') ends.push(index);
    }
    for (let startIndex = starts.length - 1; startIndex >= 0; startIndex -= 1) {
      for (let endIndex = ends.length - 1; endIndex >= 0; endIndex -= 1) {
        if (ends[endIndex] <= starts[startIndex]) continue;
        try {
          const rows = JSON.parse(cleaned.slice(starts[startIndex], ends[endIndex] + 1));
          if (Array.isArray(rows) && rows.length && rows.every((row) => row && typeof row === 'object' && row.job_id && row.standard_job)) return rows;
        } catch {}
      }
    }
  }
  throw new Error('模型回复中没有符合标签结构的JSON数组');
}

async function visibleFirst(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count();
    for (let index = count - 1; index >= 0; index -= 1) {
      const item = locator.nth(index);
      if (await item.isVisible().catch(() => false)) return item;
    }
  }
  return null;
}

async function visibleFirstWithin(page, selectors, timeoutMs) {
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs || 30000));
  while (Date.now() < deadline) {
    const match = await visibleFirst(page, selectors);
    if (match) return match;
    await page.waitForTimeout(1000);
  }
  return null;
}

async function openFreshConversation(page) {
  const trigger = await visibleFirstWithin(page, [
    'a.new-chat-btn',
    'button:has-text("新对话")', '[role="button"]:has-text("新对话")', 'a:has-text("新对话")',
    'button:has-text("新建会话")', '[role="button"]:has-text("新建会话")', 'a:has-text("新建会话")',
    'button:has-text("开启新对话")', '[role="button"]:has-text("开启新对话")', '[aria-label*="新对话"]', '[title*="新对话"]',
  ], 6000);
  if (!trigger) return false;
  await trigger.click();
  await page.waitForTimeout(randomInteger(1800, 3200));
  const challenge = await securityChallengeMessage(page);
  if (challenge) throw new Error(`${platformConfigs[engine].name}新建对话时出现安全验证，请人工处理后续跑：${challenge}`);
  return true;
}

async function runRpa(jobs, onBatch) {
  const platform = platformConfigs[engine];
  if (!platform) throw new Error(`不支持的聊天平台：${engine}`);
  const navigationTimeoutMs = Math.max(45000, Number(config.navigationTimeoutMs || 120000));
  const inputTimeoutMs = Math.max(10000, Number(config.inputTimeoutMs || 45000));
  const context = await openContext(engine);
  try {
    const page = context.pages()[0] || await context.newPage();
    let httpFailure = null;
    page.on('response', response => {
      const url = new URL(response.url());
      const platformDomain = new URL(platform.url).hostname.replace(/^(chat\.|www\.)/, '');
      if ((url.hostname === platformDomain || url.hostname.endsWith(`.${platformDomain}`)) && response.status() === 429) {
        httpFailure = classifyPlatformFailure('HTTP 429 rate limit');
      }
    });
    await page.goto(platform.url, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs });
    await page.waitForTimeout(3500);
    const loginSignal = /sign[_-]?in|login|passport|auth/i.test(page.url());
    if (loginSignal) throw new Error(`${platform.name}尚未登录，请先在“平台登录”页面完成人工登录`);
    await assertPlatformReady(page);
    const openingText = await page.locator('body').innerText().catch(() => '');
    if (jobs.some((job) => openingText.includes(job.job_id))) {
      const created = await openFreshConversation(page);
      if (!created) throw new Error(`${platform.name}当前对话含历史同岗位内容，且未能通过正常页面操作创建空白对话；请人工新建空白对话后续跑`);
    }
    for (let offset = 0; offset < jobs.length; offset += batchSize) {
      const batchIndex = Math.floor(offset / batchSize);
      const rotateEvery = Math.max(1, Number(config.rotateConversationEveryBatches || 10));
      if (batchIndex > 0 && batchIndex % rotateEvery === 0) {
        if (!await openFreshConversation(page)) {
          await page.goto(platform.url, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs });
          await page.waitForTimeout(3500);
        }
        const rotationChallenge = await securityChallengeMessage(page);
        if (rotationChallenge) throw new Error(`${platform.name}会话轮换后出现安全验证，请人工处理后续跑：${rotationChallenge}`);
      }
      const batchStartedAt = Date.now();
      const batch = jobs.slice(offset, offset + batchSize);
      currentBatchIds = batch.map((job) => job.job_id);
      await writeRuntime({ status: 'running', stage: 'checking_page', nextActionAt: null });
      await assertPlatformReady(page);
      if (httpFailure) { const error = new Error(`${platform.name} HTTP 429，平台已限流`); error.platformFailure = httpFailure; throw error; }
      const input = await visibleFirstWithin(page, [
        'textarea', '[contenteditable="true"][role="textbox"]', '[contenteditable="true"]', '[role="textbox"]', '.chat-input-editor',
      ], inputTimeoutMs);
      if (!input) {
        const controls = await page.locator('textarea,input,[contenteditable],[role="textbox"]').evaluateAll((elements) => elements.slice(0, 20).map((element) => ({
          tag: element.tagName, type: element.getAttribute('type'), role: element.getAttribute('role'),
          contenteditable: element.getAttribute('contenteditable'), placeholder: element.getAttribute('placeholder'),
          ariaLabel: element.getAttribute('aria-label'), className: String(element.className || '').slice(0, 160),
        })));
        throw new Error(`${platform.name}未找到聊天输入框，页面可能已改版或出现验证。URL=${page.url()}；控件=${JSON.stringify(controls)}`);
      }
      const challenge = await securityChallengeMessage(page);
      if (challenge) throw new Error(`${platform.name}出现安全验证，请人工处理后续跑：${challenge}`);
      const responseSelectors = ['[class*="markdown"]', '[class*="assistant"]', '[data-role="assistant"]', '[data-testid*="message"]', '[class*="message"]', 'article'];
      const beforeCounts = await Promise.all(responseSelectors.map((selector) => page.locator(selector).count()));
      const prompt = buildPrompt(batch);
      await writeRuntime({ stage: 'entering_prompt' });
      const inputType = await input.evaluate((element) => ({ tag: element.tagName, contenteditable: element.getAttribute('contenteditable') }));
      if (inputType.tag === 'TEXTAREA' || inputType.tag === 'INPUT' || inputType.contenteditable === 'true') {
        await pacedPromptEntry(page, input, prompt);
        if (engine === 'doubao') {
          const sendButton = page.locator('#flow-end-msg-send');
          await sendButton.waitFor({ state: 'visible', timeout: 10000 });
          await page.waitForTimeout(randomInteger(350, 900));
          await sendButton.click();
        } else {
          await input.press('Enter');
        }
      } else {
        await input.click();
        await page.keyboard.press('Control+A');
        await page.keyboard.insertText(prompt);
        await page.keyboard.press('Enter');
      }
      let responseText = '';
      let parsed = null;
      await writeRuntime({ stage: 'waiting_response' });
      const deadline = Date.now() + policy.responseTimeoutMs;
      while (Date.now() < deadline) {
        await page.waitForTimeout(1800);
        await assertPlatformReady(page);
        if (httpFailure) { const error = new Error(`${platform.name} HTTP 429，平台已限流`); error.platformFailure = httpFailure; throw error; }
        const candidates = [];
        for (let index = 0; index < responseSelectors.length; index += 1) {
          const locator = page.locator(responseSelectors[index]);
          const count = await locator.count();
          if (count > beforeCounts[index]) candidates.push(await locator.last().innerText().catch(() => ''));
        }
        const pageText = await page.locator('body').innerText().catch(() => '');
        const responseChallenge = securityChallengeFromText(pageText);
        if (responseChallenge) throw new Error(`${platform.name}生成过程中出现安全验证，请人工处理后续跑：${responseChallenge}`);
        candidates.push(pageText.slice(-30000));
        responseText = candidates.sort((a, b) => b.length - a.length)[0] || '';
        for (const candidate of candidates) {
          try {
            const rows = parseModelJson(candidate);
            if (sameJobIds(rows, batch)) {
              parsed = rows;
              responseText = candidate;
              break;
            }
          } catch {}
        }
        if (parsed) break;
      }
      if (!parsed) {
        const pageTail = (await page.locator('body').innerText().catch(() => '')).slice(-2400);
        const expectedIds = batch.map((job) => job.job_id).join(', ');
        throw new Error(`${platform.name}等待本批岗位ID（${expectedIds}）的回复超时；未保存任何不匹配的历史回复。回复摘要=${responseText.slice(0, 1200)}；页面末尾=${pageTail}`);
      }
      await onBatch(batch, parsed, platform.name, { batchSeconds: Number(((Date.now() - batchStartedAt) / 1000).toFixed(2)) });
      runtimeState.lastResponseMs = Date.now() - batchStartedAt;
      if (offset + batchSize < jobs.length) {
        const delay = cooldownDelay(offset);
        await writeRuntime({ stage: 'cooldown', nextActionAt: new Date(Date.now() + delay).toISOString() });
        console.log(`[节奏] 已保存本批；冷却 ${Math.ceil(delay / 1000)} 秒后处理下一批`);
        await page.waitForTimeout(delay);
      }
    }
  } finally {
    await context.close();
  }
}

function csvCell(value) {
  const text = Array.isArray(value)
    ? (value.every((item) => item == null || ['string', 'number', 'boolean'].includes(typeof item)) ? value.join(' | ') : JSON.stringify(value))
    : value && typeof value === 'object' ? JSON.stringify(value) : value == null ? '' : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

const jobs = await readJobs();
const completed = new Map();
try {
  const lines = (await fs.readFile(resultPath, 'utf8')).split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const item = JSON.parse(line);
    completed.set(item.job_id, item);
  }
} catch {}

function normalizeLabel(job, label) {
  const arrays = ['skills', 'tasks', 'risk_signals'];
  const baseline = targetFamily === '智能体/大模型应用' ? agentRuleLabel(job) : ruleLabel(job);
  const normalized = { ...label, job_id: String(label.job_id || job.job_id) };
  for (const key of arrays) normalized[key] = unique(Array.isArray(normalized[key]) ? normalized[key].map(valueText) : splitText(normalized[key]));
  normalized.standard_job = valueText(normalized.standard_job) || '其他';
  if (targetFamily === '爬虫/数据采集' && !['爬虫工程师', '数据采集工程师', '数据开发工程师', '其他'].includes(normalized.standard_job)) normalized.standard_job = '其他';
  normalized.standard_job = normalized.standard_job.slice(0, 60);
  normalized.relevance_grade = valueText(normalized.relevance_grade) || (targetFamily === '爬虫/数据采集' ? baseline.relevance_grade : '低');
  if (!['高', '中', '低', '非目标'].includes(normalized.relevance_grade)) normalized.relevance_grade = '低';
  normalized.job_family = normalized.relevance_grade === '非目标' ? '其他' : targetFamily;
  normalized.relevance_reason = valueText(normalized.relevance_reason) || (targetFamily === '爬虫/数据采集' ? baseline.relevance_reason : '待人工复核');
  normalized.label_status = valueText(normalized.label_status)
    || (normalized.relevance_grade === '非目标' ? '非目标岗位' : normalized.relevance_grade === '高' ? '已确认' : '待AI复核');
  normalized.seniority = valueText(normalized.seniority) || '未明确';
  normalized.source_employment_type = job.employment_type;
  normalized.employment_type = canonicalEmploymentType(job);
  normalized.evidence = valueText(normalized.evidence);
  if (!Array.isArray(normalized.evidence_json)) normalized.evidence_json = targetFamily === '爬虫/数据采集' ? baseline.evidence_json : [];
  const evidenceTypes = { '岗位类型': 'standard_job', '岗位': 'standard_job', '技能': 'skill', '职责': 'task', '任务': 'task' };
  normalized.evidence_json = normalized.evidence_json.map((item) => ({ ...item, label_type: evidenceTypes[valueText(item?.label_type)] || valueText(item?.label_type) }));
  const expectedEvidence = 1 + normalized.skills.length + normalized.tasks.length;
  const actualEvidence = normalized.evidence_json.filter((item) => item && ['standard_job', 'skill', 'task'].includes(valueText(item.label_type)) && valueText(item.quote)).length;
  normalized.evidence_coverage = expectedEvidence ? Number(Math.min(1, actualEvidence / expectedEvidence).toFixed(3)) : 0;
  if (!normalized.evidence) normalized.evidence = normalized.evidence_json.slice(0, 6).map((item) => `${valueText(item.label_type)}[${valueText(item.label)}]@${valueText(item.source_field)}:${valueText(item.quote)}`).join(' || ');
  normalized.confidence = Math.max(0, Math.min(1, Number(normalized.confidence || 0)));
  if (normalized.label_status === '待AI复核') normalized.confidence = Math.min(normalized.confidence || baseline.confidence, 0.74);
  if (!normalized.evidence) normalized.confidence = Math.min(normalized.confidence, 0.5);
  return normalized;
}

function splitText(value) {
  return valueText(value).split(/[|,，、;；\n]+/).map((item) => item.trim()).filter(Boolean);
}

async function saveBatch(batch, labels, model, metadata = {}) {
  if (!sameJobIds(labels, batch)) throw new Error(`模型回复岗位ID与本批不一致，未写入结果：预期=${batch.map((job) => job.job_id).join(',')}，实际=${Array.isArray(labels) ? labels.map((label) => label?.job_id).join(',') : '非数组'}`);
  const byId = new Map(labels.map((label) => [String(label.job_id), label]));
  for (const job of batch) {
    const label = byId.get(job.job_id);
    if (!label) throw new Error(`模型回复缺少岗位ID：${job.job_id}`);
    const result = { ...job, ...normalizeLabel(job, label), ...metadata, label_platform: model, label_version: 'job-label-v2.1', labeled_at: new Date().toISOString() };
    const inferredDomains = businessLabels(job.job_description);
    const modelDomains = Array.isArray(label.business_domains) ? label.business_domains : [];
    const validDomainEvidence = (label.evidence_json || []).filter(e=>['domain','业务方向'].includes(e.label_type) && modelDomains.includes(e.label) && String(e.quote || '').length>=2 && job.job_description.includes(e.quote));
    result.business_domains = [...new Set(validDomainEvidence.length ? validDomainEvidence.map(e=>e.label) : inferredDomains.map(e=>e.label))];
    result.business_label_source = validDomainEvidence.length ? model : '原文规则补充';
    result.evidence_json.push(...(validDomainEvidence.length ? validDomainEvidence : inferredDomains));
    result.industry_candidates = (Array.isArray(label.industry_candidates) ? label.industry_candidates : []).filter(name=>(label.evidence_json || []).some(e=>e.label_type==='industry' && e.label===name && String(e.quote || '').length>=2 && [job.industry,job.job_description].some(source=>String(source || '').includes(e.quote))));
    completed.set(job.job_id, result);
    await fs.appendFile(resultPath, `${JSON.stringify(result)}\n`, 'utf8');
  }
  if (engine !== 'rules' || completed.size % 100 === 0 || completed.size === jobs.length) console.log(`已完成 ${completed.size}/${jobs.length}`);
  if (engine !== 'rules' || completed.size % 100 === 0 || completed.size === jobs.length) await writeOutputs(false);
}

const initialCompletedCount = completed.size;
const pending = jobs.filter((job) => !completed.has(job.job_id));
try {
if (process.argv.includes('--summarize')) {
  // Rebuild metadata from existing rows without invoking a model or marking a review approved.
} else if (engine === 'rules') {
  for (const job of pending) await saveBatch([job], [{ job_id: job.job_id, ...(targetFamily === '智能体/大模型应用' ? agentRuleLabel(job) : ruleLabel(job)) }], '本地规则预标注 v3');
} else {
  if (platformRuntimePath) {
    const saved = await fs.readFile(platformRuntimePath, 'utf8').then(JSON.parse).catch(() => null);
    const block = resumeBlock(saved);
    if (block) { const error = new Error(block); error.platformFailure = { ...saved, code: saved.errorCode, pause: true, cooldownMs: 0 }; throw error; }
  }
  await writeRuntime({ status: 'running', stage: 'starting', retryAfter: null, requiresHuman: false, errorCode: '', recovery: '' });
  const maximumAttempts = policy.platformRetryAttempts;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const remaining = jobs.filter((job) => !completed.has(job.job_id));
    if (!remaining.length) break;
    try {
      await runRpa(remaining, saveBatch);
      break;
    } catch (error) {
      const message = String(error?.message || error);
      const failure = error.platformFailure || classifyPlatformFailure(message);
      if (failure.pause || attempt >= maximumAttempts) throw error;
      const baseBackoff = policy.retryBackoffMs;
      const backoff = baseBackoff * (2 ** (attempt - 1)) + randomInteger(1000, 5000);
      await writeRuntime({ stage: 'retry_backoff', attempt, nextActionAt: new Date(Date.now() + backoff).toISOString() });
      console.warn(`${platformConfigs[engine].name}第 ${attempt} 次运行中断，将在 ${Math.round(backoff / 1000)} 秒后从已保存结果续标：${message.slice(0, 240)}`);
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
}
} catch(error) { executionError = error; }

if (!process.argv.includes('--summarize') && engine !== 'rules') {
  const failure = executionError ? executionError.platformFailure || classifyPlatformFailure(executionError.message) : null;
  await writeRuntime({ status: executionError ? failure.pause ? 'paused' : 'failed' : 'completed', stage: executionError ? 'stopped' : 'completed', errorCode: failure?.code || '', requiresHuman: failure?.requiresHuman || false, recovery: failure?.recovery || '', retryAfter: failure?.cooldownMs ? new Date(Date.now() + failure.cooldownMs).toISOString() : failure?.retryAfter || null, nextActionAt: null });
}

await writeOutputs(true);
if (executionError) throw executionError;

async function writeOutputs(logReport) {
const results = jobs.map((job) => completed.get(job.job_id)).filter(Boolean);
const csvColumns = [
  'row_no', 'job_id', 'job_name', 'source_platform', 'standard_job', 'job_family', 'relevance_grade', 'relevance_reason', 'label_status',
  'seniority', 'source_employment_type', 'employment_type', 'skills', 'tasks', 'risk_signals', 'evidence', 'evidence_json',
  'evidence_coverage', 'confidence', 'label_platform', 'label_version', 'labeled_at',
];
const csv = [csvColumns.map(csvCell).join(','), ...results.map((row) => csvColumns.map((key) => csvCell(row[key])).join(','))].join('\r\n');
await fs.writeFile(csvPath, `\ufeff${csv}`, 'utf8');
const elapsedSeconds = Number(((Date.now() - runStartedAt) / 1000).toFixed(2));
const processedThisRun = Math.max(0, results.length - initialCompletedCount);
const countBy = (key) => Object.fromEntries([...new Set(results.map((row) => valueText(row[key]) || '未明确'))].sort((a, b) => a.localeCompare(b, 'zh-CN')).map((value) => [value, results.filter((row) => (valueText(row[key]) || '未明确') === value).length]));
const allowedEmploymentTypes = new Set(['全职', '实习', '兼职/临时', '校园招聘', '未明确']);
const invalidEmploymentRows = results.filter((row) => !allowedEmploymentTypes.has(valueText(row.employment_type))).length;
const confirmedWithoutEvidence = results.filter((row) => row.label_status === '已确认' && !row.evidence).length;
const forcedLabelsWithoutSignals = results.filter((row) => row.standard_job !== '其他' && !row.skills?.length && !row.tasks?.length && !row.evidence).length;
const report = {
  input_file: inputFile,
  sampling_mode: samplingMode,
  platform: engine,
  runtime: runtimeState,
  job_family: targetFamily,
  run_status: executionError || process.argv.includes('--summarize') && results.length < jobs.length ? 'partial' : results.length === jobs.length ? 'completed' : 'running',
  last_error: executionError ? String(executionError.message || executionError).slice(0, 1200) : '',
  current_job_ids: currentBatchIds,
  requested_rows: jobs.length,
  completed_rows: results.length,
  failed_rows: executionError ? currentBatchIds.filter(id=>!completed.has(id)).length : 0,
  pending_rows: jobs.length - results.length,
  resumed_rows: Math.min(initialCompletedCount, jobs.length),
  processed_this_run: processedThisRun,
  average_confidence: results.length ? Number((results.reduce((sum, row) => sum + Number(row.confidence || 0), 0) / results.length).toFixed(3)) : 0,
  risk_signal_rows: results.filter((row) => row.risk_signals?.length).length,
  schema_success_rate: jobs.length ? Number((results.length / jobs.length).toFixed(3)) : 0,
  skills_coverage_rate: results.length ? Number((results.filter((row) => row.skills?.length).length / results.length).toFixed(3)) : 0,
  tasks_coverage_rate: results.length ? Number((results.filter((row) => row.tasks?.length).length / results.length).toFixed(3)) : 0,
  evidence_coverage_rate: results.length ? Number((results.filter((row) => row.evidence).length / results.length).toFixed(3)) : 0,
  average_evidence_coverage: results.length ? Number((results.reduce((sum, row) => sum + Number(row.evidence_coverage || 0), 0) / results.length).toFixed(3)) : 0,
  full_evidence_coverage_rate: results.length ? Number((results.filter((row) => Number(row.evidence_coverage || 0) >= 1).length / results.length).toFixed(3)) : 0,
  relevance_grade_counts: countBy('relevance_grade'),
  label_status_counts: countBy('label_status'),
  standard_job_counts: countBy('standard_job'),
  employment_type_counts: countBy('employment_type'),
  invalid_employment_type_rows: invalidEmploymentRows,
  confirmed_without_evidence_rows: confirmedWithoutEvidence,
  forced_labels_without_signals: forcedLabelsWithoutSignals,
  distinct_confidence_values: new Set(results.map((row) => Number(row.confidence || 0))).size,
  label_version: 'job-label-v2.1',
  elapsed_seconds: elapsedSeconds,
  rows_per_minute: processedThisRun ? Number((processedThisRun / Math.max(1 / 60, elapsedSeconds / 60)).toFixed(2)) : 0,
  output_jsonl: resultPath,
  output_csv: csvPath,
  updated_at: new Date().toISOString(),
};
const tempReportPath = `${reportPath}.tmp`;
await fs.writeFile(tempReportPath, JSON.stringify(report, null, 2), 'utf8');
await fs.rename(tempReportPath, reportPath);
if (logReport) console.log(JSON.stringify(report));
}
