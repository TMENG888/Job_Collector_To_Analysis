// 智联会话直连适配器（路线1）：
//  使用本机登录助手保存的本人会话 cookie（ui_data/zhaopin_login/cookies.json），
//  对 fe-api.zhaopin.com/c/i/search/positions 做独立 HTTP 深翻页。
//  与匿名公开渠道隔离：只有本模块显式携带 cookie；cookie 不落断点、不入日志。
//  匿名下智联每条件约100条/3页；登录后实测单条件可达 count(约1000)/50页。
import fs from 'node:fs/promises';
import path from 'node:path';
import {parseZhaopinApi,zhaopinJobId} from './zhaopin_api.mjs';
import {normalizeDirectZhaopin} from './direct_zhaopin_adapter.mjs';
import {jsonBodyBytes} from './json_request_body.mjs';

const ENDPOINT = 'https://fe-api.zhaopin.com/c/i/search/positions';
// 刷新端点是智联前端 chunk-common 里的 f=~apiDomain/c/i/refresh-token（运行时替换为 fe-api）。
// 契约：POST JSON body 仅 {rt}，成功 {code:200,data:{at,rt,atExpire,rtExpire,userInfo}}；GET 为 405。
const REFRESH_ENDPOINT = 'https://fe-api.zhaopin.com/c/i/refresh-token';
const refreshLeadMs = 5 * 60 * 1000;
const fail = (message, code='invalid_response') => Object.assign(Error(`智联会话直连：${message}`), {code, stopChannel:true});

export const DEFAULT_COOKIE_FILE = path.resolve(import.meta.dirname, '../ui_data/zhaopin_login/cookies.json');

function toSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  // 兼容两种写法：秒（载荷 atExpire/rtExpire）与毫秒（浏览器 CDP 导出的 expires）。
  return n > 1e12 ? Math.round(n / 1000) : Math.round(n);
}

// 用 rt 静默换新 at/rt，并原子回写本地会话文件。token 值不打印、不入断点、不进日志。
// 返回 {action:'refreshed'|'skipped', updated[], atExpiresAt, rtExpiresAt, userId}。
export async function refreshZhaopinSession({ cookieFile = DEFAULT_COOKIE_FILE, request, force = false, leadMs = refreshLeadMs, now = Date.now } = {}) {
  let saved;
  try { saved = JSON.parse(await fs.readFile(cookieFile, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { action: 'skipped', reason: 'session_file_missing' }; throw error; }
  const cookies = Array.isArray(saved?.cookies) ? saved.cookies : [];
  if (!cookies.length) return { action: 'skipped', reason: 'session_file_empty' };
  const find = name => cookies.find(c => c.name === name && c.value);
  const rt = find('rt')?.value;
  if (!rt) return { action: 'skipped', reason: 'refresh_token_missing' };
  const atCookie = find('at');
  const atExpiresMs = atCookie ? Number(atCookie.expires) * 1000 : 0;
  if (!force && atCookie && atExpiresMs - now() > leadMs) return { action: 'skipped', reason: 'access_token_fresh', atExpiresAt: new Date(atExpiresMs).toISOString() };
  const send = request || (async (url, options) => fetch(url, options));
  let response;
  try {
    response = await send(REFRESH_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        origin: 'https://www.zhaopin.com',
        referer: 'https://www.zhaopin.com/',
        cookie: cookies.map(c => `${c.name}=${c.value}`).join('; '),
      },
      body: jsonBodyBytes({ rt }),
    });
  } catch (error) { throw fail(`刷新会话失败：${error.message}`, 'network_error'); }
  const status = typeof response.status === 'function' ? response.status() : response.status;
  if (status !== 200) throw fail(`刷新会话 HTTP ${status}；请重新运行 zhaopin_login_helper.mjs 人工登录`, status === 401 || status === 403 ? 'access_blocked' : 'http_error');
  let body;
  try { body = JSON.parse(await response.text()); } catch { throw fail('刷新会话返回非 JSON', 'verification_required'); }
  const data = body?.data;
  if (Number(body?.code) !== 200 || !data?.at || !data?.rt) throw fail(`刷新会话被拒绝（code=${body?.code ?? 'unknown'}）；请重新人工登录`, 'session_missing');
  const atExpire = toSeconds(data.atExpire), rtExpire = toSeconds(data.rtExpire);
  const stamp = now();
  const updated = [];
  for (const [name, value, seconds] of [['at', data.at, atExpire], ['rt', data.rt, rtExpire]]) {
    const expires = seconds ? Math.round((stamp + seconds * 1000) / 1000) : -1;
    const existing = cookies.find(c => c.name === name);
    if (existing) { existing.value = value; existing.expires = expires; }
    else cookies.push({ name, value, domain: '.zhaopin.com', path: '/', expires, secure: false, httpOnly: false });
    updated.push(name);
  }
  saved.saved_at = saved.saved_at || null;
  saved.refreshed_at = new Date(stamp).toISOString();
  saved.refresh_source = 'fe-api.zhaopin.com/c/i/refresh-token';
  const temporary = `${cookieFile}.${process.pid}.refresh.tmp`;
  await fs.writeFile(temporary, JSON.stringify(saved, null, 2), 'utf8');
  await fs.rename(temporary, cookieFile);
  return {
    action: 'refreshed', updated,
    atExpiresAt: atExpire ? new Date((stamp + atExpire * 1000)).toISOString() : null,
    rtExpiresAt: rtExpire ? new Date((stamp + rtExpire * 1000)).toISOString() : null,
    userId: data?.userInfo?.userId ?? null,
  };
}

