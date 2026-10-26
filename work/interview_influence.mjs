const METRICS = Object.freeze([
  Object.freeze({ field: 'view_count', weight: 0.15, anchor: 1000 }),
  Object.freeze({ field: 'like_count', weight: 0.2, anchor: 20 }),
  Object.freeze({ field: 'collect_count', weight: 0.4, anchor: 20 }),
  Object.freeze({ field: 'total_comment_count', weight: 0.25, anchor: 10 })
]);

function roleOf(row) {
  return typeof row.role_key === 'string' ? row.role_key.normalize('NFKC').trim() : '';
}

function countOf(value) {
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) value = Number(value.trim());
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function timeOf(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') return Number.isFinite(value) && Math.abs(value) <= 8.64e15 ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:T|\s|$)/.exec(value.trim());
  if (!iso) return null;
  const date = new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
  if (date.getUTCFullYear() !== Number(iso[1]) || date.getUTCMonth() !== Number(iso[2]) - 1 || date.getUTCDate() !== Number(iso[3])) return null;
  const result = Date.parse(value.trim());
  return Number.isFinite(result) ? result : null;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function identity(row) {
  return [row.post_id ?? row.id ?? '', row.url ?? row.post_url ?? '', row.title ?? '', row.created_at ?? ''].map(String).join('\u0000');
}

function round(value, digits = 6) {
  return value === null ? null : Number(value.toFixed(digits));
}

export function analyzeInterviewPosts(posts, { now = new Date(), halfLifeDays = 180, roleKey } = {}) {
  if (!Array.isArray(posts) || posts.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new TypeError('posts must be an array of objects');
  const nowMs = timeOf(now);
  if (nowMs === null) throw new TypeError('now must be a valid Date, ISO date, or epoch milliseconds');
  if (typeof halfLifeDays !== 'number' || !Number.isFinite(halfLifeDays) || halfLifeDays <= 0 || halfLifeDays > 36500) throw new RangeError('halfLifeDays must be greater than zero and no greater than 36500');
  if (roleKey !== undefined && (typeof roleKey !== 'string' || !roleKey.trim())) throw new TypeError('roleKey must be a nonempty string');
  const filterRole = roleKey?.normalize('NFKC').trim();
  const selected = filterRole === undefined ? posts : posts.filter(row => roleOf(row) === filterRole);
  const cohorts = new Map();
  const rows = selected.map(row => {
    const role = roleOf(row);
    const counts = Object.fromEntries(METRICS.map(metric => {
      const key = { view_count: 'views', like_count: 'likes', collect_count: 'favorites', total_comment_count: 'comments' }[metric.field];
      const value = row.metrics && typeof row.metrics === 'object' ? row.metrics[key] : metric.field === 'total_comment_count' && (row[metric.field] === undefined || row[metric.field] === null) ? row.comment_count : row[metric.field];
      return [metric.field, countOf(value)];
    }));
    const missingMetrics = METRICS.filter(metric => counts[metric.field] === null).map(metric => metric.field);
    const coverage = METRICS.reduce((total, metric) => total + (counts[metric.field] === null ? 0 : metric.weight), 0);
    const created = timeOf(row.created_at);
    const exclusionReasons = [];
    if (!role) exclusionReasons.push('missing-role');
    if (created === null) exclusionReasons.push(row.created_at === undefined || row.created_at === null || row.created_at === '' ? 'missing-date' : 'invalid-date');
    if (created !== null && created > nowMs) exclusionReasons.push('future-date');
    if (!coverage) exclusionReasons.push('missing-all-metrics');
    const ageDays = created === null || created > nowMs ? null : (nowMs - created) / 86400000;
    const result = {
      ...row,
      influence: {
        score: null, rank: null, relativeWeight: null, engagementScore: null, ageDays: round(ageDays),
        version: 'interview-influence-v1', halfLifeDays,
        weights: { views: 0.15, likes: 0.2, favorites: 0.4, comments: 0.25 },
        timeDecay: ageDays === null ? null : 2 ** (-ageDays / halfLifeDays),
        decay: ageDays === null ? null : round(2 ** (-ageDays / halfLifeDays), 10),
        coverage: round(coverage), metricCount: METRICS.length - missingMetrics.length,
        missingMetrics, metricValues: counts, normalizedMetrics: {},
        eligible: exclusionReasons.length === 0, exclusionReasons, reason: exclusionReasons.length ? exclusionReasons.join(',') : null,
        roleKey: role || null, cohortSize: 0, confidence: 'unavailable',
        provisional: missingMetrics.length > 0, observedAt: new Date(nowMs).toISOString()
      }
    };
    if (result.influence.eligible) {
      if (!cohorts.has(role)) cohorts.set(role, []);
      cohorts.get(role).push(result);
    }
    return result;
  });
  const cohortModels = [];
  for (const [role, group] of cohorts) {
    const scales = Object.fromEntries(METRICS.map(metric => [metric.field, Math.max(Math.log1p(metric.anchor), median(group.filter(row => row.influence.metricValues[metric.field] !== null).map(row => Math.log1p(row.influence.metricValues[metric.field]))))]));
    for (const row of group) {
      let weighted = 0;
      for (const metric of METRICS) {
        const count = row.influence.metricValues[metric.field];
        const normalized = count === null ? null : -Math.expm1(-Math.min(Math.log1p(count) / scales[metric.field], 3));
        row.influence.normalizedMetrics[metric.field] = round(normalized);
        if (normalized !== null) weighted += metric.weight * normalized;
      }
      const engagement = weighted / row.influence.coverage;
      row.influence.engagementScore = round(100 * engagement);
      row.influence.score = 100 * engagement * Math.sqrt(row.influence.coverage) * row.influence.timeDecay;
      row.influence.cohortSize = group.length;
      row.influence.confidence = group.length < 10 ? 'small-cohort' : row.influence.coverage < 1 ? 'partial-metrics' : 'complete-metrics';
      row.influence.provisional ||= group.length < 10;
    }
    const ordered = [...group].sort((a, b) => {
      const difference = b.influence.score - a.influence.score;
      if (difference) return difference;
      const aId = identity(a);
      const bId = identity(b);
      return aId < bId ? -1 : aId > bId ? 1 : 0;
    });
    const totalScore=group.reduce((sum,row)=>sum+row.influence.score,0);
    for(const row of group)row.influence.relativeWeight=totalScore>0?row.influence.score/totalScore:null;
    ordered.forEach((row, index) => { row.influence.rank = index + 1; });
    for (const row of group) {
      row.influence.score = round(row.influence.score);
      row.influence.timeDecay = round(row.influence.timeDecay, 10);
    }
    cohortModels.push({ roleKey: role, eligibleCount: group.length, smallCohort: group.length < 10, logScales: scales });
  }
  return {
    model: {
      id: 'interview-influence-v1', halfLifeDays, now: new Date(nowMs).toISOString(),
      weights: Object.fromEntries(METRICS.map(metric => [metric.field, metric.weight])),
      anchors: Object.fromEntries(METRICS.map(metric => [metric.field, metric.anchor])),
      formula: 's_j=max(log1p(anchor_j),median(log1p(known_count_j))); z_j=1-exp(-min(log1p(count_j)/s_j,3)); C=sum(known_weights); E=sum(known_weight_j*z_j)/C; score=100*E*sqrt(C)*2^(-ageDays/halfLifeDays)',
      interpretation: '可解释的默认业务权重；不是学习得到的真实质量或录用概率。仅限同岗位、同批快照内比较；定向采集不代表全平台排名。',
      missingPolicy: '未知计数保持null，按已知权重计算互动强度并施加覆盖惩罚；缺日期、未来日期、无岗位或全部计数未知时不排名。',
      cohorts: cohortModels, selectedCount: rows.length,
      eligibleCount: rows.filter(row => row.influence.eligible).length,
      excludedCount: rows.filter(row => !row.influence.eligible).length
    },
    rows
  };
}

export function rankInterviewPosts(posts, options = {}) {
  return analyzeInterviewPosts(posts, options).rows.sort((a, b) => {
    const aRole = a.influence.roleKey ?? '';
    const bRole = b.influence.roleKey ?? '';
    if (aRole !== bRole) return aRole < bRole ? -1 : 1;
    const rankDifference = (a.influence.rank ?? Infinity) - (b.influence.rank ?? Infinity);
    if (Number.isFinite(rankDifference) && rankDifference !== 0) return rankDifference;
    if (a.influence.eligible !== b.influence.eligible) return a.influence.eligible ? -1 : 1;
    const aId = identity(a);
    const bId = identity(b);
    return aId < bId ? -1 : aId > bId ? 1 : 0;
  });
}
