// 智联换票链路验证：rt 换 at（/c/i/refresh-token）→ 回写 cookies.json → 用新 at 打搜索接口。
// 输出只打印时间戳与状态，不打印任何 token 值。
import fs from 'node:fs/promises';
import {loadZhaopinSession, refreshZhaopinSession, collectZhaopinSession, DEFAULT_COOKIE_FILE} from './direct_zhaopin_session.mjs';
import {createPoliteHttpClient} from './polite_http_client.mjs';
import {collectionTransportPolicy} from './channel_acquisition.mjs';

const cookieFile = DEFAULT_COOKIE_FILE;
const before = JSON.parse(await fs.readFile(cookieFile, 'utf8'));
const beforeAt = before.cookies.find(c => c.name === 'at');
console.log(`[换票前] at 过期时间=${beforeAt ? new Date(Number(beforeAt.expires) * 1000).toISOString() : 'missing'}；refreshed_at=${before.refreshed_at || '从未刷新'}`);

const refreshed = await refreshZhaopinSession({cookieFile, force: true});
console.log(`[换票] action=${refreshed.action} updated=${(refreshed.updated || []).join(',')} atExpiresAt=${refreshed.atExpiresAt} rtExpiresAt=${refreshed.rtExpiresAt} userId=${refreshed.userId}`);

const session = await loadZhaopinSession({cookieFile});
console.log(`[会话] cookie 条数=${session?.count} 最早过期=${session?.expiresAt} refreshedAt=${session?.refreshedAt}`);

const request = createPoliteHttpClient({
  stateDir: process.env.JOB_HTTP_RATE_DIR || new URL('../ui_data/http_rate_limits', import.meta.url).pathname.replace(/^\//, ''),
  minimumIntervalMs: collectionTransportPolicy.minimumIntervalMs,
  jitterMs: 400,
  attempts: 2,
});
const result = await collectZhaopinSession('爬虫', {name: '广州', code: '763'}, {request, session, maxPages: 5, pageSize: 20, onPage: e => console.log(`[搜索] p${e.page} +${e.added} 累计${e.unique} total=${e.total} endPage=${e.endPage}`)});
console.log(`[结果] 行=${result.rows.length} 取页=${result.pagesFetched} 站点count=${result.total} endReached=${result.endReached}`);
const sample = result.rows[0];
if (sample) console.log(`[样本] ${JSON.stringify({title: sample.title, company: sample.company, city: sample.city_list || sample.city, salary: sample.salary, url: sample.job_url, mode: sample.acquisition_mode})}`);