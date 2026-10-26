// 采集清单维护：清掉已被修复的历史渠道级错误，避免陈旧 stopChannel 永久污染清单与退出码。
import fs from 'node:fs/promises';
import path from 'node:path';

const outputDir = process.argv[2];
const mode = process.argv[3] || 'inspect';
if (!outputDir) throw Error('用法：node patch_manifest_errors.mjs <outputDir> [inspect|clear-stale]');

const manifestPath = path.join(outputDir, '采集清单.json');
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));

// 已修复的历史阻塞：
// ① 白名单越界（配置指错文件）：不再可能发生，属历史记录。
// ② 一次性内存暂停：资源已释放，不属当前渠道状态。
// ③ 来源冷却闸门整渠道停采：已改为条件级让位（stopChannel=false），旧记录写的是 stopChannel=true。
const stalePatterns = [
  /采集轮次条件超出已配置关键词或城市，拒绝启动/,
  /系统可提交内存不足/,
  /该站点处于跨任务冷却期/,
];
const isStale = entry => entry && stalePatterns.some(pattern => pattern.test(String(entry.error || '')));
const resolveReason = entry => /该站点处于跨任务冷却期/.test(String(entry.error || ''))
  ? '原实现把来源冷却写成整渠道停采；现改为条件级让位（stopChannel=false, conditionScoped=true）'
  : '对应缺陷已在 work/ 侧修复；本条为历史阻塞记录';

let changed = 0;
for (const [platform, channel] of Object.entries(manifest.platforms || {})) {
  const errors = Array.isArray(channel.errors) ? channel.errors : [];
  if (mode === 'inspect') {
    console.log(`${platform}: rows=${channel.rows} errors=${errors.length}`);
    for (const entry of errors) {
      console.log(`  - ${entry.keyword || '(渠道级)'}/${entry.city?.name || '-'} code=${entry.code} stopChannel=${entry.stopChannel === true} stale=${isStale(entry)}`);
    }
    continue;
  }
  const kept = errors.filter(entry => !isStale(entry));
  if (kept.length !== errors.length) {
    changed += errors.length - kept.length;
    channel.errors = kept;
    channel.resolvedErrors = [...(channel.resolvedErrors || []), ...errors.filter(isStale).map(entry => ({
      code: entry.code,
      keyword: entry.keyword || null,
      city: entry.city || null,
      stopChannel: entry.stopChannel === true,
      resolved_reason: resolveReason(entry),
      resolved_at: new Date().toISOString(),
    }))];
  }
}

if (mode === 'inspect') {
  console.log('（inspect 模式：未修改文件）');
} else {
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`已清理 ${changed} 条历史阻塞错误，其余保留：${manifestPath}`);
}