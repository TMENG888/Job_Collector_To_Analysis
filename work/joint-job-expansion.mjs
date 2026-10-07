const textOf = (row) => [row['岗位名称'], row['技能'], row['岗位描述']].map((value) => String(value || '')).join('\n');
const evidence = (source, regex) => {
  const match = source.match(regex);
  return match ? { keyword: match[0], quote: source.slice(Math.max(0, match.index - 30), match.index + match[0].length + 65) } : null;
};

export function learnJointExpansion(rows, { isSeed, skills, tasks, familyName }) {
  const seeds = rows.filter(isSeed);
  const learn = (rules, minimumRate, minimumLift) => rules.map(([name, regex]) => {
    const seedCount = seeds.filter((row) => regex.test(textOf(row))).length;
    const totalCount = rows.filter((row) => regex.test(textOf(row))).length;
    const seedRate = seedCount / Math.max(1, seeds.length);
    const globalRate = totalCount / Math.max(1, rows.length);
    return { name, regex, seed_count: seedCount, total_count: totalCount, seed_rate: Number(seedRate.toFixed(3)), lift: Number((seedRate / Math.max(globalRate, 1 / Math.max(1, rows.length))).toFixed(2)) };
  }).filter((term) => term.seed_count >= Math.max(2, Math.ceil(seeds.length * minimumRate)) && term.seed_rate >= minimumRate && term.lift >= minimumLift).sort((a, b) => b.seed_count - a.seed_count);
  // A shared tool need not distinguish the role by itself. The independent
  // business/task signal must be distinctive; a tool alone never admits a row.
  return { seed_rows: seeds.length, familyName, skills: seeds.length >= 5 ? learn(skills, 0.03, 0) : [], tasks: seeds.length >= 5 ? learn(tasks, 0.08, 1.5) : [] };
}

export function matchJointExpansion(row, model) {
  const source = textOf(row);
  const title = String(row['岗位名称'] || '');
  // A creative-domain tool and a referenced production use case are not enough
  // to turn an algorithm/backend/operations job into a creative production job.
  if (model.familyName === 'AI漫剧创作') {
    if (/算法|后端|运维|架构|研发|评测|测试|软件开发|售前|销售|数据治理|办公|解决方案|IT专员|技术组长|技术主管|技术总监|数据库|\bUI\b|\bUX\b|交互|平面|产品设计/i.test(title) && !/剪辑|制作|导演|编导|画师|内容创作/.test(title)) return null;
    if (/开发|工程师|产品/.test(title) && !/影视|视频|动画|短剧|漫画|剪辑|导演|编导|创作|制作/.test(title)) return null;
  }
  const find = (terms) => terms.flatMap((term) => {
    const hit = evidence(source, term.regex);
    return hit ? [{ name: term.name, ...hit }] : [];
  });
  const skills = find(model.skills), tasks = find(model.tasks);
  if (!skills.length || !tasks.length) return null;
  return { matched: true, method: '种子学习：技能与业务职责联合匹配', confidence_band: '中', reasons: ['目标岗位种子中的区分性技能', '目标业务职责共同命中'], topic_matches: [...skills.map((item) => item.name), ...tasks.map((item) => item.name)], joint_evidence: { skills, tasks } };
}

export function publicJointExpansion(model) {
  const serialize = (terms) => terms.map(({ regex, ...term }) => term);
  return { seed_rows: model.seed_rows, skill_terms: serialize(model.skills), task_terms: serialize(model.tasks), minimum_seed_rows: 5, skill_minimum_seed_rate: 0.03, task_minimum_lift: 1.5, policy: '技能与独立业务职责共同命中；共享工具无需单独有区分度，业务职责须有区分度；匹配岗位直接合并进入全部洞察统计；不使用检索词作为纳入证据' };
}
