import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { readJobDataset } from './job_dataset.mjs';
import { approvedLabelsForWorkbook, consensusLabelsForWorkbook, prelabelsForWorkbook } from './reviewed_job_labels.mjs';
import { cityName, summarizeCohort, experienceCohorts } from '../job_collector_ui/public/insight-cohorts.js';
import { businessRules } from '../job_collector_ui/public/business-rules.js';
import { literalRoleFamily, selectManualRole } from './insight-role-selection.mjs';
import { learnJointExpansion, matchJointExpansion, publicJointExpansion } from './joint-job-expansion.mjs';
import { matchKeywordRole } from './keyword-role-matcher.mjs';
import { learnRuleSeedModel, matchRuleSeedRole } from './rule-seed-keywords.mjs';
import { learnUniversalRoleKeywords, matchUniversalRoleKeywords } from './universal-role-keywords.mjs';
import { learnRoleEvidence, matchRoleEvidence } from './role-evidence-v2.mjs';

const configPath = path.resolve(process.argv[2] || '');
const outputPath = path.resolve(process.argv[3] || '');
if (!configPath || !fsSync.existsSync(configPath)) throw new Error('缺少岗位洞察配置文件');
if (!outputPath) throw new Error('缺少岗位洞察输出文件');
const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
const inputFile = path.resolve(String(config.inputFile || ''));
const sampleSize = Math.max(50, Math.min(2000, Number(config.sampleSize || 300)));
const analysisMode = String(config.analysisMode || 'preview') === 'full' ? 'full' : 'preview';
const manualRole = String(config.role || '').trim();

function text(value) { return value == null ? '' : String(value).trim(); }
function countBy(values) {
  const counts = new Map();
  for (const value of values.map(text).filter(Boolean)) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'));
}
function quantile(values, q) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const fraction = position - lower;
  return Number((sorted[lower] + (sorted[lower + 1] == null ? 0 : fraction * (sorted[lower + 1] - sorted[lower]))).toFixed(1));
}
function pattern(parts) { return new RegExp(parts.join('|'), 'i'); }
function selectEvenSample(rows, limit) {
  if (rows.length <= limit) return rows;
  const indexes = new Set();
  for (let index = 0; index < limit; index += 1) indexes.add(Math.floor(index * (rows.length - 1) / (limit - 1)));
  return [...indexes].map((index) => rows[index]);
}

function normalizeSalary(rawValue) {
  const raw = text(rawValue).replace(/,/g, '').replace(/\s+/g, '');
  if (!raw || /面议|薪资面议|保密/.test(raw)) return null;
  const range = raw.match(/(\d+(?:\.\d+)?)\s*[-~至到]\s*(\d+(?:\.\d+)?)/);
  const first = raw.match(/\d+(?:\.\d+)?/);
  if (!first) return null;
  let min = Number(range?.[1] || first[0]);
  let max = Number(range?.[2] || range?.[1] || first[0]);
  if (/万/.test(raw)) { min *= 10000; max *= 10000; }
  else if (/k/i.test(raw)) { min *= 1000; max *= 1000; }
  if (/年|\/年/.test(raw)) { min /= 12; max /= 12; }
  else if (/天|\/日|\/天/.test(raw)) { min *= 21.75; max *= 21.75; }
  else if (/小时|\/时/.test(raw)) { min *= 174; max *= 174; }
  if (min < 1000 || max > 300000 || min > max * 2) return null;
  return { min, max, midpoint: (min + max) / 2, raw };
}

const roleFamilies = [
  { name: 'AI漫剧创作', strict: true, filename: pattern(['AI\\s*漫\\s*剧', '^漫剧师$', '^漫剧制作师$']), query: pattern(['AI\\s*漫\\s*剧', '^漫剧师$', '^漫剧制作师$']), title: pattern(['漫\\s*剧']), content: pattern(['漫\\s*剧']) },
  { name: '智能体/大模型应用', filename: pattern(['智能体', 'Agent', '大模型应用']), query: pattern(['智能体', 'Agent', '大模型应用']), title: pattern(['智能体', 'AI.?Agent', 'Agent开发', '大模型应用', 'AI应用']), content: pattern(['LangChain', '\\bRAG\\b', '大模型', '\\bLLM\\b', 'Prompt', 'Dify', '向量数据库', 'Function.?Calling']) },
  { name: '大模型算法', filename: pattern(['大模型算法', '大模型研发']), query: pattern(['大模型算法', '大模型研发']), title: pattern(['大模型.*算法', '大模型.*研发', 'LLM.*算法']), content: pattern(['大模型训练', '模型微调', '\\bSFT\\b', '\\bLoRA\\b', 'Transformers', '预训练模型', '大模型评测']) },
  { name: '机器学习/算法', filename: pattern(['机器学习', '算法工程']), query: pattern(['机器学习', '算法工程', '深度学习']), title: pattern(['机器学习工程师', '算法工程师', '深度学习工程师', 'NLP工程师', '计算机视觉工程师']), content: pattern(['机器学习', '深度学习', '特征工程', 'Scikit', 'XGBoost', 'LightGBM', '分类算法', '回归算法', '计算机视觉', '\\bNLP\\b']) },
  { name: '大数据开发', filename: pattern(['大数据开发', '数据开发工程师']), query: pattern(['大数据开发', '数据开发', 'Hadoop开发', 'Spark开发']), title: pattern(['大数据.*(开发|工程)', '数据开发工程师', 'Hadoop.*工程师', 'Spark.*工程师']), content: pattern(['Hadoop', 'Spark', 'Flink', 'Hive', 'HBase', 'DataX', '数据仓库', '数仓', '离线计算', '实时计算']) },
  { name: '爬虫/数据采集', filename: pattern(['爬虫', '数据采集', '数据抓取']), query: pattern(['爬虫', '数据采集', '数据抓取']), title: pattern(['爬虫', '数据采集', '数据抓取', '采集工程师']), content: pattern(['Scrapy', 'BeautifulSoup', '反爬', 'JS逆向', '数据抓取', '网页采集', '代理池', 'Selenium', 'Playwright', 'XPath', 'aiohttp', 'requests库', '网页解析', '协议逆向', '浏览器自动化']) },
  { name: '全栈开发', filename: pattern(['全栈', '前后端']), query: pattern(['全栈', '前后端']), title: pattern(['全栈', '前后端']), content: pattern(['全栈', '前后端', 'React.{0,30}Spring', 'Vue.{0,30}Spring', 'Node\\.js.{0,30}(React|Vue)']) },
  { name: '前端开发', filename: pattern(['前端']), query: pattern(['前端']), title: pattern(['前端', 'Web开发', 'H5开发']), content: pattern(['Vue', 'React', 'Angular', 'TypeScript', 'Webpack', 'Vite', 'HTML5', 'CSS3']) },
  { name: '后端开发', filename: pattern(['后端', 'Java开发']), query: pattern(['后端', 'Java开发', '服务端']), title: pattern(['后端', '服务端', 'Java开发', 'Python开发', 'Go开发', 'PHP开发']), content: pattern(['Spring.?Boot', 'Spring.?Cloud', 'MyBatis', '微服务', 'Django', 'FastAPI', 'Gin框架', '分布式系统']) },
  { name: '网络安全', filename: pattern(['网络安全', '安全工程']), query: pattern(['网络安全', '安全工程']), title: pattern(['安全工程师', '网络安全', '渗透测试', '安全运营']), content: pattern(['渗透测试', '漏洞扫描', '安全攻防', '\\bWAF\\b', '\\bSIEM\\b', '应急响应', '等保']) },
  { name: '数据安全', filename: pattern(['数据安全']), query: pattern(['数据安全']), title: pattern(['数据安全', '安全治理']), content: pattern(['数据脱敏', '数据加密', '隐私计算', '数据合规', 'DLP', '访问控制']) },
  { name: '网络运维', filename: pattern(['网络运维', '网络工程']), query: pattern(['网络运维', '网络工程']), title: pattern(['网络运维', '网络工程师', '网络管理员']), content: pattern(['TCP/IP', '交换机', '路由器', 'VLAN', 'OSPF', 'BGP', 'Cisco', '华为网络', '网络故障']) },
  { name: 'Linux系统开发', filename: pattern(['Linux系统', '系统开发', '内核开发']), query: pattern(['Linux系统开发', 'Linux开发', '内核开发', '驱动开发']), title: pattern(['Linux.*开发', '系统软件工程师', '内核工程师', '驱动开发工程师']), content: pattern(['Linux内核', '内核开发', '系统调用', 'POSIX', '设备驱动', '驱动开发', '进程调度', '内存管理', '网络协议栈']) },
  { name: '嵌入式开发', filename: pattern(['嵌入式']), query: pattern(['嵌入式']), title: pattern(['嵌入式', '单片机', '驱动开发']), content: pattern(['STM32', 'FreeRTOS', '\\bRTOS\\b', '\\bMCU\\b', 'Linux驱动', 'ARM', '串口']) },
  { name: '测试工程', filename: pattern(['测试工程']), query: pattern(['测试工程', '软件测试']), title: pattern(['测试工程师', '软件测试', '测试开发']), content: pattern(['自动化测试', '性能测试', '接口测试', 'JMeter', 'Postman', 'PyTest', 'JUnit']) },
  { name: '运维/云平台', filename: pattern(['运维', '云平台']), query: pattern(['运维', '云平台']), title: pattern(['运维工程师', 'SRE', 'DevOps', '云平台工程师']), content: pattern(['Ansible', 'Terraform', 'Jenkins', 'Prometheus', 'Grafana', 'Kubernetes', 'CI/CD']) },
  { name: '数据运营', filename: pattern(['数据运营']), query: pattern(['数据运营']), title: pattern(['数据运营', '运营分析']), content: pattern(['用户运营', '数据分析', '指标体系', '用户增长', '活动运营', '转化率']) },
  { name: '人力资源', filename: pattern(['人力资源', 'HR岗位']), query: pattern(['人力资源', 'HRBP', '招聘专员', '薪酬绩效']), title: pattern(['人力资源', 'HRBP', '招聘专员', '招聘经理', '薪酬绩效', '员工关系']), content: pattern(['人才招聘', '招聘渠道', '薪酬绩效', '员工关系', '劳动法', '人才盘点', '组织发展', '\\bATS\\b', '人力资源管理']) },
  { name: '通用软件开发', filename: pattern(['通用软件开发', '软件工程师岗位']), query: pattern(['^软件开发$', '^开发工程师$']), title: pattern(['软件开发', '开发工程师', '研发工程师', '程序员']), content: pattern(['编程', '软件工程', '系统开发', '接口开发']) },
];

