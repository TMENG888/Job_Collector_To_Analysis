// 打印渠道清单的关键状态：行数、阻塞级错误、条件级让位，用于判断下一轮能否启动。
// 用法：node inspect_channel_manifest.mjs <outputDir> [platform]
import fs from 'node:fs/promises';
import path from 'node:path';

const [outputDir, only] = process.argv.slice(2);
if (!outputDir) throw Error('用法：node inspect_channel_manifest.mjs <outputDir> [platform]');
const manifest = JSON.parse(await fs.readFile(path.join(outputDir, '采集清单.json'), 'utf8'));
const isConditionScoped = code => ['pagination_stalled', 'legacy_pagination_unverified', 'empty_unverified'].includes(code);

console.log(`任务: ${manifest.task_id}  更新: ${manifest.updated_at || '-'}  总行数: ${manifest.total_rows ?? '-'}`);
for (const [platform, entry] of Object.entries(manifest.platforms || {})) {
  if (only && platform !== only) continue;
  const errors = entry.errors || [];
  const blocking = errors.filter(e => e.stopChannel && e.code !== 'RESOURCE_PRESSURE');
  const scoped = errors.filter(e => e.conditionScoped || isConditionScoped(e.code));
  console.log(`\n[${platform}] rows=${entry.rows} errors=${errors.length} 阻塞=${blocking.length} 条件级=${scoped.length} scheduling=${entry.scheduling?.reason || '-'}`);
  const byCode = new Map();
  for (const e of errors) {
    const key = `${e.code}|stop=${Boolean(e.stopChannel)}|scoped=${Boolean(e.conditionScoped)}`;
    byCode.set(key, (byCode.get(key) || 0) + 1);
  }
  for (const [key, n] of byCode) console.log(`    ${key}  ×${n}`);
  for (const e of blocking.slice(0, 3)) console.log(`    阻塞样例: ${e.keyword || '-'}/${e.city?.name || '-'} → ${String(e.error).split('\n')[0].slice(0, 140)}`);
}