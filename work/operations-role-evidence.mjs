import { roleSections } from './role-evidence-v2.mjs';

// Explicit fallback for this family, NOT a trained or calibrated classifier.
// A title, query, isolated skill, or learned word frequency never admits a job.
const vocabulary = [
  ['服务器', /服务器|\bservers?\b/i], ['Linux', /\blinux\b/i],
  ['Windows Server', /windows\s*server/i], ['操作系统', /操作系统/i],
  ['网络设施', /网络|交换机|路由器|防火墙|负载均衡|\bnetwork\b/i],
  ['数据库', /数据库|mysql|postgresql|oracle|redis|mongodb/i],
  ['容器平台', /容器|kubernetes|\bk8s\b|docker/i],
  ['云平台', /云平台|云资源|云服务器|云基础设施|阿里云|腾讯云|华为云|\baws\b|\bazure\b/i],
  ['虚拟化', /虚拟化|vmware|openstack/i],
  ['中间件', /中间件|nginx|tomcat|kafka|rabbitmq/i],
  ['应用系统', /应用系统|业务系统|信息系统|软件系统|生产系统|网站|线上服务/i],
  ['监控平台', /监控平台|监控系统|prometheus|grafana|zabbix/i],
  ['交付流水线', /jenkins|ci\s*\/\s*cd|持续集成|持续交付|发布流水线/i],
  ['基础设施自动化', /ansible|terraform|基础设施即代码/i],
];
const nonITTitle = /风电|风机|光伏|电站|变电|输电|配电|电力|发电|充电桩|电梯|暖通|空调|水处理|污水|水务|环保设备|机械|售货机|加油站/;
const otherTitle = /销售|客服|商务|市场推广|招聘(?:专员|顾问|经理|助理)|行政|保洁|前端开发|后端开发|算法工程|软件开发|应用开发|开发工程师|研发工程师|产品经理|硬件研发|电路设计|嵌入式|固件|驱动开发|安全工程师|渗透|测试工程|测试开发|软件测试|数据分析|数据开发|大数据开发/;
const nonOperationsClause = /(?:linux\s*(?:kernel|内核)|设备驱动|固件|bsp|bootloader).{0,30}(?:开发|研发|维护|移植)|(?:开发|研发|维护|移植).{0,30}(?:linux\s*(?:kernel|内核)|设备驱动|固件|bsp|bootloader)|渗透测试|漏洞挖掘/i;
const action = /运维|运行维护|维护|监控|巡检|排障|故障.{0,8}(?:处理|排查|定位|恢复)|(?:处理|排查|定位|恢复).{0,8}故障|备份|容灾|容量规划|应急响应|值守|值班|变更管理|发布管理|稳定性|可用性|持续集成|持续交付|自动化部署|\bmaintain\w*\b|\bmonitor\w*\b|incident\s+response/i;
const responsibility = /负责|承担|参与|完成|主导|协助|保障|确保|处理|排查|维护|监控|巡检|\bresponsib\w*\b|you will|\bmaintain\w*\b|\bmonitor\w*\b/i;
const qualification = /熟悉|掌握|精通|了解|优先|经验|能力|具备|学习|培训|\bfamiliar\b|\bexperience\b|\bknowledge\b/i;
const normalized = value => String(value || '').normalize('NFKC');

function evidenceFor(row) {
  return roleSections(row).flatMap(section => section.quote.split(/[，,]/).map(part => {
    const quote = normalized(part).trim();
    const hits = vocabulary.filter(([, re]) => re.test(quote)).map(([term]) => term);
    const duty = section.location === 'duties' || responsibility.test(quote);
    const strong = hits.length > 0 && action.test(quote) && duty && !qualification.test(quote) && !nonOperationsClause.test(quote);
    return { location: section.location, quote: part.trim(), hits, score: strong ? 4 : hits.length ? 2 : 0 };
  })).filter(part => part.hits.length);
}

export function learnOperationsEvidence(rows, family) {
  if (family.name !== '运维/云平台') throw new Error('IT运维证据方案不能用于其他岗位族');
  const bodies = rows.map(row => roleSections(row).map(p => normalized(p.quote)).join('\n'));
  const seeds = rows.map(row => ({ row, evidence: evidenceFor(row) })).filter(({row,evidence}) => !nonITTitle.test(normalized(row['岗位名称'])) &&
    !otherTitle.test(normalized(row['岗位名称'])) && evidence.some(p => p.score === 4));
  const keywords = vocabulary.map(([term, re]) => ({ term, score: 1,
    seed_df: seeds.filter(({evidence}) => evidence.some(p => p.hits.includes(term))).length,
    background_df: bodies.filter(body => re.test(body)).length, source: 'curated-it-operations-vocabulary',
  }));
  return { version: 'operations-evidence-v1', family: family.name, scope: family.name,
    algorithm: 'curated-context', display_name: 'IT对象＋运维职责上下文（规则，非训练模型）',
    profile: 'it-operations', keywords, display_keywords: keywords,
    minimum_hits: 1, threshold: 4, training_seed_rows: seeds.map(({row}) => row.row_no),
    rule_seed_candidates: seeds.length, training_background_rows: rows.length, cold_start: false,
    seed_source: '人工配置IT对象与运维动作；本数据集仅统计覆盖频次，不在线训练；标题/查询不直接纳入',
    selection_policy: '有效正文同一子句必须出现IT对象、运维动作与明确职责；仅技能/任职条件待复核；非IT设施运维和其他明确岗位标题冲突待复核，不计主统计；公司福利排除；启发式未校准准确率，不是TF-IDF＋逻辑回归',
  };
}

export function matchOperationsEvidence(row, model) {
  const evidence = evidenceFor(row);
  const title = normalized(row['岗位名称']);
  const conflict = nonITTitle.test(title) || otherTitle.test(title);
  const score = Math.max(0, ...evidence.map(part => part.score));
  const decision = !conflict && score >= model.threshold ? 'include' : score ? 'review' : 'exclude';
  return { matched: decision === 'include', decision, method: model.display_name,
    confidence_band: decision === 'include' ? '职责证据纳入（非概率）' : decision === 'review' ? '待复核' : '排除',
    reasons: [conflict ? '标题指向非IT设施运维或其他职责，需要人工复核' : decision === 'include' ? '有效正文同子句包含IT对象及明确运维职责' : decision === 'review' ? '有IT对象但缺少明确运维职责' : '无IT运维职责证据'],
    topic_matches: [...new Set(evidence.flatMap(part => part.hits))], joint_evidence: null,
    keyword_evidence: { model_version: model.version, algorithm: model.algorithm, rule_seed: false,
      score, threshold: model.threshold, decision, title_conflict: conflict,
      hits: [...new Set(evidence.flatMap(part => part.hits))],
      quotes: evidence.map(part => ({ keyword: part.hits.join('、'), quote: part.quote, location: part.location, score: part.score })),
      production_quotes: decision === 'include' ? evidence.filter(part => part.score >= model.threshold).map(part => part.quote) : [],
    },
  };
}
