import {parseOriginalSalary} from './job_salary_parser.mjs';
const text=value=>String(value??'').trim();
const pattern=parts=>new RegExp(parts.join('|'),'i');
export function normalizeSalary(rawValue) {
  const parsed=parseOriginalSalary(rawValue);if(!parsed||parsed.period!=='month')return null;
  const {min,max,midpoint,raw}=parsed;
  return {min,max,midpoint,raw};
}

export const roleFamilies = [
  {name:'新媒体运营',filename:pattern(['新媒体','短视频运营','内容运营']),query:pattern(['新媒体','短视频运营','内容运营']),title:pattern(['新媒体','短视频运营','内容运营']),content:pattern(['账号运营','内容运营','内容策划','小红书','抖音运营'])},
  {name:'销售工程师',filename:pattern(['销售工程师','技术销售']),query:pattern(['销售工程师','技术销售']),title:pattern(['销售工程师','技术销售']),content:pattern(['客户开发','技术方案宣讲','商务谈判','产品销售','销售目标'])},
  {name:'数据挖掘',filename:pattern(['数据挖掘']),query:pattern(['数据挖掘']),title:pattern(['数据挖掘']),content:pattern(['数据挖掘','特征工程','预测模型','统计建模'])},
  // These expressions resolve the requested family only; actual admission is
  // determined by the sealed supervised classifier, never by title alone.
  { name:'数据分析',filename:pattern(['数据分析','商业分析','经营分析','统计分析','BI分析']),query:pattern(['数据分析','商业分析','经营分析','统计分析','BI分析']),title:pattern(['数据分析','商业分析','经营分析','统计分析','BI分析']),content:pattern(['数据分析','指标体系','分析报告','统计分析','业务洞察']) },
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

export const skillRules = [
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

export function normalizeEmploymentType(value) {
  const raw = text(value);
  if (/实习/.test(raw)) return '实习';
  if (/兼职|临时|小时|日结/.test(raw)) return '兼职/临时';
  if (/全职|社会招聘|校园招聘/.test(raw)) return '全职';
  return '未明确';
}