const skillRules = [
  ['Midjourney', pattern(['Midjourney', '\\bMJ\\b'])], ['Stable Diffusion', pattern(['Stable\\s*Diffusion', '\\bSDXL\\b'])], ['ComfyUI', pattern(['ComfyUI'])], ['分镜设计', pattern(['分镜'])], ['视频剪辑', pattern(['视频剪辑', '剪映', 'Premiere', 'After Effects'])],
  ['Python', pattern(['\\bPython\\b'])], ['Java', pattern(['\\bJava\\b(?!Script)'])], ['Go', pattern(['\\bGolang\\b', '\\bGo语言'])], ['C/C++', pattern(['C\\+\\+', '\\bC语言', 'C/C\\+\\+'])], ['C#', pattern(['C#', '\\.NET'])], ['PHP', pattern(['\\bPHP\\b'])],
  ['JavaScript', pattern(['JavaScript', '\\bJS\\b'])], ['TypeScript', pattern(['TypeScript', '\\bTS\\b'])], ['HTML/CSS', pattern(['HTML5?', 'CSS3?'])], ['Vue', pattern(['Vue(?:\\.js)?'])], ['React', pattern(['React(?:\\.js)?'])], ['Angular', pattern(['Angular'])], ['Node.js', pattern(['Node\\.js', 'NodeJS'])], ['Webpack', pattern(['Webpack'])], ['Vite', pattern(['\\bVite\\b'])],
  ['SQL', pattern(['\\bSQL\\b'])], ['MySQL', pattern(['MySQL'])], ['PostgreSQL', pattern(['PostgreSQL', 'Postgres'])], ['Oracle', pattern(['Oracle'])], ['Redis', pattern(['Redis'])], ['MongoDB', pattern(['MongoDB'])], ['Elasticsearch', pattern(['Elasticsearch', '\\bElasticSearch\\b'])], ['ClickHouse', pattern(['ClickHouse'])], ['Doris', pattern(['Apache Doris', '\\bDoris\\b'])],
  ['Spring Boot', pattern(['Spring.?Boot'])], ['Spring Cloud', pattern(['Spring.?Cloud'])], ['MyBatis', pattern(['MyBatis'])], ['Django', pattern(['Django'])], ['Flask', pattern(['\\bFlask\\b'])], ['FastAPI', pattern(['FastAPI'])], ['微服务', pattern(['微服务', 'Microservices?'])], ['REST API', pattern(['RESTful', 'REST API'])],
  ['Hadoop', pattern(['Hadoop'])], ['Spark', pattern(['Apache Spark', '\\bSpark\\b'])], ['Flink', pattern(['Flink'])], ['Hive', pattern(['Apache Hive', '\\bHive\\b'])], ['HBase', pattern(['HBase'])], ['Kafka', pattern(['Kafka'])], ['DataX', pattern(['DataX'])], ['Airflow', pattern(['Airflow'])], ['MaxCompute', pattern(['MaxCompute'])], ['Trino/Presto', pattern(['Trino', 'Presto'])],
  ['Scrapy', pattern(['Scrapy'])], ['Selenium', pattern(['Selenium'])], ['Playwright', pattern(['Playwright'])], ['BeautifulSoup', pattern(['BeautifulSoup', 'Beautiful Soup'])], ['Requests', pattern(['Python.{0,8}Requests', '\\brequests库'])], ['Appium', pattern(['Appium'])], ['JS逆向', pattern(['JS逆向', 'JavaScript逆向'])], ['反爬虫', pattern(['反爬', '反爬虫'])],
  ['LLM', pattern(['大语言模型', '大模型', '\\bLLM'])], ['RAG', pattern(['\\bRAG\\b', '检索增强生成'])], ['LangChain', pattern(['LangChain'])], ['LlamaIndex', pattern(['LlamaIndex'])], ['Dify', pattern(['\\bDify\\b'])], ['MCP', pattern(['\\bMCP\\b', 'Model Context Protocol'])], ['Prompt Engineering', pattern(['Prompt', '提示词工程', '提示工程'])], ['Embedding', pattern(['Embedding', '向量化', '文本嵌入'])], ['PyTorch', pattern(['PyTorch'])], ['TensorFlow', pattern(['TensorFlow'])], ['Transformers', pattern(['Transformers', 'Hugging.?Face'])], ['模型微调', pattern(['模型微调', '指令微调', 'Fine.?tuning', '\\bSFT\\b', '\\bLoRA\\b'])],
  ['Linux', pattern(['\\bLinux\\b'])], ['Git', pattern(['\\bGit\\b'])], ['Docker', pattern(['Docker'])], ['Kubernetes', pattern(['Kubernetes', '\\bK8s\\b'])], ['Nginx', pattern(['Nginx'])], ['Jenkins', pattern(['Jenkins'])], ['Ansible', pattern(['Ansible'])], ['Terraform', pattern(['Terraform'])], ['Prometheus', pattern(['Prometheus'])], ['Grafana', pattern(['Grafana'])], ['CI/CD', pattern(['CI/CD', '持续集成', '持续交付'])],
  ['TCP/IP', pattern(['TCP/IP'])], ['VLAN', pattern(['\\bVLAN\\b'])], ['BGP/OSPF', pattern(['\\bBGP\\b', '\\bOSPF\\b'])], ['Linux内核', pattern(['Linux内核', '内核开发'])], ['POSIX', pattern(['\\bPOSIX\\b'])], ['设备驱动', pattern(['设备驱动', '驱动开发'])],
  ['Scikit-learn', pattern(['Scikit.?learn', 'sklearn'])], ['XGBoost', pattern(['XGBoost'])], ['LightGBM', pattern(['LightGBM'])], ['特征工程', pattern(['特征工程'])],
  ['Excel', pattern(['\\bExcel\\b'])], ['ATS', pattern(['\\bATS\\b', '招聘系统'])], ['招聘管理', pattern(['人才招聘', '招聘管理', '招聘渠道'])], ['薪酬绩效', pattern(['薪酬绩效', '绩效管理'])], ['员工关系', pattern(['员工关系'])], ['劳动法', pattern(['劳动法', '劳动合同法'])],
  ['STM32', pattern(['STM32'])], ['RTOS', pattern(['FreeRTOS', '\\bRTOS\\b'])], ['ARM', pattern(['\\bARM\\b'])], ['JMeter', pattern(['JMeter'])], ['Postman', pattern(['Postman'])], ['PyTest', pattern(['PyTest'])], ['JUnit', pattern(['JUnit'])],
];

const familyCoreSkills = {
  'AI漫剧创作': ['Midjourney', 'Stable Diffusion', 'ComfyUI', '分镜设计', '视频剪辑', 'Prompt Engineering'],
  '智能体/大模型应用': ['Python', 'LLM', 'RAG', 'LangChain', 'LlamaIndex', 'Dify', 'MCP', 'Prompt Engineering', 'Embedding', 'FastAPI'],
  '大模型算法': ['Python', 'LLM', 'PyTorch', 'TensorFlow', 'Transformers', '模型微调', 'Embedding'],
  '机器学习/算法': ['Python', 'PyTorch', 'TensorFlow', 'Scikit-learn', 'XGBoost', 'LightGBM', '特征工程'],
  '大数据开发': ['Java', 'Python', 'SQL', 'Hadoop', 'Spark', 'Flink', 'Hive', 'HBase', 'Kafka', 'DataX', 'Airflow', 'MaxCompute', 'Trino/Presto', 'ClickHouse', 'Doris'],
  '爬虫/数据采集': ['Python', 'Scrapy', 'Selenium', 'Playwright', 'BeautifulSoup', 'Requests', 'JS逆向', '反爬虫'],
  '全栈开发': ['JavaScript', 'TypeScript', 'HTML/CSS', 'Vue', 'React', 'Angular', 'Node.js', 'Java', 'Python', 'Spring Boot', 'Django', 'FastAPI', 'REST API'],
  '前端开发': ['JavaScript', 'TypeScript', 'HTML/CSS', 'Vue', 'React', 'Angular', 'Node.js', 'Webpack', 'Vite'],
  '后端开发': ['Java', 'Go', 'Python', 'PHP', 'C#', 'Spring Boot', 'Spring Cloud', 'MyBatis', 'Django', 'Flask', 'FastAPI', '微服务', 'REST API', 'SQL'],
  '网络运维': ['Linux', 'TCP/IP', 'VLAN', 'BGP/OSPF', 'Ansible', 'Prometheus', 'Grafana'],
  'Linux系统开发': ['C/C++', 'Linux', 'Linux内核', 'POSIX', '设备驱动', 'TCP/IP'],
  '嵌入式开发': ['C/C++', 'Linux', 'Linux内核', '设备驱动', 'STM32', 'RTOS', 'ARM'],
  '测试工程': ['Python', 'Java', 'Selenium', 'Playwright', 'Appium', 'JMeter', 'Postman', 'PyTest', 'JUnit'],
  '运维/云平台': ['Linux', 'Docker', 'Kubernetes', 'Nginx', 'Jenkins', 'Ansible', 'Terraform', 'Prometheus', 'Grafana', 'CI/CD'],
  '人力资源': ['Excel', 'ATS', '招聘管理', '薪酬绩效', '员工关系', '劳动法'],
};
const broadlyAdjacentSkills = new Set(['SQL', 'MySQL', 'PostgreSQL', 'Oracle', 'Redis', 'MongoDB', 'Elasticsearch', 'Linux', 'Git', 'Docker', 'Kubernetes', 'Nginx', 'CI/CD', 'Kafka']);

function skillTier(familyName, skillName) {
  if ((familyCoreSkills[familyName] || []).includes(skillName)) return '核心技能';
  if (broadlyAdjacentSkills.has(skillName)) return '工程支撑';
  return '跨栈扩展';
}

const generalTaskRules = [
  ['系统设计与功能开发', pattern(['系统设计', '功能开发', '模块开发', '架构设计', '软件开发'])], ['接口与系统集成', pattern(['接口开发', 'API开发', '系统集成', '第三方接入', '服务对接'])], ['数据处理与质量治理', pattern(['数据清洗', '数据处理', '数据治理', '数据质量', 'ETL'])], ['性能与稳定性优化', pattern(['性能优化', '高并发', '稳定性', '故障排查', '容量规划'])], ['部署运维与工程化', pattern(['部署', '运维', 'CI/CD', '容器化', '监控告警'])], ['测试与质量保障', pattern(['单元测试', '自动化测试', '测试用例', '质量保障', '代码审查'])], ['需求分析与跨团队协作', pattern(['需求分析', '产品需求', '跨团队', '协作沟通', '项目推进'])],
];
const familyTaskRules = {
  'AI漫剧创作': [['剧本与分镜创作', pattern(['剧本', '分镜', '编剧'])], ['AI图像与视频制作', pattern(['AI.{0,12}(绘图|图像|视频|制作)', '文生图', '图生视频', 'Midjourney', 'Stable\\s*Diffusion', 'ComfyUI'])], ['剪辑与后期制作', pattern(['剪辑', '后期', '配音', '字幕'])]],
  '智能体/大模型应用': [['智能体编排与工作流', pattern(['智能体.{0,12}(编排|工作流|流程)', 'Agent.{0,12}(workflow|orchestration)', '工作流.{0,12}(搭建|开发|设计)'])], ['RAG知识库建设', pattern(['RAG', '知识库', '检索增强', '向量检索'])], ['Prompt与效果优化', pattern(['Prompt', '提示词', '模型评测', '幻觉', '效果优化'])], ['模型接入与推理服务', pattern(['模型接入', '推理服务', '模型部署', 'Function.?Calling', '工具调用', 'MCP'])]],
  '大模型算法': [['模型训练与微调', pattern(['模型训练', '模型微调', 'SFT', 'LoRA', '预训练'])], ['算法研究与实验', pattern(['算法研究', '论文复现', '实验设计', '模型优化'])], ['评测与推理优化', pattern(['模型评测', '推理优化', '量化', '蒸馏'])]],
  '大数据开发': [['离线数仓与ETL', pattern(['离线', '数仓', '数据仓库', 'ETL', 'Hive'])], ['实时计算与流处理', pattern(['实时计算', '流处理', 'Flink', 'Kafka'])], ['数据平台建设', pattern(['数据平台', '大数据平台', '数据中台', '任务调度'])], ['数据治理与质量', pattern(['数据治理', '元数据', '数据质量', '血缘'])]],
  '后端开发': [['业务服务开发', pattern(['业务开发', '后端开发', '服务端', '接口开发'])], ['微服务与分布式系统', pattern(['微服务', '分布式', '服务治理', 'Spring Cloud'])], ['数据库与缓存设计', pattern(['数据库设计', 'SQL优化', '缓存', 'Redis'])]],
  '全栈开发': [['前端界面与交互', pattern(['前端开发', '页面开发', '交互', 'Vue', 'React'])], ['后端服务与接口', pattern(['后端开发', '服务端', '接口开发', 'API'])], ['端到端交付', pattern(['全栈', '前后端', '独立开发', '项目交付'])]],
  '前端开发': [['页面与组件开发', pattern(['页面开发', '组件开发', '前端开发'])], ['交互与性能优化', pattern(['交互', '前端性能', '首屏', '兼容性'])], ['前端工程化', pattern(['工程化', 'Webpack', 'Vite', '组件库'])]],
  '爬虫/数据采集': [['采集策略与爬虫开发', pattern(['爬虫开发', '采集策略', '数据抓取', '网页采集'])], ['反爬分析与逆向', pattern(['反爬', '逆向', '加密参数', '验证码'])], ['数据清洗与入库', pattern(['数据清洗', '数据入库', '去重', '结构化'])], ['采集稳定性与调度', pattern(['任务调度', '代理池', '稳定性', '监控'])]],
  '网络安全': [['安全监测与应急响应', pattern(['安全监测', '应急响应', '告警分析'])], ['漏洞评估与攻防', pattern(['漏洞', '渗透测试', '攻防'])], ['安全合规与治理', pattern(['等保', '合规', '安全治理'])]],
  '数据安全': [['数据安全治理', pattern(['数据安全治理', '数据分类分级', '数据合规'])], ['访问控制与数据防护', pattern(['访问控制', '数据脱敏', '数据加密', 'DLP'])]],
  '嵌入式开发': [['固件与驱动开发', pattern(['固件', '驱动开发', '底层开发'])], ['硬件调试与系统联调', pattern(['硬件调试', '系统联调', '板级'])], ['实时系统开发', pattern(['RTOS', '实时系统', '任务调度'])]],
  '测试工程': [['自动化测试开发', pattern(['自动化测试', '测试开发', '测试框架'])], ['性能与接口测试', pattern(['性能测试', '接口测试', '压力测试'])], ['缺陷管理与质量分析', pattern(['缺陷', '质量分析', '测试报告'])]],
  '运维/云平台': [['基础设施自动化', pattern(['自动化运维', '基础设施', 'Ansible', 'Terraform'])], ['监控与故障处理', pattern(['监控', '告警', '故障处理', '应急'])], ['容器与云平台', pattern(['容器', 'Kubernetes', '云平台'])]],
  '网络运维': [['网络规划与配置', pattern(['网络规划', '交换机', '路由器', 'VLAN', '网络配置'])], ['网络监控与故障处理', pattern(['网络监控', '网络故障', '链路', '告警'])], ['网络安全与访问控制', pattern(['防火墙', '访问控制', '网络安全'])]],
  'Linux系统开发': [['内核与驱动开发', pattern(['Linux内核', '内核开发', '驱动开发', '设备驱动'])], ['系统性能与资源管理', pattern(['性能分析', '进程调度', '内存管理', '系统调用'])], ['底层网络与系统编程', pattern(['网络协议栈', '系统编程', 'POSIX', 'Socket'])]],
  '机器学习/算法': [['特征工程与模型训练', pattern(['特征工程', '模型训练', '机器学习'])], ['算法实验与效果评估', pattern(['算法实验', '模型评估', '准确率', '召回率'])], ['模型部署与工程化', pattern(['模型部署', '推理服务', '算法工程化'])]],
  '数据运营': [['指标体系与经营分析', pattern(['指标体系', '经营分析', '数据分析'])], ['用户增长与转化', pattern(['用户增长', '转化率', '留存', '用户运营'])], ['活动与策略运营', pattern(['活动运营', '运营策略', '策略优化'])]],
  '人力资源': [['招聘与人才获取', pattern(['招聘', '人才获取', '招聘渠道', '面试'])], ['薪酬绩效管理', pattern(['薪酬', '绩效', '激励'])], ['员工关系与合规', pattern(['员工关系', '劳动法', '劳动合同'])], ['组织发展与人才盘点', pattern(['组织发展', '人才盘点', '培训发展'])]],
};