// 读取本人登录会话 cookie；不存在则返回 null（调用方应提示先运行登录助手）。
// refresh=true 时按前提前置换票，避免带着过期 at 打搜索接口换来「验证即停」。
export async function loadZhaopinSession({cookieFile=DEFAULT_COOKIE_FILE, refresh=true, request=null}={}) {
  let saved;
  try { saved = JSON.parse(await fs.readFile(cookieFile, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const cookies = Array.isArray(saved?.cookies) ? saved.cookies : [];
  if (!cookies.length) return null;
  if (refresh) {
    try { await refreshZhaopinSession({cookieFile, request, now: Date.now}); }
    catch (error) {
      // 刷新失败不阻断读取：仍用现有 cookie 发一次，由搜索接口的 401/403 决定是否停渠道。
      console.error(`[智联会话] 换票未成功，沿用现有 cookie：${error.message}`);
    }
    const retried = JSON.parse(await fs.readFile(cookieFile, 'utf8'));
    return buildSession({saved: retried, cookieFile});
  }
  return buildSession({saved, cookieFile});
}

function buildSession({saved, cookieFile}) {
  const cookies = Array.isArray(saved?.cookies) ? saved.cookies : [];
  if (!cookies.length) return null;
  const now = Date.now() / 1000;
  const live = cookies.filter(c => !c.expires || c.expires <= 0 || toSeconds(c.expires) > now);
  if (!live.length) return null;
  const cookie = live.map(c => `${c.name}=${c.value}`).join('; ');
  const earliest = live.filter(c => c.expires > 0).map(c => toSeconds(c.expires)).sort((a, b) => a - b)[0];
  return { cookie, cookieFile, savedAt: saved.saved_at || null, refreshedAt: saved.refreshed_at || null, expiresAt: earliest ? new Date(earliest * 1000).toISOString() : null, count: live.length };
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
        'content-type': 'application/json; charset=utf-8',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        cookie: session.cookie,
      },
      body: jsonBodyBytes({ S_SOU_FULL_INDEX: keyword.trim(), S_SOU_WORK_CITY: String(city.code), pageIndex, pageSize, order: 0, platform: 13, version: '0.0.0' }),
    },
  };
}

export async function fetchZhaopinSessionPage(request, keyword, city, pageIndex, session, pageSize=20) {
  const contract = zhaopinSessionRequest(keyword, city, pageIndex, session, pageSize);
  let response;
  try {
    response = await request(contract.url, contract.options);
  } catch (error) {
    // 来源冷却闸门拒绝的是「这一条件此刻的请求」：智联按登录账号计日额度，命中校验后同源全局冷却，
    // 继续硬停整渠道会把其余 44 个条件一起判死，且 retainedChannelErrors 会把结论带到后续轮次。
    // 这里把闸门拒绝降级为条件级让位：其余条件正常各自撞闸门留档，冷却结束后续采同一断点。
    if (error?.code !== 'origin_cooldown') throw error;
    throw Object.assign(
      new Error(`智联来源仍在冷却期，${keyword}/${city.name} 本轮让位：${error.message}`),
      {code: 'origin_cooldown', stopChannel: false, conditionScoped: true},
    );
  }
  const status = typeof response.status === 'function' ? response.status() : response.status;
  if ([401, 403, 429].includes(status)) throw fail(`HTTP ${status}，会话可能失效；请在登录助手重新登录`, 'access_blocked');
  if (status !== 200) throw fail(`HTTP ${status}`, 'http_error');
  let body; try { body = JSON.parse(await response.text()); } catch { throw fail('响应不是有效岗位 JSON', 'verification_required'); }
  // 风控校验页只针对当前关键词/城市条件：记录并让位，不整渠道停采。
  // 旧行为由 polite_http_client 按来源记 900 秒长冷却并抛出 stopChannel，
  // 导致 45 个组合里只要有一个命中就整轮 0 行、且后续轮次被 retainedChannelErrors 永久跳过。
  if ([true, 1, '1', 'true'].includes(body?.data?.isVerification) || [401, 403, 429].includes(Number(body?.data?.statusCode))) {
    // 让位不等于不设防：让位的同时落一次来源级冷却，避免下一条件立刻再撞同一风控窗口。
    const cooldownMs = Math.max(0, Number(process.env.JOB_ZHAOPIN_VERIFICATION_COOLDOWN_MS) || 30 * 60 * 1000);
    try { await request.penalize?.('zhaopin_condition_verification', cooldownMs); } catch { /* 冷却写入失败不影响让位语义 */ }
    throw Object.assign(
      new Error(`智联当前条件触发风控校验（isVerification=${body?.data?.isVerification ?? null}）：${keyword}/${city.name} 已让位，保留断点，来源已冷却 ${Math.round(cooldownMs / 1000)} 秒，其余关键词和城市待冷却结束后续采`),
      {code: 'verification_required', stopChannel: false, conditionScoped: true},
    );
  }
  const parsed = parseZhaopinApi(body, status);
  if (parsed.rows.some(row => !zhaopinJobId(row) || !String(row.name ?? '').trim())) throw fail('岗位缺少稳定 ID 或标题');
  const count = Number(body?.data?.count);
  return { ...parsed, count: Number.isFinite(count) && count > 0 ? count : parsed.total };
}

