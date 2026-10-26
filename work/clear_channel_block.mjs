// 清除渠道的"等待人工处理"阻塞状态。
// 用途：人工完成滑块/登录验证后，复核并解除该渠道的共享阻塞标记，使混合模式采集可放行。
// 用法：
//   node clear_channel_block.mjs job51                 # 仅查看当前状态
//   node clear_channel_block.mjs job51 --confirm       # 人工已处理，清除阻塞
// 安全：只清除“验证/拒绝”阻塞标记，不改动断点、数据或登录会话；不自动重试验证。
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {platformRateOrigins,accessStates} from './browser_fallback_policy.mjs';

const platform = process.argv[2];
const confirm = process.argv.includes('--confirm');
const stateDir = process.env.JOB_HTTP_RATE_DIR || path.resolve(import.meta.dirname, '../ui_data/http_rate_limits');
const key = origin => createHash('sha256').update(origin).digest('hex').slice(0, 24);

if (!platformRateOrigins[platform]) {
  console.error(`未知平台：${platform}。可选：${Object.keys(platformRateOrigins).join('、')}`);
  process.exit(1);
}

let blocked = false;
for (const origin of platformRateOrigins[platform]) {
  const file = path.join(stateDir, key(origin) + '.json');
  const state = await fs.readFile(file, 'utf8').then(JSON.parse).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  if (!state) { console.log(`${origin}: 无状态文件`); continue; }
  const isBlocked = accessStates.has(state.status) && Number(state.cooldownUntil || 0) > 0;
  console.log(`${origin}: status=${state.status ?? '(无)'} cooldownUntil=${state.cooldownUntil ? new Date(state.cooldownUntil).toISOString() : '(无)'}`);
  if (isBlocked) {
    blocked = true;
    if (confirm) {
      const cleaned = { ...state, origin, status: 'human_confirmed', cooldownUntil: 0, human_confirmed_at: new Date().toISOString() };
      await fs.writeFile(file, JSON.stringify(cleaned, null, 2), 'utf8');
      console.log(`  → 已清除阻塞标记（标记为人工已处理）`);
    }
  }
}

if (!blocked) console.log(`\n${platform} 当前无阻塞标记。`);
else if (!confirm) console.log(`\n${platform} 存在阻塞标记。人工完成验证后，用 --confirm 清除。`);
else console.log(`\n${platform} 阻塞已解除，混合模式采集可放行。`);