const domainRules = businessRules;

const cityCoordinates = {
  '北京': [116.4074, 39.9042], '上海': [121.4737, 31.2304], '广州': [113.2644, 23.1291], '深圳': [114.0579, 22.5431], '杭州': [120.1551, 30.2741], '成都': [104.0665, 30.5723], '武汉': [114.3054, 30.5931], '南京': [118.7969, 32.0603], '苏州': [120.5853, 31.2989], '西安': [108.9398, 34.3416], '天津': [117.2008, 39.0842], '重庆': [106.5516, 29.5630], '长沙': [112.9388, 28.2282], '合肥': [117.2272, 31.8206], '郑州': [113.6254, 34.7466], '济南': [117.1201, 36.6512], '青岛': [120.3826, 36.0671], '厦门': [118.0894, 24.4798], '福州': [119.2965, 26.0745], '无锡': [120.3119, 31.4912], '宁波': [121.5503, 29.8746], '东莞': [113.7518, 23.0207], '佛山': [113.1214, 23.0215], '珠海': [113.5767, 22.2707], '昆明': [102.8329, 24.8801], '沈阳': [123.4315, 41.8057], '大连': [121.6147, 38.9140],
};

async function readRows() {
  if (!fsSync.existsSync(inputFile)) throw new Error(`找不到输入文件：${inputFile}`);
  return readJobDataset(inputFile, config.sheetName);
}

function roleScore(row, family) {
  const title = text(row['岗位名称']);
  const query = text(row['查询关键词']);
  const skills = text(row['技能']);
  const description = text(row['岗位描述']);
  let score = 0;
  const evidence = [];
  if (family.title.test(title)) { score += 5; evidence.push('岗位名称'); }
  if (family.query.test(query)) { score += 2; evidence.push('查询关键词'); }
  if (family.content.test(skills)) { score += 3; evidence.push('技能字段'); }
  if (family.content.test(description)) { score += 2; evidence.push('岗位描述'); }
  return { score, evidence };
}

function classifyRow(row) {
  const scored = roleFamilies.map((family) => ({ name: family.name, ...roleScore(row, family) })).sort((a, b) => b.score - a.score);
  return { family: scored[0].score ? scored[0].name : '其他/待复核', score: scored[0].score, evidence: scored[0].evidence, alternatives: scored.slice(1, 3) };
}

function matchesTargetRole(row, family) {
  const title = text(row['岗位名称']);
  const skills = text(row['技能']);
  const description = text(row['岗位描述']);
  const reasons = [];
  if (family.title.test(title)) reasons.push('岗位关键词');
  if (family.content.test(skills)) reasons.push('技能字段');
  if (family.content.test(description)) reasons.push('岗位描述技术词');
  return { matched: reasons.length > 0, reasons };
}

function isHighConfidenceSeed(row, family) {
  return family.title.test(text(row['岗位名称'])) || family.content.test(text(row['技能']));
}

const topicStopWords = new Set(['岗位', '工作', '负责', '相关', '要求', '熟悉', '掌握', '经验', '能力', '公司', '优先', '以上', '以及', '进行', '具有', '提供', '根据', '具备', '参与', '完成', '包括', '能够', '技术', '开发', '工程师', '系统', '业务', '项目', '职位', '我们', '团队', '产品', '平台', '客户', '使用', '人员', '专业', '学历', '本科', '大专', '数据', '软件', '服务', '负责', '职责', '任职', '职位描述', '任职要求', '岗位职责', '分析', '工具', '处理', '任务', '稳定', '结构', '定位', '精通', '自动', '网络', '协议', '应对', '网站', '清洗', '策略', '时间', '识别', '报告', '加分', '分布', '目标', '机制', '高效', 'years', 'year']);
const topicSegmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
const topicTokenCache = new WeakMap();
const topicSignalTokenCache = new WeakMap();
const topicAnchorPatterns = {
  '爬虫/数据采集': pattern(['爬虫', '采集', '抓取', '网页', '反爬', '逆向', 'scrapy', 'selenium', 'playwright', 'beautifulsoup', 'requests', 'xpath', 'aiohttp', '代理池']),
  '智能体/大模型应用': pattern(['智能体', 'agent', '大模型', 'llm', 'rag', 'langchain', 'dify', 'prompt', '知识库', '向量']),
  '大模型算法': pattern(['大模型', 'llm', '微调', '预训练', 'transformer', 'lora', 'sft', '推理']),
  '机器学习/算法': pattern(['机器学习', '深度学习', '算法', '特征', '模型', 'xgboost', 'lightgbm', 'scikit', '视觉', 'nlp']),
  '大数据开发': pattern(['大数据', '数仓', '仓库', '实时', '离线', 'hadoop', 'spark', 'flink', 'hive', 'hbase', 'kafka', 'datax']),
  '后端开发': pattern(['后端', '服务端', '接口开发', '微服务', 'spring', 'mybatis', 'django', 'fastapi', '分布式', '缓存']),
  '全栈开发': pattern(['全栈', '前后端', 'vue', 'react', 'node', 'spring']),
  '前端开发': pattern(['前端', '页面', '组件', 'vue', 'react', 'angular', 'typescript', 'webpack', 'vite']),
  '网络安全': pattern(['安全', '渗透', '漏洞', '攻防', '应急', 'waf', 'siem', '等保']),
  '数据安全': pattern(['数据安全', '脱敏', '加密', '隐私', '合规', 'dlp', '访问控制']),
  '网络运维': pattern(['网络运维', '交换机', '路由器', 'vlan', 'ospf', 'bgp', 'cisco', '链路']),
  'Linux系统开发': pattern(['linux', '内核', '驱动', 'posix', '系统调用', '进程', '内存', '协议栈']),
  '嵌入式开发': pattern(['嵌入式', 'stm32', 'mcu', 'rtos', 'arm', '固件', '驱动']),
  '测试工程': pattern(['测试', 'jmeter', 'postman', 'pytest', 'junit', '质量']),
  '运维/云平台': pattern(['运维', 'sre', 'devops', 'kubernetes', 'docker', 'ansible', 'terraform', 'prometheus', 'grafana']),
  '数据运营': pattern(['数据运营', '指标', '增长', '转化', '留存', '用户运营', '活动运营']),
  '人力资源': pattern(['人力', '招聘', 'hrbp', '薪酬', '绩效', '员工关系', '劳动法', '人才', '组织发展', 'ats']),
};

