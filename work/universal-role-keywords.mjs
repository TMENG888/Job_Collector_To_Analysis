import { dutiesOf, extractKeywords } from './keyword-role-matcher.mjs';
import { strictRuleSeed, ruleProductionEvidence, titleExcluded } from './rule-seed-keywords.mjs';

const clean = value => String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
const quoteFor = (body, term) => body.split(/[\n。；;]/).find(line => clean(line).includes(clean(term))) || '';

// One extraction/matching contract for built-in and literal custom roles.
// Titles create seeds; neither titles, search queries nor fixed technical terms admit rows.
export function learnUniversalRoleKeywords(rows, family, settings = {}) {
  const algorithm = settings.algorithm || 'tfidf';
  if (!['tfidf', 'textrank', 'contrast', 'fusion'].includes(algorithm)) throw new Error('不支持的岗位关键词算法');
  const topK = settings.top_k ?? 40;
  const minimumHits = settings.minimum_hits ?? 2;
  if (!Number.isInteger(topK) || topK < 5 || topK > 100 || !Number.isInteger(minimumHits) || minimumHits < 1 || minimumHits > 5) throw new Error('岗位关键词参数无效');
  const drama = family.name === 'AI漫剧创作';
  const seedPredicate = row => drama ? strictRuleSeed(row) : family.title.test(String(row['岗位名称'] || ''));
  const candidates = rows.filter(seedPredicate);
  const seen = new Set();
  const seeds = candidates.filter(row => {
    const body = clean(dutiesOf(row));
    if (!body || seen.has(body)) return false;
    seen.add(body); return true;
  });
  if (seeds.length < 5) throw new Error(`“${family.name}”仅有 ${seeds.length} 条独立标题/职责种子，至少需要5条才能学习关键词；未回退到技术词直接纳入`);
  const negatives = rows.filter(row => !seedPredicate(row));
  let ranked;
  if (algorithm === 'fusion') {
    const merged = new Map();
    for (const method of ['tfidf', 'textrank']) extractKeywords(seeds, rows, negatives, method, 100).forEach((term, index) => {
      const entry = merged.get(term.term) || { ...term, score: 0 };
      entry.score += 1 / (61 + index); merged.set(term.term, entry);
    });
    ranked = [...merged.values()].sort((a, b) => b.score - a.score);
  } else ranked = extractKeywords(seeds, rows, negatives, algorithm, 100);
  const keywords = ranked.map(term => ({ ...term,
    lift: (term.seed_df / seeds.length) / (term.background_df / rows.length),
  })).filter(term => term.seed_df >= Math.max(2, Math.ceil(seeds.length * 0.02)) && term.lift >= 2.5).slice(0, topK);
  if (keywords.length < minimumHits) throw new Error(`“${family.name}”区分性关键词不足，无法执行统一关键词筛选；请补充目标标题种子或复核岗位名称`);
  const names = { tfidf: 'TF-IDF', textrank: 'TextRank', contrast: '对比关键词', fusion: 'TF-IDF/TextRank融合' };
  return { version: 'universal-role-keywords-v1', family: family.name, algorithm,
    display_name: `统一岗位关键词＋${names[algorithm]}`, keywords, minimum_hits: minimumHits,
    training_seed_rows: seeds.map(row => row.row_no), rule_seed_candidates: candidates.length,
    training_background_rows: rows.length, cold_start: false,
    seed_source: '目标标题种子，按职责正文去重；查询词和外部标签不参与提词',
    scope: family.name, require_production: drama,
    selection_policy: '所有记录（含标题种子）须命中至少两个独立学习关键词；过滤通用招聘词，词的种子/整体出现率比至少2.5；仅检查职责正文；无固定技术词或标题直通，外部标签仅补充属性；这是无监督启发式，未经人工准确率验证',
  };
}

export function matchUniversalRoleKeywords(row, model) {
  const body = dutiesOf(row);
  const source = clean(body);
  const hits = model.keywords.filter(term => source.includes(clean(term.term)));
  const independent = hits.filter(term => !hits.some(other => other.term !== term.term && clean(other.term).includes(clean(term.term))));
  const production = model.require_production ? ruleProductionEvidence(row) : [];
  const matched = independent.length >= model.minimum_hits && (!model.require_production || production.length > 0 && !titleExcluded(row));
  return { matched, method: `学习关键词匹配：${model.display_name}`, confidence_band: matched ? '待复核' : '排除',
    reasons: [matched ? '职责正文命中独立学习关键词' : '独立学习关键词或职责证据不足'],
    topic_matches: independent.map(term => term.term),
    keyword_evidence: { hits: independent.map(term => term.term), rule_seed: false, algorithm: model.algorithm, model_version: model.version,
      quotes: independent.map(term => ({ keyword: term.term, quote: quoteFor(body, term.term) })), production_quotes: production.slice(0, 3) },
    joint_evidence: null,
  };
}
