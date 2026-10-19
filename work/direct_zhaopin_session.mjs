// 智联会话直连适配器（路线1）：
//  使用本机登录助手保存的本人会话 cookie（ui_data/zhaopin_login/cookies.json），
//  对 fe-api.zhaopin.com/c/i/search/positions 做独立 HTTP 深翻页。
//  与匿名公开渠道隔离：只有本模块显式携带 cookie；cookie 不落断点、不入日志。
//  匿名下智联每条件约100条/3页；登录后实测单条件可达 count(约1000)/50页。
import fs from 'node:fs/promises';
import path from 'node:path';
import {parseZhaopinApi,zhaopinJobId} from './zhaopin_api.mjs';
import {normalizeDirectZhaopin} from './direct_zhaopin_adapter.mjs';

const ENDPOINT = 'https://fe-api.zhaopin.com/c/i/search/positions';
const fail = (message, code='invalid_response') => Object.assign(Error(`智联会话直连：${message}`), {code, stopChannel:true});

export const DEFAULT_COOKIE_FILE = path.resolve(import.meta.dirname, '../ui_data/zhaopin_login/cookies.json');

// 读取本人登录会话 cookie；不存在则返回 null（调用方应提示先运行登录助手）。
export async function loadZhaopinSession({cookieFile=DEFAULT_COOKIE_FILE}={}) {
  let saved;
  try { saved = JSON.parse(await fs.readFile(cookieFile, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const cookies = Array.isArray(saved?.cookies) ? saved.cookies : [];
  if (!cookies.length) return null;
  const now = Date.now() / 1000;
  const live = cookies.filter(c => !c.expires || c.expires <= 0 || c.expires > now);
  if (!live.length) return null;
  const cookie = live.map(c => `${c.name}=${c.value}`).join('; ');
  const earliest = live.filter(c => c.expires > 0).map(c => c.expires).sort((a, b) => a - b)[0];
  return { cookie, cookieFile, savedAt: saved.saved_at || null, expiresAt: earliest ? new Date(earliest * 1000).toISOString() : null, count: live.length };
}

// 单页请求契约：普通搜索字段 + 本人会话 cookie。不复制浏览器指纹/token 到断点。
export function zhaopinSessionRequest(keyword, city, pageIndex, session, pageSize=20) {
  if (!session?.cookie) throw fail('缺少本人登录会话 cookie；请先运行 zhaopin_login_helper.mjs', 'session_missing');
  if (typeof keyword !== 'string' || !keyword.trim()) throw fail('关键词无效', 'invalid_config');
  if (!city?.name || !/^\d{1,8}$/.test(String(city.code))) throw fail('城市代码无效', 'invalid_config');
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 1) throw fail('页码无效', 'invalid_config');
  return {
    url: ENDPOINT,
    options: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        cookie: session.cookie,
      },
      body: JSON.stringify({ S_SOU_FULL_INDEX: keyword.trim(), S_SOU_WORK_CITY: String(city.code), pageIndex, pageSize, order: 0, platform: 13, version: '0.0.0' }),
    },
  };
}

export async function fetchZhaopinSessionPage(request, keyword, city, pageIndex, session, pageSize=20) {
  const contract = zhaopinSessionRequest(keyword, city, pageIndex, session, pageSize);
  const response = await request(contract.url, contract.options);
  const status = typeof response.status === 'function' ? response.status() : response.status;
  if ([401, 403, 429].includes(status)) throw fail(`HTTP ${status}，会话可能失效；请在登录助手重新登录`, 'access_blocked');
  if (status !== 200) throw fail(`HTTP ${status}`, 'http_error');
  let body; try { body = JSON.parse(await response.text()); } catch { throw fail('响应不是有效岗位 JSON', 'verification_required'); }
  const parsed = parseZhaopinApi(body, status);
  if (parsed.rows.some(row => !zhaopinJobId(row) || !String(row.name ?? '').trim())) throw fail('岗位缺少稳定 ID 或标题');
  const count = Number(body?.data?.count);
  return { ...parsed, count: Number.isFinite(count) && count > 0 ? count : parsed.total };
}

// 深翻页采集一个关键词/城市条件，直到 count 上限或 endPage。
// 返回与 collect_public_job_platforms 标准化格式一致的行。
export async function collectZhaopinSession(keyword, city, { request, session, maxPages=100, maxRows=Infinity, pageSize=20, onPage=()=>{} } = {}) {
  if (!session?.cookie) throw fail('缺少本人登录会话 cookie；请先运行 zhaopin_login_helper.mjs', 'session_missing');
  const seen = new Set();
  const rows = [];
  let total = 0, page = 1, endReached = false;
  const pageLimit = Math.max(1, Number(maxPages) || 100), rowLimit = Math.max(1, Number(maxRows) || Infinity);
  for (; page <= pageLimit; page++) {
    const result = await fetchZhaopinSessionPage(request, keyword, city, page, session, pageSize);
    total = result.count || total;
    if (!result.rows.length) { endReached = true; break; }
    let added = 0;
    for (const raw of result.rows) {
      const id = zhaopinJobId(raw);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      rows.push({ raw, id });
      added++;
      if (seen.size >= rowLimit) break;
    }
    onPage({ page, added, unique: seen.size, total, endPage: result.endPage });
    if (seen.size >= rowLimit) break;
    if (result.endPage) { endReached = true; break; }
    if (added === 0 && page > 1) { endReached = true; break; }
  }
  const collectedAt = new Date().toISOString();
  return {
    total, pagesFetched: page - 1, endReached,
    rows: rows.map(({ raw }) => normalizeDirectZhaopin(raw, keyword, city.name, total, collectedAt, 'session_json_api')).map(r => ({ ...r, acquisition_mode: 'session_json_api', access_level: '本人登录会话 HTTP 直连岗位搜索接口' })),
  };
}