function normalizeTopicToken(value) {
  const token = text(value).toLowerCase().replace(/^[^a-z0-9\u4e00-\u9fff+#./-]+|[^a-z0-9\u4e00-\u9fff+#./-]+$/g, '');
  if (!token || token.length < 2 || token.length > 30 || topicStopWords.has(token) || /^\d+(?:\.\d+)?$/.test(token)) return '';
  if (/^(负责|要求|相关|熟悉|掌握|参与|完成|能够|具有|进行)/.test(token)) return '';
  return token;
}

function topicTokens(row, highSignalOnly = false) {
  const cache = highSignalOnly ? topicSignalTokenCache : topicTokenCache;
  if (cache.has(row)) return cache.get(row);
  const source = (highSignalOnly ? [row['岗位名称'], row['技能']] : [row['岗位名称'], row['技能'], text(row['岗位描述']).slice(0, 2200)]).map(text).join('。');
  const ordered = [];
  for (const part of topicSegmenter.segment(source)) {
    if (part.isWordLike === false) continue;
    const token = normalizeTopicToken(part.segment);
    if (token) ordered.push(token);
  }
  const tokens = new Set(ordered);
  for (let index = 0; index + 1 < ordered.length; index += 1) {
    const first = ordered[index];
    const second = ordered[index + 1];
    if (/^[\u4e00-\u9fff]{2,8}$/.test(first) && /^[\u4e00-\u9fff]{2,8}$/.test(second)) {
      const phrase = `${first}${second}`;
      if (phrase.length <= 12) tokens.add(phrase);
    }
  }
  cache.set(row, tokens);
  return tokens;
}

function learnTopicKeywords(rows, family) {
  const seedRows = rows.filter((row) => isHighConfidenceSeed(row, family));
  if (seedRows.length < 5) return { seed_rows: seedRows.length, terms: [], strong_terms: [], supporting_terms: [] };
  const globalCounts = new Map();
  const seedCounts = new Map();
  for (const row of rows) for (const token of topicTokens(row, true)) globalCounts.set(token, (globalCounts.get(token) || 0) + 1);
  for (const row of seedRows) for (const token of topicTokens(row, true)) seedCounts.set(token, (seedCounts.get(token) || 0) + 1);
  const minimumSeedCount = Math.max(3, Math.ceil(seedRows.length * 0.015));
  const anchorPattern = topicAnchorPatterns[family.name] || family.content;
  const terms = [];
  for (const [name, seedCount] of seedCounts) {
    const totalCount = globalCounts.get(name) || seedCount;
    if (seedCount < minimumSeedCount) continue;
    const seedRate = seedCount / seedRows.length;
    const globalRate = totalCount / rows.length;
    const lift = seedRate / Math.max(globalRate, 1 / rows.length);
    const idf = Math.log((rows.length + 1) / (totalCount + 1)) + 1;
    if (!anchorPattern.test(name) || seedRate < 0.025 || lift < 1.8 || globalRate > 0.35) continue;
    const strength = lift >= 2.2 && globalRate <= 0.28 && seedRate >= 0.035 ? 'strong' : 'supporting';
    terms.push({ name, strength, seed_count: seedCount, total_count: totalCount, seed_rate: Number(seedRate.toFixed(3)), global_rate: Number(globalRate.toFixed(3)), lift: Number(lift.toFixed(2)), score: Number((seedRate * idf * Math.log1p(lift)).toFixed(4)) });
  }
  terms.sort((a, b) => b.score - a.score || b.lift - a.lift || b.seed_count - a.seed_count);
  const selected = [...terms.filter((item) => item.strength === 'strong').slice(0, 24), ...terms.filter((item) => item.strength === 'supporting').slice(0, 24)].sort((a, b) => b.score - a.score).slice(0, 36);
  return { seed_rows: seedRows.length, terms: selected, strong_terms: selected.filter((item) => item.strength === 'strong').map((item) => item.name), supporting_terms: selected.filter((item) => item.strength === 'supporting').map((item) => item.name) };
}

function matchesExpandedRole(row, family, topicModel, jointModel) {
  const direct = matchesTargetRole(row, family);
  if (direct.matched) return { matched: true, method: '核心词直接命中', confidence_band: direct.reasons.some((item) => item === '岗位关键词' || item === '技能字段') ? '高' : '中', reasons: direct.reasons, topic_matches: [] };
  const joint = matchJointExpansion(row, jointModel);
  if (joint) return joint;
  if (family.custom || family.strict) return { matched: false, method: '指定岗位关键词未匹配', confidence_band: '排除', reasons: [], topic_matches: [] };
  const signalTokens = topicTokens(row, true);
  const allTokens = topicTokens(row);
  const strongSignal = topicModel.strong_terms.filter((term) => signalTokens.has(term));
  const strongAll = topicModel.strong_terms.filter((term) => allTokens.has(term));
  const supportingSignal = topicModel.supporting_terms.filter((term) => signalTokens.has(term));
  const supportingAll = topicModel.supporting_terms.filter((term) => allTokens.has(term));
  if (strongSignal.length) return { matched: true, method: '高区分度主题词命中', confidence_band: '中', reasons: ['标题/技能主题词'], topic_matches: strongSignal.slice(0, 5) };
  if (strongAll.length >= 2) return { matched: true, method: '多个主题词联合命中', confidence_band: '待复核', reasons: ['岗位描述主题词组合'], topic_matches: strongAll.slice(0, 5) };
  if (supportingSignal.length >= 2 || supportingAll.length >= 3) return { matched: true, method: '多个主题词联合命中', confidence_band: '待复核', reasons: ['动态主题词组合'], topic_matches: (supportingSignal.length >= 2 ? supportingSignal : supportingAll).slice(0, 5) };
  return { matched: false, method: '未匹配', confidence_band: '排除', reasons: [], topic_matches: [...strongSignal, ...strongAll, ...supportingSignal, ...supportingAll].slice(0, 5) };
}

function inferDatasetRole(rows) {
  const inferenceRows = selectEvenSample(rows, Math.min(1000, rows.length));
  const votes = roleFamilies.map((family) => {
    const fileBonus = family.filename.test(path.basename(inputFile)) ? 500 : 0;
    const rowScores = inferenceRows.map((row) => roleScore(row, family).score);
    return { name: family.name, score: fileBonus + rowScores.reduce((sum, value) => sum + value, 0), matching_rows: rowScores.filter((value) => value >= 4).length, query_rows: inferenceRows.filter((row) => family.query.test(text(row['查询关键词']))).length, file_match: Boolean(fileBonus) };
  }).sort((a, b) => b.score - a.score);
  const filenameMatches = votes.filter((item) => item.file_match && item.name !== '通用软件开发');
  let selected = filenameMatches[0] || votes[0];
  let mode = 'auto';
  const manualFamily = selectManualRole(roleFamilies, manualRole);
  if (manualFamily) {
    if (manualFamily.custom) {
      const matchingRows = inferenceRows.filter((row) => matchesTargetRole(row, manualFamily).matched).length;
      return { name: manualFamily.name, confidence: null, mode: 'manual_keyword', manual_label: manualRole, evidence: { file_name_match: false, query_rows: inferenceRows.filter((row) => manualFamily.query.test(text(row['查询关键词']))).length, matching_rows: matchingRows, inspected_rows: inferenceRows.length }, candidates: votes.slice(0, 4) };
    }
    selected = votes.find((item) => item.name === manualFamily.name);
    mode = 'manual_override';
  }
  const second = votes.find((item) => item.name !== selected.name) || { score: 0 };
  const coverage = selected.matching_rows / Math.max(1, inferenceRows.length);
  const queryShare = selected.query_rows / Math.max(1, inferenceRows.length);
  const margin = Math.max(0, (selected.score - second.score) / Math.max(1, selected.score));
  const confidence = Number(Math.min(0.99, (selected.file_match ? 0.65 : 0.4) + queryShare * 0.2 + coverage * 0.1 + margin * 0.1).toFixed(3));
  return { name: selected.name, confidence, mode, manual_label: mode === 'manual_override' ? manualRole : '', evidence: { file_name_match: selected.file_match, query_rows: selected.query_rows, matching_rows: selected.matching_rows, inspected_rows: inferenceRows.length, leading_score: selected.score, second_score: second.score }, candidates: votes.slice(0, 4) };
}

function extractLabels(row, familyName) {
  const fullText = [row['岗位名称'], row['技能'], row['岗位描述']].map(text).join('\n');
  const skills = skillRules.filter(([, regex]) => regex.test(fullText)).map(([name]) => name);
  const taskRules = [...(familyTaskRules[familyName] || []), ...generalTaskRules];
  const tasks = taskRules.filter(([, regex]) => regex.test(fullText)).map(([name]) => name);
  const domains = domainRules.filter(([, regex]) => regex.test(fullText)).map(([name]) => name);
  return { fullText, skills, tasks: [...new Set(tasks)], domains };
}

function salaryBenchmark(items, field, minCount = 5) {
  const groups = new Map();
  for (const item of items) {
    const name = text(item.row[field]) || '未明确';
    if (!groups.has(name)) groups.set(name, []);
    if (item.salary) groups.get(name).push(item.salary.midpoint / 1000);
  }
  return [...groups.entries()].map(([name, salaries]) => ({ name, salary_count: salaries.length, p25: quantile(salaries, 0.25), median: quantile(salaries, 0.5), p75: quantile(salaries, 0.75) })).filter((item) => item.salary_count >= minCount).sort((a, b) => b.salary_count - a.salary_count || (b.median || 0) - (a.median || 0)).slice(0, 12);
}

function topCategoryValues(items, field, limit) {
  return countBy(items.map((item) => text(item.row[field]) || '未明确')).slice(0, limit).map((item) => item.name);
}

function normalizeEmploymentType(value) {
  const raw = text(value);
  if (/实习/.test(raw)) return '实习';
  if (/兼职|临时|小时|日结/.test(raw)) return '兼职/临时';
  if (/全职|社会招聘|校园招聘/.test(raw)) return '全职';
  return '未明确';
}

function salaryModelWeight(item) {
  if (item.target_match.confidence_band === '高') return 1;
  if (item.target_match.confidence_band === '中') return 0.68;
  return 0.35;
}

function buildSalaryFeatureSpec(items) {
  const skillCounts = new Map();
  for (const item of items) for (const skill of item.labels.skills) skillCounts.set(skill, (skillCounts.get(skill) || 0) + 1);
  const minimumSkillCount = Math.max(6, Math.ceil(items.length * 0.03));
  const skills = [...skillCounts.entries()].filter(([, count]) => count >= minimumSkillCount).sort((a, b) => b[1] - a[1]).slice(0, 26).map(([name]) => name);
  const skillSet = new Set(skills);
  const pairCounts = new Map();
  const tripleCounts = new Map();
  for (const item of items) {
    const present = [...new Set(item.labels.skills.filter((skill) => skillSet.has(skill)))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    for (let left = 0; left < present.length; left += 1) for (let right = left + 1; right < present.length; right += 1) {
      const name = [present[left], present[right]].join(' + ');
      pairCounts.set(name, (pairCounts.get(name) || 0) + 1);
      for (let third = right + 1; third < present.length; third += 1) {
        const triple = `${name} + ${present[third]}`;
        tripleCounts.set(triple, (tripleCounts.get(triple) || 0) + 1);
      }
    }
  }
  const minimumPairCount = Math.max(8, Math.ceil(items.length * 0.05));
  const pairs = [...pairCounts.entries()].filter(([, count]) => count >= minimumPairCount).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name]) => name);
  const minimumTripleCount = Math.max(10, Math.ceil(items.length * 0.04));
  const triples = [...tripleCounts.entries()].filter(([, count]) => count >= minimumTripleCount).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name]) => name);
  const categories = {
    city: topCategoryValues(items, '工作城市', 8),
    experience: topCategoryValues(items, '经验要求', 7),
    education: topCategoryValues(items, '学历要求', 6),
    company_size: topCategoryValues(items, '公司规模', 6),
    employment_type: countBy(items.map((item) => normalizeEmploymentType(item.row['用工类型']))).map((item) => item.name),
  };
  const featureNames = ['intercept'];
  for (const [dimension, values] of Object.entries(categories)) for (const value of values.slice(1)) featureNames.push(`${dimension}:${value}`);
  for (const skill of skills) featureNames.push(`skill:${skill}`);
  for (const pair of pairs) featureNames.push(`pair:${pair}`);
  for (const triple of triples) featureNames.push(`triple:${triple}`);
  return { categories, skills, pairs, triples, feature_names: featureNames, minimum_skill_count: minimumSkillCount, minimum_pair_count: minimumPairCount, minimum_triple_count: minimumTripleCount };
}

function salaryFeatureVector(spec, profile, skills) {
  const selected = new Set(skills || []);
  const pairSet = new Set(spec.pairs.filter((pair) => pair.split(' + ').every((skill) => selected.has(skill))));
  const tripleSet = new Set(spec.triples.filter((triple) => triple.split(' + ').every((skill) => selected.has(skill))));
  return spec.feature_names.map((name) => {
    if (name === 'intercept') return 1;
    const separator = name.indexOf(':');
    const type = name.slice(0, separator);
    const value = name.slice(separator + 1);
    if (type === 'skill') return selected.has(value) ? 1 : 0;
    if (type === 'pair') return pairSet.has(value) ? 1 : 0;
    if (type === 'triple') return tripleSet.has(value) ? 1 : 0;
    return text(profile[type] || '未明确') === value ? 1 : 0;
  });
}

function itemSalaryFeatureVector(spec, item) {
  return salaryFeatureVector(spec, {
    city: text(item.row['工作城市']) || '未明确',
    experience: text(item.row['经验要求']) || '未明确',
    education: text(item.row['学历要求']) || '未明确',
    company_size: text(item.row['公司规模']) || '未明确',
    employment_type: normalizeEmploymentType(item.row['用工类型']),
  }, item.labels.skills);
}

function fitRidgeSalary(items, spec, options = {}) {
  const featureCount = spec.feature_names.length;
  const gram = Array.from({ length: featureCount }, () => Array(featureCount).fill(0));
  const targetProducts = Array(featureCount).fill(0);
  const skillMode = options.skillMode || 'signed';
  const active = spec.feature_names.map((name) => !name.startsWith('skill:') && !name.startsWith('pair:') && !name.startsWith('triple:') || name.startsWith('skill:') && skillMode !== 'none' || name.startsWith('pair:') && skillMode !== 'none' && options.usePairs !== false || name.startsWith('triple:') && skillMode !== 'none' && options.useTriples === true);
  for (const item of items) {
    const features = itemSalaryFeatureVector(spec, item);
    const present = features.flatMap((value, index) => value && active[index] ? [index] : []);
    const target = Math.log(item.salary.midpoint / 1000);
    const weight = salaryModelWeight(item) * (options.rowWeights?.get(item) ?? 1);
    for (const left of present) {
      targetProducts[left] += weight * target;
      for (const right of present) gram[left][right] += weight;
    }
  }
  const coefficients = Array(featureCount).fill(0);
  coefficients[0] = targetProducts[0] / gram[0][0];
  const penalties = spec.feature_names.map((name) => name === 'intercept' ? 0 : name.startsWith('triple:') ? (options.triplePenalty ?? 35) : name.startsWith('pair:') ? (options.pairPenalty ?? 14) : name.startsWith('skill:') ? (options.skillPenalty ?? 6) : 2.5);
  for (let iteration = 0; iteration < 600; iteration += 1) {
    let largestChange = 0;
    for (let index = 0; index < featureCount; index += 1) {
      if (!active[index]) continue;
      const previous = coefficients[index];
      let numerator = targetProducts[index];
      for (let other = 0; other < featureCount; other += 1) if (other !== index && active[other]) numerator -= gram[index][other] * coefficients[other];
      const constrained = skillMode === 'nonnegative' && (spec.feature_names[index].startsWith('skill:') || spec.feature_names[index].startsWith('pair:') || spec.feature_names[index].startsWith('triple:'));
      const denominator = gram[index][index] + penalties[index];
      const updated = denominator ? (constrained ? Math.max(0, numerator / denominator) : numerator / denominator) : 0;
      const change = updated - previous;
      if (!change) continue;
      coefficients[index] = updated;
      largestChange = Math.max(largestChange, Math.abs(change));
    }
    if (largestChange < 1e-7) break;
  }
  return coefficients;
}

