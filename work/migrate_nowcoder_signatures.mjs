// 把牛客岗位断点里旧的字符串签名（signatures:["hex",...]）迁移成 {scan,hash} 结构，
// 并补齐 scanSeq / refFirst / refAt，使「保鲜期重开」不再被去重护栏误杀、且重开复检只花 1 次请求。
// 只动 signatures 形态与新增字段，不碰 rows / nextPage / completed / completedAt。
// 用法：node work\migrate_nowcoder_signatures.mjs <checkpoint.json> [--apply]
import fs from 'node:fs';

const file = process.argv[2];
const apply = process.argv.includes('--apply');
if (!file) throw Error('用法：node migrate_nowcoder_signatures.mjs <checkpoint.json> [--apply]');
if (!fs.existsSync(file)) throw Error(`断点文件不存在：${file}`);

const raw = fs.readFileSync(file, 'utf8').replace(/^\ufeff/, '');
const state = JSON.parse(raw);
const queries = state.queries || {};

let migrated = 0;
let already = 0;
const detail = [];
for (const [key, q] of Object.entries(queries)) {
  if (!q || typeof q !== 'object') continue;
  const sigs = Array.isArray(q.signatures) ? q.signatures : [];
  const strings = sigs.filter(x => typeof x === 'string');
  const objects = sigs.filter(x => x && typeof x === 'object');
  const scan = Number(q.scanSeq) > 0 ? Number(q.scanSeq) : 1;
  if (!strings.length && objects.length === sigs.length && sigs.length === sigs.filter(x => x && x.scan === scan).length) {
    already++;
  } else {
    migrated++;
  }
  // 旧字符串签名归属到 scan=1（历史轮），当前轮次从 scan 起生效；
  // 只有当历史轮次就是当前轮次时才复用其第 1 条作为 refFirst。
  const old = strings.map(h => ({ scan: 1, hash: h }));
  const cur = objects.filter(x => x.scan === scan);
  q.scanSeq = scan;
  q.signatures = [...old, ...objects].slice(-200);
  if (!q.refFirst && cur.length) q.refFirst = cur[0].hash;
  if (q.completed === true && !q.refAt) q.refAt = q.completedAt || null;
  detail.push({
    key,
    completed: q.completed === true,
    pages: q.pages ?? 0,
    oldStringSigs: strings.length,
    objectSigs: objects.length,
    refFirst: q.refFirst ? `${q.refFirst.slice(0, 12)}…` : null,
  });
}

console.log(`查询条件总数=${detail.length}  需迁移=${migrated}  已是新格式=${already}`);
console.log('前 8 条明细:');
for (const row of detail.slice(0, 8)) {
  console.log(`  ${row.key} completed=${row.completed} pages=${row.pages} 旧签名=${row.oldStringSigs} 新签名=${row.objectSigs} refFirst=${row.refFirst}`);
}
const missingRef = detail.filter(r => r.completed && !r.refFirst).length;
console.log(`已完成但缺 refFirst 的条件=${missingRef}（这些条件的首次重开会走正常全量重扫，之后自行补上引用）`);
console.log(`rows=${state.rows?.length ?? 0}`);

if (!apply) {
  console.log('（演练模式，未写入；加 --apply 落地）');
  process.exit(0);
}
const backup = `${file}.sig-${Date.now()}.bak`;
fs.copyFileSync(file, backup);
fs.writeFileSync(file, JSON.stringify(state), 'utf8');
console.log(`已写入 ${file}`);
console.log(`备份 ${backup}`);