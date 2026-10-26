// 只读：探明 checkpoint 的真实结构（不假设 rows 是扁平数组），并给出正确口径。
import fs from 'node:fs';
import path from 'node:path';

const cpPath = 'D:\\岗位采集数据\\任务数据\\1792837186878-爬虫岗位采集\\牛客岗位数据\\nowcoder.jobs.checkpoint.json';
const raw = JSON.parse(fs.readFileSync(cpPath, 'utf8').replace(/^\ufeff/, ''));
console.log('顶层键 = ' + Object.keys(raw).join(', '));
for (const k of Object.keys(raw)) {
  const v = raw[k];
  const kind = Array.isArray(v) ? `Array(${v.length})` : v === null ? 'null' : typeof v;
  let extra = '';
  if (Array.isArray(v) && v.length) extra = ' 首元素键=' + Object.keys(v[0] || {}).slice(0, 12).join(',');
  else if (v && typeof v === 'object') extra = ' 子键数=' + Object.keys(v).length;
  else extra = ' 值=' + String(v).slice(0, 60);
  console.log(`  ${k}: ${kind}${extra}`);
}

// rows 若是对象数组但无 id 字段，逐字段找真正的标识列
const rows = raw.rows;
if (Array.isArray(rows) && rows.length) {
  const keys = Object.keys(rows[0] || {});
  console.log('');
  console.log('rows[0] 全部键 = ' + keys.join(', '));
  const idLike = keys.filter(k => /(^|_)id$|job_id|source_id|external/i.test(k));
  console.log('疑似标识列 = ' + (idLike.length ? idLike.join(', ') : '(无)'));
  for (const k of idLike) {
    const vals = rows.map(r => r && r[k]);
    const nonEmpty = vals.filter(v => v !== undefined && v !== null && v !== '').length;
    console.log(`  ${k}: 非空 ${nonEmpty}/${rows.length}  样例=${vals.filter(Boolean).slice(0, 3).join(',')}`);
  }
  // 反向：rows 里是否有完成状态（说明 rows 键被当成条件状态表用）
  const statusLike = keys.filter(k => /complet|reason|scan|nextPage|totalPage|signatures|refFirst/i.test(k));
  console.log('疑似状态列 = ' + (statusLike.length ? statusLike.join(', ') : '(无)'));
  if (statusLike.length) {
    console.log('  样例=' + JSON.stringify(rows[0]).slice(0, 300));
  }
}
// 条件状态表在哪
for (const k of Object.keys(raw)) {
  const v = raw[k];
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const first = Object.entries(v)[0];
    if (first) console.log('');
    if (first) console.log(`条件表候选 ${k}: 首项键=${first[0]} 值键=${Object.keys(first[1] || {}).join(',')}`);
  }
}