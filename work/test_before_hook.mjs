// 定位：为什么同一请求里 burst 计数会被读回 0。
import path from 'node:path';
import { boundedFetch } from './collection_policy.mjs';

const calls = [];
const wait = async ms => { calls.push(['wait', ms]); };
const res = async () => new Response(JSON.stringify({ ok: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });

await boundedFetch('https://fe-api.zhaopin.com/c/i/search/positions', { method: 'POST', body: '{}', redirect: 'manual' }, {
  attempts: 1, timeoutMs: 20000, wait,
  before: async () => { calls.push(['before', Date.now()]); },
  fetchImpl: async () => { calls.push(['fetch']); return res(); },
});
console.log(`boundedFetch 调用序列: ${JSON.stringify(calls)}`);