const salaryCandidates = [
  { id: 'profile', label: '条件基线', skillMode: 'none', usePairs: false },
  { id: 'additive', label: '技能加性岭回归', skillMode: 'signed', usePairs: false, skillPenalty: 8 },
  { id: 'interaction', label: '技能交互岭回归', skillMode: 'signed', usePairs: true, skillPenalty: 8, pairPenalty: 20 },
  { id: 'interaction_shrunk', label: '强收缩技能交互', skillMode: 'signed', usePairs: true, skillPenalty: 18, pairPenalty: 40 },
  { id: 'three_way', label: '三项技能交互岭回归', skillMode: 'signed', usePairs: true, useTriples: true, skillPenalty: 18, pairPenalty: 40, triplePenalty: 60 },
  { id: 'robust_three_way', label: '稳健三项交互回归', skillMode: 'signed', usePairs: true, useTriples: true, skillPenalty: 18, pairPenalty: 40, triplePenalty: 60, robust: true },
  { id: 'monotone', label: '非负约束技能交互', skillMode: 'nonnegative', usePairs: true },
  { id: 'hybrid', label: '条件基线与技能交互混合', blend: 0.5 },
  { id: 'profile_boosted', label: '条件梯度提升树', skillMode: 'none', boosted: true },
  { id: 'skill_boosted', label: '技能梯度提升树', skillMode: 'signed', boosted: true },
];

function activeSalaryFeatures(spec, candidate) {
  return spec.feature_names.map((name, index) => index).filter((index) => {
    const name = spec.feature_names[index];
    return name !== 'intercept' && (candidate.skillMode !== 'none' || !/^(skill|pair|triple):/.test(name));
  });
}

function fitBoostedSalary(items, spec, candidate) {
  const rows = items.map((item) => itemSalaryFeatureVector(spec, item));
  const targets = items.map((item) => Math.log(item.salary.midpoint / 1000));
  const weights = items.map(salaryModelWeight);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const base = targets.reduce((sum, value, index) => sum + value * weights[index], 0) / totalWeight;
  const residuals = targets.map((value) => value - base);
  const features = activeSalaryFeatures(spec, candidate);
  const minimumLeaf = Math.max(18, Math.floor(items.length * 0.025));
  const learningRate = 0.08;
  const trees = [];
  function node(indices, depth) {
    let weight = 0; let sum = 0;
    for (const index of indices) { weight += weights[index]; sum += weights[index] * residuals[index]; }
    const value = sum / (weight + 12);
    if (!depth || indices.length < minimumLeaf * 2) return { value };
    let best = null;
    for (const feature of features) {
      let leftWeight = 0; let leftSum = 0; let leftCount = 0;
      for (const index of indices) if (rows[index][feature]) { leftCount++; leftWeight += weights[index]; leftSum += weights[index] * residuals[index]; }
      const rightCount = indices.length - leftCount;
      if (leftCount < minimumLeaf || rightCount < minimumLeaf) continue;
      const rightWeight = weight - leftWeight;
      const rightSum = sum - leftSum;
      const gain = leftSum ** 2 / (leftWeight + 12) + rightSum ** 2 / (rightWeight + 12) - sum ** 2 / (weight + 12);
      if (gain > (best?.gain ?? 0) + 1e-10) best = { feature, gain };
    }
    if (!best) return { value };
    const left = []; const right = [];
    for (const index of indices) (rows[index][best.feature] ? left : right).push(index);
    return { feature: best.feature, left: node(left, depth - 1), right: node(right, depth - 1) };
  }
  for (let round = 0; round < 45; round++) {
    const tree = node(rows.map((_, index) => index), 2);
    if (tree.feature == null) break;
    trees.push(tree);
    for (let index = 0; index < rows.length; index++) residuals[index] -= learningRate * predictTree(tree, rows[index]);
  }
  return { kind: 'boosted_trees', base, learning_rate: learningRate, trees };
}

function predictTree(tree, features) {
  let node = tree;
  while (node.feature != null) node = features[node.feature] ? node.left : node.right;
  return node.value;
}

function predictSalaryLog(predictor, features) {
  if (predictor.kind === 'boosted_trees') return predictor.base + predictor.learning_rate * predictor.trees.reduce((sum, tree) => sum + predictTree(tree, features), 0);
  return features.reduce((sum, value, index) => sum + value * predictor.coefficients[index], 0);
}

function fitSalaryPredictor(items, spec, candidate) {
  return candidate.boosted ? fitBoostedSalary(items, spec, candidate) : { kind: 'ridge', coefficients: fitSalaryCandidate(items, spec, candidate) };
}

function fitSalaryCandidate(items, spec, candidate) {
  if (candidate.blend != null) {
    const base = fitRidgeSalary(items, spec, salaryCandidates[0]);
    const interaction = fitRidgeSalary(items, spec, salaryCandidates[2]);
    return base.map((value, index) => value * (1 - candidate.blend) + interaction[index] * candidate.blend);
  }
  if (!candidate.robust) return fitRidgeSalary(items, spec, candidate);
  const first = fitRidgeSalary(items, spec, candidate);
  const residuals = items.map((item) => Math.abs(Math.log(item.salary.midpoint / 1000) - Math.log(predictSalaryK(spec, first, {
    city: text(item.row['工作城市']) || '未明确', experience: text(item.row['经验要求']) || '未明确',
    education: text(item.row['学历要求']) || '未明确', company_size: text(item.row['公司规模']) || '未明确',
    employment_type: normalizeEmploymentType(item.row['用工类型']),
  }, item.labels.skills))));
  const ordered = [...residuals].sort((a, b) => a - b);
  const median = ordered[Math.floor(ordered.length / 2)] || 0;
  const cutoff = Math.max(0.18, median * 1.4826 * 1.5);
  const rowWeights = new Map(items.map((item, index) => [item, Math.min(1, cutoff / Math.max(residuals[index], 1e-9))]));
  return fitRidgeSalary(items, spec, { ...candidate, rowWeights });
}

function salaryFold(item, folds) {
  const row = item.row;
  const key = text(row['公司ID'] || row['公司名称']) || [row['平台'], row['岗位名称']].map(text).join('|');
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) hash = Math.imul(hash ^ key.charCodeAt(index), 16777619);
  return (hash >>> 0) % folds;
}

function predictSalaryK(spec, coefficients, profile, skills) {
  const features = salaryFeatureVector(spec, profile, skills);
  const logSalary = features.reduce((sum, value, index) => sum + value * coefficients[index], 0);
  return Math.exp(logSalary);
}

function estimateSalaryK(spec, predictor, profile, skills) {
  return Math.exp(predictSalaryLog(predictor, salaryFeatureVector(spec, profile, skills)));
}

function salaryPostingKey(item) {
  const row = item.row;
  const platform = text(row['平台'] || row['来源平台']);
  const jobId = text(row['岗位ID'] || row['职位ID']);
  if (platform && jobId) return `id:${platform}:${jobId}`;
  const company = text(row['公司ID'] || row['公司名称']);
  const title = text(row['岗位名称']);
  const city = text(row['工作城市']);
  const description = text(row['岗位描述']).replace(/\s+/g, '').slice(0, 160);
  return company && title && description.length >= 30 ? `content:${company}:${title}:${city}:${description}` : `row:${row.row_no}`;
}

