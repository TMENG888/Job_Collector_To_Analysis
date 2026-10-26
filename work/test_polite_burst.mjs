// 突发节流与来源冷却的离线自检：不发起任何真实网络请求。
import fs from 'node:fs/promises';
import path from 'node:path';
import { createPoliteHttpClient } from './polite_http_client.mjs';

const stateDir = path.resolve(import.meta.dirname, '../tmp/zp_burst_probe');
await fs.rm(stateDir, { recursive: true, force: true });
const waits = [];
let clock = Date.parse('2026-10-25T14:00:00.000Z');
const request = createPoliteHttpClient({
  stateDir,
  minimumIntervalMs: 0,
  jitterMs: 0,
  attempts: 1,
  burstSize: 3,
  burstRecoveryMs: 900000,
  now: () => clock,
  wait: async ms => { waits.push(ms); clock += ms; },
  random: () => 0,
  fetchImpl: async () => new Response(JSON.stringify({ code: 200, data: { count: 1, list: [{ id: 'x' }], isEndPage: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } }),
});

for (let i = 1; i <= 3; i++) {
  await request('https://fe-api.zhaopin.com/c/i/search/positions', { method: 'POST', body: '{}' });
}
await request('https://fe-api.zhaopin.com/c/i/search/positions', { method: 'POST', body: '{}' });
const restMs = waits.filter(ms => ms >= 900000).pop();
console.log(`突发休息毫秒: ${restMs === undefined ? '未触发' : restMs}`);

const until = await request.penalize('zhaopin_condition_verification', 1800000);
console.log(`来源冷却写入: ${new Date(until).toISOString()}`);
const stateFile = (await fs.readdir(stateDir)).find(name => name.endsWith('.json') && name.startsWith('83b63a0eea4ef9438f1b15fe'));
console.log(`冷却状态文件: ${stateFile}`);
let blocked = '';
try { await request('https://fe-api.zhaopin.com/c/i/search/positions', { method: 'POST', body: '{}' }); }
catch (error) { blocked = `${error.code}`; }
console.log(`冷却期内请求被拒: ${blocked}`);
await fs.rm(stateDir, { recursive: true, force: true });