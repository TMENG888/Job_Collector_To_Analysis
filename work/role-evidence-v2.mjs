import { learnUniversalRoleKeywords, matchUniversalRoleKeywords } from './universal-role-keywords.mjs';

const normalize = s => String(s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
const headings = /(岗位职责|工作职责|主要职责|工作内容|岗位定位|职位描述|任职要求|职位要求|岗位要求|任职资格|招聘要求|加分项|优先条件|公司介绍|公司简介|关于我们|企业介绍|福利待遇|岗位福利|薪酬福利)/g;
export function roleSections(row) {
  const jd = String(row['岗位描述'] || '');
  const parts = []; let location = 'unsectioned', cursor = 0;
  for (const match of jd.matchAll(headings)) {
    parts.push({ location, text: jd.slice(cursor, match.index) });
    location = /公司|企业|关于我们|福利/.test(match[0]) ? 'excluded' : /要求|资格|加分|优先/.test(match[0]) ? 'requirements' : 'duties';
    cursor = match.index + match[0].length;
  }
  parts.push({ location, text: jd.slice(cursor) });
  // Keep original quote characters/spacing. Unknown sections are not silently
  // presented as explicit duties, and boilerplate is never selection evidence.
  return parts.filter(p => p.location !== 'excluded').flatMap(p => p.text.split(/[。；;\n]/)
    .map(quote => ({ location: p.location, quote: quote.trim() })).filter(p => p.quote &&
      !/^(?:公司|我们)(?:是|成立|致力于)|^(?:薪资|待遇|福利|五险|招聘人数)/.test(p.quote)));
}
const aliases = {
  agent: /\bagents?\b|智能体/i, rag: /\brag\b|检索增强生成/i,
  llm: /\bllms?\b|大语言模型|大模型/i, langchain: /langchain/i,
  prompt: /prompt|提示词/i,
};
function termPresent(quote, term) {
  const key = normalize(term);
  return aliases[key] ? aliases[key].test(quote) : /^[a-z0-9]+$/.test(key)
    ? new RegExp(`(?<![a-z0-9])${key}(?![a-z0-9])`, 'i').test(quote) : normalize(quote).includes(key);
}
const domain = /\bagents?\b|智能体|\brag\b|检索增强生成|大模型|大语言模型|\bllms?\b|langchain|dify|coze|模型路由|AI\s*(?:App|应用|服务)/i;
const engineering = /开发|研发|构建|搭建|集成|接入|封装|部署|编排|实现|建设|二次开发|迭代/;
const toolsOnly = /(?:使用|利用|借助|应用).{0,25}(?:AI\s*Coding|copilot|cursor|代码助手|编程助手)|辅助.{0,8}(?:编程|编码)|提升.{0,12}(?:编码|编程)效率/i;
const future = /探索|前瞻|了解|兴趣|关注|培养|未来|方向延伸/;
const weak = /^(?:api|生成|机制|增强|解析|自主|拆解|提示|问答|检索|微调|上下文|记忆)$/i;
function contextual(sentence, row) {
  const q = sentence.quote;
  const d = q.match(domain), a = q.match(engineering);
  const objectNearAction = d && a && Math.abs(d.index - a.index) <= 65;
  const baseTrainingOnly = /预训练|训练数据|训练优化|基座模型/.test(q) && !/应用|智能体|\bagent\b|\brag\b|集成|服务|接入/i.test(q);
  const genericAgent = /智能体|\bagent\b/i.test(q) && !/AI|大模型|LLM|RAG|langchain|dify|coze|多智能体|工具调用|记忆|编排/i.test(q + ' ' + row['岗位名称']);
  const standaloneModel = /大模型|\bllm\b/i.test(q) && !/应用|服务|集成|接入|封装|部署|智能体|\bagent\b|\brag\b|问答|助手|工作流/i.test(q);
  return { domain: !!d, engineering: !!objectNearAction && !toolsOnly.test(q) && !baseTrainingOnly,
    ambiguous: future.test(q) || genericAgent || standaloneModel, tools_only: toolsOnly.test(q), base_training: baseTrainingOnly };
}

export function learnRoleEvidence(rows, family, settings = {}) {
  const prepared = rows.map(row => ({ ...row, '岗位描述': roleSections(row).map(p => p.quote).join('\n') }));
  const base = learnUniversalRoleKeywords(prepared, family, settings);
  const profile = family.name === '智能体/大模型应用' ? 'agent-engineering' : 'generic';
  return { ...base, version: 'role-evidence-v2', base_version: base.version, profile,
    threshold: settings.threshold ?? 4, display_name: base.display_name + '＋位置/领域/上下文证据',
    seed_source: '目标标题种子；职责与任职要求共同提词，按有效正文去重；公司介绍/福利不参与',
    selection_policy: profile === 'agent-engineering'
      ? '学习关键词是必要条件；逐句核对领域对象与工程动作，通用词不独立放行；明确工程职责可单强证据纳入，熟悉工具/探索方向待复核；仅主报告纳入统计，分数非概率'
      : '职责和任职要求共同提词，公司/福利排除；其他岗位族维持两个独立学习词规则，尚未校准领域上下文',
  };
}
export function matchRoleEvidence(row, model) {
  const sections = roleSections(row);
  if (model.profile !== 'agent-engineering') {
    const result = matchUniversalRoleKeywords({ ...row, '岗位描述': sections.map(p => p.quote).join('\n') }, model);
    return { ...result, decision: result.matched ? 'include' : 'exclude' };
  }
  const evidence = sections.map(sentence => {
    const hits = model.keywords.filter(k => termPresent(sentence.quote, k.term));
    const independent = hits.filter(k => !hits.some(other => k.term !== other.term && normalize(other.term).includes(normalize(k.term))));
    const context = contextual(sentence, row);
    const strong = independent.filter(k => !weak.test(k.term));
    // Fixed domain vocabulary constrains context; it can never admit a row
    // without a keyword actually learned from this dataset's training seeds.
    let score = context.domain && context.engineering && !context.ambiguous && strong.length
      ? (sentence.location === 'requirements' ? 3 : sentence.location === 'duties' ? 4 : 3) : 0;
    if (score && /智能体|agent|大模型应用|AI.?应用/i.test(String(row['岗位名称']))) score += 1;
    if (score && independent.length >= 2) score += .5;
    return { ...sentence, hits: independent.map(k => k.term), strong_hits: strong.map(k => k.term), context, score };
  }).filter(e => e.hits.length || e.context.domain);
  const best = Math.max(0, ...evidence.map(e => e.score));
  const matched = best >= model.threshold;
  const review = !matched && evidence.some(e => e.context.domain && e.hits.length && !e.context.tools_only && !e.context.base_training);
  const decision = matched ? 'include' : review ? 'review' : 'exclude';
  return { matched, decision, method: '学习关键词＋领域工程上下文', confidence_band: matched ? '证据纳入（非概率）' : review ? '待复核' : '排除',
    reasons: [matched ? '有效正文中有学习关键词支持的目标工程证据' : review ? '目标领域证据存在，但工程职责/位置/强度不足' : '缺少目标工程证据或仅使用AI工具'],
    topic_matches: [...new Set(evidence.flatMap(e => e.hits))], joint_evidence: null,
    keyword_evidence: { model_version: model.version, algorithm: model.algorithm, hits: [...new Set(evidence.flatMap(e => e.hits))],
      score: best, threshold: model.threshold, decision, rule_seed: false,
      quotes: evidence.filter(e => e.hits.length).map(e => ({ keyword: e.hits.join('、'), quote: e.quote, location: e.location, score: e.score, context: e.context })),
      production_quotes: evidence.filter(e => e.score > 0).map(e => e.quote) },
  };
}