// 深翻页采集一个关键词/城市条件，直到 count 上限或 endPage。
// 返回与 collect_public_job_platforms 标准化格式一致的行。
export async function collectZhaopinSession(keyword, city, { request, session, maxPages=100, maxRows=Infinity, pageSize=20, startPage=1, seenIds=[], onPage=()=>{}, onProgress=()=>{} } = {}) {
  if (!session?.cookie) throw fail('缺少本人登录会话 cookie；请先运行 zhaopin_login_helper.mjs', 'session_missing');
  // 已知 ID 来自断点：命中不算新增，但绝不能因此判定 «空页» 结束条件。
  // 旧实现每次从 p1 重放并只做行级去重，重复页会吃掉风控额度，且 lowStreak 让位会误杀未完条件。
  const seen = new Set((seenIds || []).map(String).filter(Boolean));
  const rows = [];
  let total = 0, page = Math.max(1, Number(startPage) || 1), endReached = false;
  const pageLimit = Math.max(1, Number(maxPages) || 100), rowLimit = Math.max(1, Number(maxRows) || Infinity);
  for (; page <= pageLimit; page++) {
    const result = await fetchZhaopinSessionPage(request, keyword, city, page, session, pageSize);
    total = result.count || total;
    if (!result.rows.length) { endReached = true; break; }
    let added = 0;
    const newRows = [];
    for (const raw of result.rows) {
      const id = zhaopinJobId(raw);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const item = { raw, id };
      rows.push(item);
      newRows.push(item);
      added++;
      if (seen.size >= rowLimit) break;
    }
    onPage({ page, added, unique: seen.size, total, endPage: result.endPage });
    // 逐页回写进度：风控打断也不会丢掉已翻到的页面，下次从 nextPage 继续。
    // 只回传本页新增行：全量回传会让 100 页条件出现 O(n²) 的重复标准化与重写。
    await onProgress({ page, nextPage: page + 1, total, rows: newRows.map(({ raw }) => normalizeDirectZhaopin(raw, keyword, city.name, total, new Date().toISOString(), 'session_json_api')).map(r => ({ ...r, acquisition_mode: 'session_json_api', access_level: '本人登录会话 HTTP 直连岗位搜索接口' })) });
    if (seen.size >= rowLimit) break;
    if (result.endPage) { endReached = true; break; }
    if (added === 0 && page > 1 && seen.size === 0) { endReached = true; break; }
  }
  // 页码耗尽（例如 maxPages 上限）与真正翻到末页必须区分：前者标记为翻页受限，
  // 否则断点会把未完成条件写成 completed=true，剩余页永远不再补采。
  const pageLimitReached = !endReached && page > pageLimit;
  const nextPage = endReached ? null : page;
  const collectedAt = new Date().toISOString();
  return {
    total, pagesFetched: page - Math.max(1, Number(startPage) || 1), endReached, pageLimitReached, nextPage,
    rows: rows.map(({ raw }) => normalizeDirectZhaopin(raw, keyword, city.name, total, collectedAt, 'session_json_api')).map(r => ({ ...r, acquisition_mode: 'session_json_api', access_level: '本人登录会话 HTTP 直连岗位搜索接口' })),
  };
}