function salaryObservationDate(item) {
  const raw = item.row['发布时间'] || item.row['采集时间'];
  if (typeof raw === 'number' && raw > 40000 && raw < 80000) return new Date(Date.UTC(1899, 11, 30) + raw * 86400000).getTime();
  const value = text(raw);
  if (!/20\d\d/.test(value)) return null;
  const parsed = Date.parse(value.replace(/[年月]/g, '-').replace(/日/g, '').replace(/\//g, '-'));
  return Number.isFinite(parsed) ? parsed : null;
}

function modelMetrics(actual, predicted) {
  if (!actual.length) return { mae_k: null, mape: null, r2: null };
  const mean = actual.reduce((sum, value) => sum + value, 0) / actual.length;
  const absoluteErrors = actual.map((value, index) => Math.abs(value - predicted[index]));
  const mae = absoluteErrors.reduce((sum, value) => sum + value, 0) / actual.length;
  const mape = absoluteErrors.reduce((sum, value, index) => sum + value / Math.max(actual[index], 1), 0) / actual.length;
  const residual = actual.reduce((sum, value, index) => sum + (value - predicted[index]) ** 2, 0);
  const total = actual.reduce((sum, value) => sum + (value - mean) ** 2, 0);
  return { mae_k: Number(mae.toFixed(1)), mape: Number(mape.toFixed(3)), r2: Number((1 - residual / Math.max(total, 1e-9)).toFixed(3)) };
}

function buildSalaryModel(items, familyName, relevanceRate = 1) {
  const salaryRows = items.filter((item) => item.salary);
  const inRange = salaryRows.filter((item) => item.salary.midpoint >= 3000 && item.salary.midpoint <= 200000);
  const seenPostings = new Set();
  const training = inRange.filter((item) => { const key = salaryPostingKey(item); if (seenPostings.has(key)) return false; seenPostings.add(key); return true; });
  const quality = { focused_rows: items.length, parsed_salary_rows: salaryRows.length, missing_or_unparsed_salary_rows: items.length - salaryRows.length, out_of_range_rows: salaryRows.length - inRange.length, duplicate_postings: inRange.length - training.length, training_rows: training.length,
    employment_type: Object.fromEntries(['全职', '实习', '兼职/临时', '未明确'].map((type) => [type, training.filter((item) => normalizeEmploymentType(item.row['用工类型']) === type).length])),
    label_source: Object.fromEntries(['人工复核标注', '双平台一致标注', '本地规则预标注', '规则抽取'].map((source) => [source, training.filter((item) => item.label_source === source).length])) };
  if (training.length < 40) return { status: 'insufficient', sample_count: training.length, message: '有效薪资样本少于40条，不生成个人条件薪资估计。' };
  const spec = buildSalaryFeatureSpec(training);
  const folds = Math.min(5, Math.max(3, Math.floor(training.length / 30)));
  const candidateResults = new Map(salaryCandidates.map((candidate) => [candidate.id, { actual: [], predicted: [], residuals: [], test_items: [] }]));
  for (let fold = 0; fold < folds; fold += 1) {
    const train = training.filter((item) => salaryFold(item, folds) !== fold);
    const test = training.filter((item) => salaryFold(item, folds) === fold);
    if (!train.length || !test.length) continue;
    const foldSpec = buildSalaryFeatureSpec(train);
    for (const candidate of salaryCandidates) {
      const foldPredictor = fitSalaryPredictor(train, foldSpec, candidate);
      const result = candidateResults.get(candidate.id);
      for (const item of test) {
        const actualK = item.salary.midpoint / 1000;
        const features = itemSalaryFeatureVector(foldSpec, item);
        const logPrediction = predictSalaryLog(foldPredictor, features);
        result.actual.push(actualK);
        result.predicted.push(Math.exp(logPrediction));
        result.residuals.push(Math.abs(Math.log(actualK) - logPrediction));
        result.test_items.push(item);
      }
    }
  }
  const comparisons = salaryCandidates.map((candidate) => {
    const result = candidateResults.get(candidate.id);
    const rawMae = result.actual.reduce((sum, value, index) => sum + Math.abs(value - result.predicted[index]), 0) / Math.max(1, result.actual.length);
    return { id: candidate.id, label: candidate.label, metrics: modelMetrics(result.actual, result.predicted), raw_mae_k: rawMae, test_rows: result.actual.length };
  }).sort((a, b) => a.raw_mae_k - b.raw_mae_k);
  const profileComparison = comparisons.filter((item) => salaryCandidates.find((candidate) => candidate.id === item.id)?.skillMode === 'none')[0];
  const skillComparison = comparisons.filter((item) => salaryCandidates.find((candidate) => candidate.id === item.id)?.skillMode !== 'none')[0];
  const minimumSkillGainK = Math.max(0.2, profileComparison.raw_mae_k * 0.05);
  let selectedComparison = skillComparison && skillComparison.raw_mae_k <= profileComparison.raw_mae_k - minimumSkillGainK ? skillComparison : profileComparison;
  let selectedCandidate = salaryCandidates.find((candidate) => candidate.id === selectedComparison.id);
  const baselineCandidate = salaryCandidates.find((candidate) => candidate.id === profileComparison.id);
  const bestSkillCandidate = salaryCandidates.find((candidate) => candidate.id === skillComparison?.id);
  const dated = training.map((item) => ({ item, date: salaryObservationDate(item) })).filter((entry) => entry.date != null).sort((a, b) => a.date - b.date);
  if (dated.length >= 100 && new Set(dated.map((entry) => new Date(entry.date).toISOString().slice(0, 10))).size >= 5) {
    const cutoff = dated[Math.floor(dated.length * 0.8)].date;
    const older = dated.filter((entry) => entry.date < cutoff).map((entry) => entry.item);
    const newer = dated.filter((entry) => entry.date >= cutoff).map((entry) => entry.item);
    if (older.length >= 60 && newer.length >= 20) {
      const timeSpec = buildSalaryFeatureSpec(older);
      quality.time_holdout = { status: 'evaluated', date_from: new Date(cutoff).toISOString().slice(0, 10), train_rows: older.length, test_rows: newer.length };
      for (const candidate of [baselineCandidate, selectedCandidate, bestSkillCandidate].filter(Boolean)) {
        if (quality.time_holdout[candidate.id]) continue;
        const timePredictor = fitSalaryPredictor(older, timeSpec, candidate);
        const actual = newer.map((item) => item.salary.midpoint / 1000);
        const predicted = newer.map((item) => Math.exp(predictSalaryLog(timePredictor, itemSalaryFeatureVector(timeSpec, item))));
        const byEmploymentType = Object.fromEntries(['全职', '实习', '兼职/临时', '未明确'].map((type) => {
          const indexes = newer.flatMap((item, index) => normalizeEmploymentType(item.row['用工类型']) === type ? [index] : []);
          return [type, { rows: indexes.length, metrics: indexes.length >= 10 ? modelMetrics(indexes.map((index) => actual[index]), indexes.map((index) => predicted[index])) : null }];
        }));
        quality.time_holdout[candidate.id] = { ...modelMetrics(actual, predicted), mae_k_precise: Number((actual.reduce((sum, value, index) => sum + Math.abs(value - predicted[index]), 0) / actual.length).toFixed(3)), by_employment_type: byEmploymentType };
      }
    } else quality.time_holdout = { status: 'insufficient_distinct_dates', dated_rows: dated.length };
  } else quality.time_holdout = { status: 'insufficient_dates', dated_rows: dated.length };
  if (selectedCandidate.skillMode !== 'none' && quality.time_holdout.status === 'evaluated') {
    const skillTime = quality.time_holdout[selectedCandidate.id]?.mae_k_precise;
    const baselineTime = quality.time_holdout[baselineCandidate.id]?.mae_k_precise;
    if (Number.isFinite(skillTime) && Number.isFinite(baselineTime) && skillTime > baselineTime) {
      quality.time_holdout.skill_publication_gate = '较新岗位留出集未优于条件基线，技能估价停报';
      selectedComparison = profileComparison;
      selectedCandidate = baselineCandidate;
    } else quality.time_holdout.skill_publication_gate = '较新岗位留出集未劣于条件基线';
  }
  const selectedCv = candidateResults.get(selectedCandidate.id);
  quality.cv_by_employment_type = Object.fromEntries(['全职', '实习', '兼职/临时', '未明确'].map((type) => {
    const indexes = selectedCv.test_items.flatMap((item, index) => normalizeEmploymentType(item.row['用工类型']) === type ? [index] : []);
    return [type, { rows: indexes.length, metrics: indexes.length >= 10 ? modelMetrics(indexes.map((index) => selectedCv.actual[index]), indexes.map((index) => selectedCv.predicted[index])) : null }];
  }));
  const predictor = fitSalaryPredictor(training, spec, selectedCandidate);
  const baselinePredictor = fitSalaryPredictor(training, spec, baselineCandidate);
  const skillGroupGainK = skillComparison ? profileComparison.raw_mae_k - skillComparison.raw_mae_k : 0;
  const skillTimeGainK = quality.time_holdout.status === 'evaluated' && bestSkillCandidate
    ? Number(quality.time_holdout[baselineCandidate.id]?.mae_k_precise) - Number(quality.time_holdout[bestSkillCandidate.id]?.mae_k_precise) : NaN;
  const exploratorySkillAllowed = Boolean(bestSkillCandidate && skillGroupGainK >= 0.1 && skillTimeGainK >= 0.1);
  const exploratorySkillPredictor = exploratorySkillAllowed ? fitSalaryPredictor(training, spec, bestSkillCandidate) : null;
  const metrics = selectedComparison.metrics;
  const sortedResiduals = candidateResults.get(selectedCandidate.id).residuals.sort((a, b) => a - b);
  const intervalPosition = (sortedResiduals.length - 1) * 0.8;
  const intervalIndex = Math.floor(intervalPosition);
  const intervalLogHalfWidth = Number((sortedResiduals[intervalIndex] + (sortedResiduals[intervalIndex + 1] - sortedResiduals[intervalIndex] || 0) * (intervalPosition - intervalIndex)).toFixed(4));
  const profileCounts = new Map();
  for (const item of training) {
    const profile = {
      city: text(item.row['工作城市']) || '未明确', experience: text(item.row['经验要求']) || '未明确',
      education: text(item.row['学历要求']) || '未明确', company_size: text(item.row['公司规模']) || '未明确',
      employment_type: normalizeEmploymentType(item.row['用工类型']),
    };
    const key = JSON.stringify(profile);
    profileCounts.set(key, (profileCounts.get(key) || 0) + 1);
  }
  const coherentProfiles = [...profileCounts.entries()].sort((a, b) => {
    const aProfile = JSON.parse(a[0]); const bProfile = JSON.parse(b[0]);
    const employmentPreference = Number(bProfile.employment_type === '全职') - Number(aProfile.employment_type === '全职');
    return employmentPreference || b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN');
  });
  const defaults = coherentProfiles.length ? JSON.parse(coherentProfiles[0][0]) : {
    city: spec.categories.city[0] || '未明确', experience: spec.categories.experience[0] || '未明确',
    education: spec.categories.education[0] || '未明确', company_size: spec.categories.company_size[0] || '未明确',
    employment_type: spec.categories.employment_type.includes('全职') ? '全职' : spec.categories.employment_type[0],
  };
  const baselineSalary = estimateSalaryK(spec, baselinePredictor, defaults, []);
  const skillCounts = new Map();
  const skillRawSalaries = new Map();
  for (const item of training) for (const skill of item.labels.skills) {
    if (!spec.skills.includes(skill)) continue;
    skillCounts.set(skill, (skillCounts.get(skill) || 0) + 1);
    if (!skillRawSalaries.has(skill)) skillRawSalaries.set(skill, []);
    skillRawSalaries.get(skill).push(item.salary.midpoint / 1000);
  }
  const skillEffects = spec.skills.map((name) => {
    const adjustedSalary = estimateSalaryK(spec, predictor, defaults, [name]);
    const effectPct = (adjustedSalary / baselineSalary - 1) * 100;
    return {
      name, tier: skillTier(familyName, name), count: skillCounts.get(name) || 0,
      raw_median_salary_k: quantile(skillRawSalaries.get(name) || [], 0.5),
      adjusted_salary_k: selectedCandidate.skillMode === 'none' ? null : Number(adjustedSalary.toFixed(1)), adjusted_effect_pct: selectedCandidate.skillMode === 'none' ? null : Number(effectPct.toFixed(1)),
      adjusted_delta_k: selectedCandidate.skillMode === 'none' ? null : Number((adjustedSalary - baselineSalary).toFixed(1)),
    };
  }).sort((a, b) => (a.tier === b.tier ? b.count - a.count : a.tier.localeCompare(b.tier, 'zh-CN')));
  const reliability = selectedCandidate.skillMode !== 'none' && training.length >= 150 && metrics.mape <= 0.3 && metrics.r2 >= 0.4 && relevanceRate >= 0.5 ? '中等' : training.length >= 80 && metrics.mape <= 0.45 && metrics.r2 >= 0.1 ? '谨慎参考' : '低';
  return {
    status: 'ready', version: 'conditional-salary-selected-v6', method: `${selectedCandidate.label}；按公司分组交叉验证选型`, target: '企业招聘月薪中点（K/月）',
    sample_count: training.length, feature_count: activeSalaryFeatures(spec, selectedCandidate).length + 1, interval_level: 0.8,
    feature_names: spec.feature_names, predictor, baseline_predictor: baselinePredictor, coefficients: predictor.coefficients?.map((value) => Number(value.toFixed(8))) || [], interval_log_half_width: intervalLogHalfWidth,
    feature_spec: { categories: spec.categories, skills: spec.skills, pairs: spec.pairs, triples: spec.triples }, defaults,
    exploratory_skill_model: {
      status: exploratorySkillAllowed ? 'available' : 'unavailable',
      candidate: bestSkillCandidate?.id || null,
      label: skillComparison?.label || null,
      group_mae_k: skillComparison ? Number(skillComparison.raw_mae_k.toFixed(3)) : null,
      time_mae_k: Number.isFinite(skillTimeGainK) ? quality.time_holdout[bestSkillCandidate.id].mae_k_precise : null,
      group_gain_k: Number(skillGroupGainK.toFixed(3)),
      time_gain_k: Number.isFinite(skillTimeGainK) ? Number(skillTimeGainK.toFixed(3)) : null,
      predictor: exploratorySkillPredictor,
    },
    baseline_salary_k: Number(baselineSalary.toFixed(1)), baseline_coefficients: baselinePredictor.coefficients?.map((value) => Number(value.toFixed(8))) || [], metrics, reliability, skill_effects: skillEffects, quality,
    selection: { selected: selectedCandidate.id, baseline: baselineCandidate.id, grouping: '按公司分组', folds, minimum_skill_gain_k: Number(minimumSkillGainK.toFixed(2)), observed_skill_gain_k: Number((profileComparison.raw_mae_k - skillComparison.raw_mae_k).toFixed(2)), candidate_metrics: comparisons.map(({ raw_mae_k, ...item }) => ({ ...item, mae_k_precise: Number(raw_mae_k.toFixed(3)) })), skill_model_selected: selectedCandidate.skillMode !== 'none' },
    observed_samples: training.map((item) => ({
      skills: item.labels.skills.filter((skill) => spec.skills.includes(skill)),
      salary_midpoint_k: Number((item.salary.midpoint / 1000).toFixed(3)),
      city: text(item.row['工作城市']) || '未明确',
      experience: text(item.row['经验要求']) || '未明确',
      education: text(item.row['学历要求']) || '未明确',
      company_size: text(item.row['公司规模']) || '未明确',
      employment_type: normalizeEmploymentType(item.row['用工类型']),
    })),
    disclaimer: selectedCandidate.skillMode === 'none' ? quality.time_holdout.skill_publication_gate ? '技能模型虽在分组验证中有收益，但在较新岗位留出集上未优于条件基线，暂不提供技能溢价估计。结果不是个人身价或因果涨薪。' : '当前样本中技能模型未能比岗位条件基线更准确，因此不提供技能溢价估计。结果不是个人身价或因果涨薪。' : '这是同岗位族和岗位条件下的招聘薪资预测；技能组合可呈正向或负向样本关联，不代表学习技能导致涨薪或个人身价。',
    _internal: { spec, predictor, training },
  };
}

function addCombinations(values, size, callback, start = 0, prefix = []) {
  if (prefix.length === size) { callback(prefix); return; }
  for (let index = start; index <= values.length - (size - prefix.length); index += 1) addCombinations(values, size, callback, index + 1, [...prefix, values[index]]);
}

function buildFrequentSkillSets(model) {
  if (model.status !== 'ready') return [];
  const { spec, predictor, training } = model._internal;
  const eligible = new Set(spec.skills);
  const counts = new Map();
  const salaries = new Map();
  const singleCounts = new Map(spec.skills.map((skill) => [skill, 0]));
  for (const item of training) {
    const present = [...new Set(item.labels.skills.filter((skill) => eligible.has(skill)))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    for (const skill of present) singleCounts.set(skill, (singleCounts.get(skill) || 0) + 1);
    for (let size = 2; size <= Math.min(4, present.length); size += 1) addCombinations(present, size, (combination) => {
      const key = combination.join(' + ');
      counts.set(key, (counts.get(key) || 0) + 1);
      if (!salaries.has(key)) salaries.set(key, []);
      salaries.get(key).push(item.salary.midpoint / 1000);
    });
  }
  const minimumCount = Math.max(5, Math.ceil(training.length * 0.03));
  const baseline = estimateSalaryK(spec, model.baseline_predictor, model.defaults, []);
  const rows = [...counts.entries()].filter(([, count]) => count >= minimumCount).map(([name, count]) => {
    const skills = name.split(' + ');
    const support = count / training.length;
    const expected = skills.reduce((product, skill) => product * ((singleCounts.get(skill) || 0) / training.length), 1);
    const estimate = estimateSalaryK(spec, predictor, model.defaults, skills);
    return {
      name, skills, size: skills.length, count, salary_count: salaries.get(name).length, support: Number(support.toFixed(3)),
      lift: Number((support / Math.max(expected, 1 / training.length)).toFixed(2)), raw_median_salary_k: quantile(salaries.get(name), 0.5),
      adjusted_estimate_k: model.selection.skill_model_selected ? Number(estimate.toFixed(1)) : null, adjusted_delta_k: model.selection.skill_model_selected ? Number((estimate - baseline).toFixed(1)) : null,
      reliability: count >= 20 ? '中等' : count >= 10 ? '谨慎参考' : '低',
    };
  });
  return [2, 3, 4].flatMap((size) => rows.filter((item) => item.size === size).sort((a, b) => b.count - a.count || b.lift - a.lift).slice(0, 12));
}

const workbookData = await readRows();
const allRows = workbookData.rows;
if (config.expectedRows && allRows.length !== Number(config.expectedRows)) throw new Error(`交付清单声明 ${config.expectedRows} 条，但数据读取 ${allRows.length} 条；文件可能已更新，请重新点击“用于岗位洞察”`);
for (const row of allRows) {
  row['原始工作城市'] = row['工作城市'];
  row['工作城市'] = cityName(row['工作城市']);
}
if ([config.reviewedLabelDir, config.consensusLabelDirs, config.prelabelDir].filter(Boolean).length > 1) throw new Error('一次洞察只能选择一种外部标签来源');
const labelSelection = config.reviewedLabelDir
  ? { ...await approvedLabelsForWorkbook(path.resolve(config.reviewedLabelDir), inputFile, allRows, new Set(skillRules.map(([name]) => name))), sourceName: '人工复核标注' }
  : config.consensusLabelDirs
    ? await consensusLabelsForWorkbook(config.consensusLabelDirs.map((directory) => path.resolve(directory)), inputFile, allRows, new Set(skillRules.map(([name]) => name)))
    : config.prelabelDir
      ? await prelabelsForWorkbook(path.resolve(config.prelabelDir), inputFile, allRows, new Set(skillRules.map(([name]) => name)))
    : null;
const detectedRole = inferDatasetRole(allRows);
const initialSample = analysisMode === 'full' ? allRows : selectEvenSample(allRows, sampleSize);
const targetFamily = roleFamilies.find((family) => family.name === detectedRole.name) || literalRoleFamily(detectedRole.name);
const strictKeywords = targetFamily.custom || targetFamily.strict;
// Offline comparison writes only the explicitly supplied test output, never
// the production report. Baseline selection cannot be enabled by the UI.
if (config.comparisonOnly === true) {
  if (analysisMode !== 'full' || labelSelection) throw new Error('方案对比必须全量且不使用外部标签');
  const legacy = config.comparisonStrategy === 'legacy';
  const topics = legacy ? learnTopicKeywords(allRows, targetFamily) : null;
  const joint = legacy ? learnJointExpansion(allRows, {
    isSeed: row => targetFamily.title.test(text(row['岗位名称'])),
    skills: skillRules.filter(([name]) => !['分镜设计', '视频剪辑'].includes(name)),
    tasks: familyTaskRules[targetFamily.name] || generalTaskRules,
    familyName: targetFamily.name,
  }) : null;
  const learned = legacy ? null : learnUniversalRoleKeywords(allRows, targetFamily);
  const decisions = allRows.map(row => ({
    row_no: row.row_no, platform: row['平台'], job_id: row['岗位ID'], title: row['岗位名称'],
    description: row['岗位描述'], salary: row['薪资'], city: row['工作城市'],
    education: row['学历要求'], experience: row['经验要求'], skills: row['技能'],
    salary_midpoint_k: normalizeSalary(row['薪资'])?.midpoint / 1000 || null,
    match: legacy ? matchesExpandedRole(row, targetFamily, topics, joint) : matchUniversalRoleKeywords(row, learned),
  }));
  await fs.writeFile(outputPath, JSON.stringify({ strategy: legacy ? 'legacy' : 'universal', input: inputFile,
    role: targetFamily.name, total_rows: allRows.length, included: decisions.filter(item => item.match.matched).length,
    keywords: learned?.keywords || [], decisions }, null, 2));
  console.log(JSON.stringify({ comparison: true, output: outputPath, included: decisions.filter(item => item.match.matched).length }));
  process.exit(0);
}
const topicModel = { seed_rows: 0, terms: [], strong_terms: [], supporting_terms: [] };
const jointModel = { seed_rows: 0, skills: [], tasks: [] };
// All roles use the same learning/matching path. Historical drama validation
// must not be attached to this different algorithm or a different dataset.
// Only the agent application profile has undergone the v2 offline review.
// Preserve other role families until their own evidence profiles are evaluated.
const evidenceV2 = targetFamily.name === '智能体/大模型应用';
const keywordModel = (evidenceV2 ? learnRoleEvidence : learnUniversalRoleKeywords)(allRows, targetFamily, {
  algorithm: config.keywordAlgorithm || 'tfidf', top_k: 40, minimum_hits: 2,
  threshold: 4,
});
if (keywordModel && (keywordModel.family !== targetFamily.name || (!keywordModel.cold_start && !keywordModel.keywords?.length) || !Number.isInteger(keywordModel.minimum_hits) || keywordModel.minimum_hits < 1)) throw new Error('岗位关键词模型无效，已停止分析');
const classifiedSample = initialSample.map((row) => ({ row, classification: classifyRow(row), target_match: (evidenceV2 ? matchRoleEvidence : matchUniversalRoleKeywords)(row, keywordModel) }));
const pendingReview = classifiedSample.filter(item => item.target_match.decision === 'review');
// Same-file labels may have been produced for a different job family. For a
// custom requested role, use their attributes, not their target/non-target vote.
const labelsMaySelectRows = false;
const excludedByPrelabel = classifiedSample.filter((item) => labelsMaySelectRows && item.target_match.matched && labelSelection?.nonTargetRows?.has(item.row.row_no)).length;
const includedByExternalLabel = classifiedSample.filter((item) => labelsMaySelectRows && !item.target_match.matched && labelSelection?.accepted.has(item.row.row_no)).length;
const focused = classifiedSample.filter((item) => (
  item.target_match.matched || (labelsMaySelectRows && labelSelection?.accepted.has(item.row.row_no))
) && !(labelsMaySelectRows && labelSelection?.nonTargetRows?.has(item.row.row_no))).map(item=>item.target_match.matched ? item : {
  ...item, target_match:{matched:true,method:'外部原文证据标签补充',confidence_band:labelSelection.sourceName==='本地规则预标注'?'待复核':'标签确认',reasons:[labelSelection.sourceName],topic_matches:[]},
});
const relevantDetectedCount = focused.length;
if (!focused.length) throw new Error(`未找到与“${detectedRole.name}”学习关键词匹配的职责记录，已停止分析；不会回退到固定技术词或其他岗位族`);
const enriched = focused.map((item) => {
  const labels = extractLabels(item.row, detectedRole.name);
  const selectedLabels = labelSelection?.accepted.get(item.row.row_no);
  if (selectedLabels) {
    if (selectedLabels.skills.length) labels.skills = selectedLabels.skills;
    if (selectedLabels.tasks.length) labels.tasks = selectedLabels.tasks;
    if (selectedLabels.domains?.length) labels.domains = selectedLabels.domains;
  }
  return { ...item, salary: normalizeSalary(item.row['薪资']), labels, label_source: selectedLabels ? labelSelection.sourceName : '规则抽取' };
});
const sample = enriched.map((item) => item.row);
const monthlySalaryK = enriched.map((item) => item.salary?.midpoint / 1000).filter(Number.isFinite);
const overallMedian = quantile(monthlySalaryK, 0.5);

const skillStats = skillRules.map(([name]) => {
  const matches = enriched.filter((item) => item.labels.skills.includes(name));
  const salaries = matches.map((item) => item.salary?.midpoint / 1000).filter(Number.isFinite);
  const median = quantile(salaries, 0.5);
  return { name, count: matches.length, rate: Number((matches.length / sample.length).toFixed(3)), salary_count: salaries.length, median_salary_k: median, salary_delta_pct: overallMedian && salaries.length >= 5 ? Number((((median / overallMedian) - 1) * 100).toFixed(1)) : null };
}).filter((item) => item.count).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

const pairCounts = new Map();
for (const item of enriched) {
  const skills = item.labels.skills;
  for (let i = 0; i < skills.length; i += 1) for (let j = i + 1; j < skills.length; j += 1) {
    const pair = [skills[i], skills[j]].sort((a, b) => a.localeCompare(b)).join(' + ');
    pairCounts.set(pair, (pairCounts.get(pair) || 0) + 1);
  }
}
const skillCountMap = new Map(skillStats.map((item) => [item.name, item.count]));
const minPairCount = Math.max(3, Math.ceil(sample.length * 0.015));
const skillCombinations = [...pairCounts.entries()].map(([name, count]) => {
  const [first, second] = name.split(' + ');
  const support = count / sample.length;
  const lift = support / ((skillCountMap.get(first) / sample.length) * (skillCountMap.get(second) / sample.length));
  const salaries = enriched.filter((item) => item.labels.skills.includes(first) && item.labels.skills.includes(second)).map((item) => item.salary?.midpoint / 1000).filter(Number.isFinite);
  return { name, count, support: Number(support.toFixed(3)), lift: Number(lift.toFixed(2)), salary_count: salaries.length, median_salary_k: quantile(salaries, 0.5) };
}).filter((item) => item.count >= minPairCount).sort((a, b) => b.count - a.count || b.lift - a.lift).slice(0, 15);

function distribution(field) { return countBy(sample.map((row) => row[field])).slice(0, 12); }
function labeledDistribution(key) { return countBy(enriched.flatMap((item) => item.labels[key])).slice(0, 12); }
const cityBase = countBy(sample.map((row) => row['工作城市']));
const cities = cityBase.map((item) => {
  const salaries = enriched.filter(({ row }) => row['工作城市'] === item.name).map((entry) => entry.salary?.midpoint / 1000).filter(Number.isFinite);
  const coordinates = cityCoordinates[item.name] || null;
  return { ...item, rate: Number((item.count / sample.length).toFixed(3)), median_salary_k: quantile(salaries, 0.5), salary_count: salaries.length, longitude: coordinates?.[0] || null, latitude: coordinates?.[1] || null };
});

const observations = enriched.map((item) => {
  const row = item.row;
  const source = [row['岗位名称'], row['技能'], row['岗位描述']].map(text).join('\n');
  const domainEvidence = domainRules.filter(([name]) => item.labels.domains.includes(name)).map(([label, regex]) => {
    const match = regex.exec(source);
    return { label, quote: match ? source.slice(Math.max(0, match.index - 25), match.index + match[0].length + 65).replace(/\s+/g, ' ') : '' };
  });
  return { row_no: row.row_no, job_id: text(row['岗位ID']) || `row-${row.row_no}`, job_name: text(row['岗位名称']),
    city: row['工作城市'], raw_city: text(row['原始工作城市']), district: text(row['区县'] || row['工作区域']) || text(row['原始工作城市']).split(/[-—]/).slice(1).join('-'),
    experience: text(row['经验要求']) || '未明确', education: text(row['学历要求']) || '未明确', company_size: text(row['公司规模']) || '未明确',
    employment_type: normalizeEmploymentType(row['用工类型']), salary_midpoint_k: item.salary ? item.salary.midpoint / 1000 : null,
    skills: [...new Set(item.labels.skills)], tasks: [...new Set(item.labels.tasks)], domains: [...new Set(item.labels.domains)],
    industry: text(row['行业']) || '未明确', company_key: text(row['公司ID'] || row['公司名称']) ? `${text(row['平台'])}:${text(row['公司ID'] || row['公司名称'])}` : '',
    label_source: item.label_source, evidence: domainEvidence,
  };
});
const cohortSummary = summarizeCohort(observations);

const roleSegments = countBy(focused.map((item) => item.classification.family));
const inputRoleSegments = countBy(classifiedSample.map((item) => item.classification.family));
const salarySkillStats = skillStats.filter((item) => item.salary_count >= 5).sort((a, b) => (b.median_salary_k || 0) - (a.median_salary_k || 0)).slice(0, 12);
const salaryModelWithInternal = buildSalaryModel(enriched, detectedRole.name, relevantDetectedCount / initialSample.length);
const frequentSkillSets = buildFrequentSkillSets(salaryModelWithInternal);
const { _internal: salaryModelInternal, ...salaryModel } = salaryModelWithInternal;
const descriptionFilled = sample.filter((row) => text(row['岗位描述'])).length;
const skillLabeled = enriched.filter((item) => item.labels.skills.length).length;
const taskLabeled = enriched.filter((item) => item.labels.tasks.length).length;
const fieldCoverage = Object.fromEntries(['岗位名称', '薪资', '工作城市', '经验要求', '学历要求', '技能', '岗位描述', '行业', '公司规模', '公司性质', '用工类型'].map((field) => [field, Number((allRows.filter((row) => text(row[field])).length / allRows.length).toFixed(3))]));
const relevantRate = Number((relevantDetectedCount / initialSample.length).toFixed(3));
const matchMethods = countBy(focused.map((item) => item.target_match.method));
const confidenceBands = countBy(focused.map((item) => item.target_match.confidence_band));
const auditExample = (item) => ({ row_no: item.row.row_no, title: text(item.row['岗位名称']), query: text(item.row['查询关键词']), reasons: item.target_match.reasons, topic_matches: item.target_match.topic_matches, joint_evidence: item.target_match.joint_evidence || null, keyword_evidence: item.target_match.keyword_evidence || null });
const matchExamples = Object.fromEntries([...new Set(focused.map((item) => item.target_match.method))].map((method) => [method, selectEvenSample(focused.filter((item) => item.target_match.method === method), 12).map(auditExample)]));
matchExamples['未匹配'] = selectEvenSample(classifiedSample.filter((item) => !item.target_match.matched), 12).map(auditExample);
const insights = [];
if (skillStats[0]) insights.push(`${detectedRole.name}样本中最常见技能为 ${skillStats[0].name}，覆盖 ${skillStats[0].count}/${sample.length} 条岗位。`);
if (skillCombinations[0]) insights.push(`最高频技能组合为 ${skillCombinations[0].name}，出现 ${skillCombinations[0].count} 次，Lift 为 ${skillCombinations[0].lift}。`);
if (cities[0]) insights.push(`${cities[0].name} 是当前样本岗位最多的城市，共 ${cities[0].count} 条。`);
if (salarySkillStats[0]?.median_salary_k) insights.push(`有至少5个薪资样本的技能中，${salarySkillStats[0].name} 对应月薪中位数最高，为 ${salarySkillStats[0].median_salary_k}K。`);
insights.push(`${detectedRole.mode === 'auto' ? '自动识别岗位族' : '手工指定岗位'}为“${detectedRole.name}”${detectedRole.confidence == null ? '；按手工关键词直接匹配，不报告自动识别置信度' : `，识别置信度 ${(detectedRole.confidence * 100).toFixed(1)}%`}；样本岗位契合率 ${(relevantRate * 100).toFixed(1)}%。`);

const report = {
  version: evidenceV2 ? 'job-market-insight-v9' : 'job-market-insight-v8', selection_contract: evidenceV2 ? 'role-evidence-v2' : 'universal-keywords-v1', role: detectedRole.name, detected_role: detectedRole, input_file: inputFile, sheet_name: workbookData.sheetName, generated_at: new Date().toISOString(),
  selection_review: evidenceV2 ? { included_rows: focused.length, pending_rows: pendingReview.length, excluded_rows: initialSample.length - focused.length - pendingReview.length,
    included_in_statistics: false, profile: keywordModel.profile, threshold: keywordModel.threshold,
    note: '待复核记录独立保留，不计入主报告薪资、城市或技能统计；证据纳入不是人工确认，仍可能误收',
    rows: pendingReview.map(item => ({ row_no: item.row.row_no, title: text(item.row['岗位名称']), platform: text(item.row['平台']), job_id: text(item.row['岗位ID']), city: text(item.row['工作城市']), reasons: item.target_match.reasons, keyword_evidence: item.target_match.keyword_evidence })) } : null,
  transfer_provenance: { task_id: config.sourceTaskId || '', resolution: config.sourceResolution || 'manual', expected_rows: config.expectedRows || null, read_rows: allRows.length },
  input_role_segments: inputRoleSegments,
  joint_expansion: keywordModel ? null : { ...publicJointExpansion(jointModel), included_rows: focused.filter((item) => item.target_match.joint_evidence).length, merged_into_insights: true },
  keyword_selection: keywordModel ? { version: keywordModel.version, algorithm: keywordModel.display_name, scope: keywordModel.scope, keywords: keywordModel.keywords, minimum_hits: keywordModel.minimum_hits, seed_rows: keywordModel.training_seed_rows.length, seed_source: keywordModel.seed_source, rule_seed_candidates: keywordModel.rule_seed_candidates, training_background_rows: keywordModel.training_background_rows, cold_start: keywordModel.cold_start, development_rows: keywordModel.development_rows?.length || 0, test_rows: keywordModel.test_rows?.length || 0, validation: keywordModel.validation || null, annotation_type: keywordModel.annotation_type || '', reviewed_rows: 0, uncertain_rows: 0, direct_rows: focused.filter(x => x.target_match.keyword_evidence?.rule_seed).length, expanded_rows: focused.filter(x => !x.target_match.keyword_evidence?.rule_seed).length, policy: keywordModel.selection_policy, audit_examples: selectEvenSample(focused, 12).map(auditExample) } : null,
  total_rows: allRows.length, requested_sample_rows: initialSample.length, sample_rows: sample.length, relevant_sample_rows: relevantDetectedCount, filtered_out_rows: initialSample.length - relevantDetectedCount, filtered_out_rate: Number(((initialSample.length - relevantDetectedCount) / initialSample.length).toFixed(3)), relevance_rate: relevantRate, analysis_mode: analysisMode, sampling_method: `${analysisMode === 'full' ? '全量逐条匹配' : '按全量岗位序号等距抽样'}；${keywordModel.display_name}；所有记录须命中至少${keywordModel.minimum_hits}个独立学习关键词；查询关键词不参与纳入；外部标签仅补充属性`, focus_fallback: false,
  topic_model: { method: keywordModel.selection_policy, seed_rows: keywordModel.training_seed_rows.length, discovered_terms: keywordModel.keywords.map(term => ({ ...term, name: term.term })), match_methods: matchMethods, confidence_bands: confidenceBands, audit_examples: matchExamples },
  quality: { salary_rows: monthlySalaryK.length, salary_coverage: Number((monthlySalaryK.length / sample.length).toFixed(3)), description_rows: descriptionFilled, description_coverage: Number((descriptionFilled / sample.length).toFixed(3)), skill_labeled_rows: skillLabeled, skill_coverage: Number((skillLabeled / sample.length).toFixed(3)), task_labeled_rows: taskLabeled, task_coverage: Number((taskLabeled / sample.length).toFixed(3)), field_coverage: fieldCoverage },
  label_provenance: labelSelection ? { mode: labelSelection.quality.mode || '人工批准且有原文证据的外部标注优先，其余用规则', job_id: config.reviewedLabelJobId || '', ...labelSelection.quality, excluded_by_prelabel: excludedByPrelabel, included_by_external_label: includedByExternalLabel, used_in_focused_rows: enriched.filter((item) => item.label_source === labelSelection.sourceName).length } : { mode: '规则抽取', used_in_focused_rows: 0 },
  salary: { unit: 'K/月', p25: quantile(monthlySalaryK, 0.25), median: overallMedian, p75: quantile(monthlySalaryK, 0.75), sample_count: monthlySalaryK.length },
  salary_benchmarks: { experience: salaryBenchmark(enriched, '经验要求'), education: salaryBenchmark(enriched, '学历要求'), city: salaryBenchmark(enriched, '工作城市') },
  skills: skillStats.slice(0, 24), skill_combinations: skillCombinations, frequent_skill_sets: frequentSkillSets, salary_by_skill: salarySkillStats, salary_model: salaryModel,
  profiles: { education: distribution('学历要求'), experience: distribution('经验要求'), employment_type: distribution('用工类型'), role_segments: roleSegments, typical: { education: distribution('学历要求')[0]?.name || '未明确', experience: distribution('经验要求')[0]?.name || '未明确', employment_type: distribution('用工类型')[0]?.name || '未明确' } },
  cities, industries: distribution('行业'), company_sizes: distribution('公司规模'), company_natures: distribution('公司性质'), tasks: labeledDistribution('tasks'), business_domains: labeledDistribution('domains'), benefits: countBy(sample.flatMap((row) => text(row['福利/标签']).split(/[|、,，]/).map((value) => value.trim()).filter(Boolean))).slice(0, 15), insights,
  cohort_observations: observations, experience_cohorts: experienceCohorts(observations), industry_positioning: { method: '按来源平台和公司ID/公司名称去重；同一公司存在多个行业时均分权重；占比为样本行业分布', ...cohortSummary },
  warnings: [...(relevantRate < 0.3 ? [`当前数据集岗位契合率仅 ${(relevantRate * 100).toFixed(1)}%，搜索召回噪声较高；结论应基于契合岗位并优先复核原始数据。`] : []), ...(sample.length < 30 ? [`契合岗位仅 ${sample.length} 条，薪资分层和技能组合稳定性不足，不建议直接用于对外报价或个体决策。`] : []), '本页反映企业招聘需求画像，不代表实际从业者供给画像。', '条件薪资模型按公司分组交叉验证选型；技能组合的正负差异是岗位样本关联，不是技能的因果价格或个人身价。', '自动岗位识别和职责抽取采用可解释规则；低置信度或低契合率数据集应先人工抽查，再用于对外咨询。', '少样本结果用于产品验证与方向发现；正式发布建议扩大样本并按岗位族、城市和经验分层验收。'],
};
if (keywordModel) {
  report.sampling_method = `${analysisMode === 'full' ? '全量逐条匹配' : '等距抽样检查'}；${keywordModel.display_name}；${keywordModel.selection_policy}；查询关键词不作为纳入证据；外部标签仅补充属性`;
  report.topic_model.method = keywordModel.display_name;
  report.topic_model.seed_rows = keywordModel.training_seed_rows.length;
  report.topic_model.discovered_terms = keywordModel.keywords.map(x => ({ name: x.term, seed_count: x.seed_df, score: x.score }));
  report.warnings.unshift(evidenceV2 ? '智能体上下文方案在40条开发记录和32条隔离留出记录上做过模型原文复核，并非人工金标准；更保守但会漏选，英文及工业Agent语义仍有边界；待复核列表不纳入主统计。' : '统一关键词方案尚无本岗位独立人工准确率验证；自动纳入仍可能误收，需人工抽查。');
}
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({ ok: true, output: outputPath, detected_role: detectedRole.name, confidence: detectedRole.confidence, total_rows: allRows.length, requested_sample_rows: initialSample.length, focused_rows: sample.length, salary_rows: monthlySalaryK.length }));
