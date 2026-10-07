const normalized = (value) => String(value || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function literalRoleFamily(label) {
  const name = String(label || '').trim();
  // Literal user input, never executable regex. Allow spacing/case variations only.
  const expression = [...name.normalize('NFKC').replace(/\s+/g, '')].map(escaped).join('\\s*');
  if (!expression) throw new Error('手工岗位名称不能为空');
  const matcher = new RegExp(expression, 'i');
  return { name, custom: true, filename: matcher, query: matcher, title: matcher, content: matcher };
}

export function selectManualRole(families, label) {
  if (!String(label || '').trim() || /^(自动|自动识别|auto)$/i.test(String(label).trim())) return null;
  const exact = families.find((family) => normalized(family.name) === normalized(label));
  if (exact) return exact;
  const ranked = families.map((family) => ({ family, score: (family.strict || family.name === '通用软件开发') && !family.filename.test(label) && !family.query.test(label) ? 0 : (family.filename.test(label) ? 3 : 0) + (family.query.test(label) ? 2 : 0) + (family.title.test(label) ? 2 : 0) })).sort((a, b) => b.score - a.score);
  return ranked[0]?.score ? ranked[0].family : literalRoleFamily(label);
}
