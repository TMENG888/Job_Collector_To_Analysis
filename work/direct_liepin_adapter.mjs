// 猎聘 HTTP 直连适配器 —— 接口逆向成果（配 cookie 自动刷新 + 模板复用）。
// 逆向要点：
//  - 接口：POST https://api-c.liepin.com/api/com.liepin.searchfront4c.pc-search-job
//  - 请求体：{"data":{"mainSearchPcConditionForm":{key,city,dq,currentPage,pageSize,...},"passThroughForm":{scene,ckId,...}}}
//  - 关键：passThroughForm.ckId 必须为服务器认可的会话级标识（由页面生成，可复用多个请求）
//  - 需完整会话 cookie + x-xsrf-token
//  - 分页：currentPage 递增；响应 data.data.jobCardList；无总数，按页内条数判断末页
// 说明：模板(cookie/ckId)来自本人人工过 IP 验证后的浏览器会话；不模拟滑块、不轮换代理。
import fs from 'node:fs/promises';
import path from 'node:path';

const ENDPOINT = 'https://api-c.liepin.com/api/com.liepin.searchfront4c.pc-search-job';
export const DEFAULT_TEMPLATE_FILE = path.resolve(import.meta.dirname, '../ui_data/liepin_login/session_template.json');
export const DEFAULT_COOKIE_FILE = path.resolve(import.meta.dirname, '../ui_data/liepin_login/cookies.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const fail = (message, code = 'invalid_response') => Object.assign(Error(`猎聘：${message}`), { code, stopChannel: true });

// 读取会话模板（含 cookie 串、x-xsrf-token、ckId）。优先模板文件，回退 cookies.json。
export async function loadLiepinSession({ templateFile = DEFAULT_TEMPLATE_FILE, cookieFile = DEFAULT_COOKIE_FILE } = {}) {
  let template = null;
  try { template = JSON.parse(await fs.readFile(templateFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (template?.cookie) {
    const now = Date.now() / 1000;
    const fresh = !template.expires_at || template.expires_at > now;
    if (fresh) return { cookie: template.cookie, xsrf: template.xsrf || '', ckId: template.ckId || '', savedAt: template.saved_at || null, source: 'template' };
  }
  // 回退：仅 cookies.json（无 ckId 时调用方应重新捕获模板）
  let saved;
  try { saved = JSON.parse(await fs.readFile(cookieFile, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const cookies = Array.isArray(saved?.cookies) ? saved.cookies : [];
  if (!cookies.length) return null;
  const now = Date.now() / 1000;
  const live = cookies.filter(c => !c.expires || c.expires <= 0 || c.expires > now);
  if (!live.length) return null;
  return { cookie: live.map(c => `${c.name}=${c.value}`).join('; '), xsrf: live.find(c => c.name === 'XSRF-TOKEN')?.value || '', ckId: '', savedAt: saved.saved_at || null, source: 'cookies' };
}

export function liepinHeaders(session, { location = 'https://www.liepin.com/zhaopin/' } = {}) {
  return {
    accept: 'application/json, text/plain, */*', 'accept-language': 'zh-CN', 'content-type': 'application/json;charset=UTF-8',
    origin: 'https://www.liepin.com', referer: 'https://www.liepin.com/', 'user-agent': UA, cookie: session.cookie,
    'x-client-type': 'web', 'x-fscp-version': '1.1', 'x-fscp-std-info': '{"client_id": "40108"}',
    'x-requested-with': 'XMLHttpRequest', 'x-xsrf-token': session.xsrf,
    'x-fscp-bi-stat': JSON.stringify({ location }),
  };
}

export function liepinRequestBody(keyword, cityCode, currentPage = 0, pageSize = 40, ckId = '') {
  if (typeof keyword !== 'string' || !keyword.trim()) throw fail('关键词无效', 'invalid_config');
  if (!Number.isSafeInteger(currentPage) || currentPage < 0) throw fail('页码无效', 'invalid_config');
  return {
    data: {
      mainSearchPcConditionForm: {
        city: String(cityCode || '000'), dq: String(cityCode || '000'), pubTime: '', currentPage, pageSize,
        key: keyword.trim(), suggestTag: '', workYearCode: '', compId: '', compName: '', compTag: '', industry: '',
        salaryCode: '', jobKind: '', compScale: '', compKind: '', compStage: '', eduLevel: '', salaryLow: '', salaryHigh: '',
      },
      passThroughForm: { scene: 'init', skId: '', fkId: '', ckId: ckId || '', suggest: null },
    },
  };
}

export function parseLiepinResponse(body) {
  if (!body || typeof body !== 'object') throw fail('响应不是有效 JSON');
  if (Number(body.flag) !== 1) {
    const msg = String(body.msg || '');
    if (/验证|安全|登录|风控|会话/.test(msg) || ['-1400', '-1001', '400'].includes(String(body.code))) throw fail(`接口拒绝（${msg || body.code}）；会话/模板可能失效，请重新运行 liepin_captcha_helper.mjs`, 'verification_required');
    throw fail(`业务失败（flag ${body.flag}）`, 'api_schema_changed');
  }
  const list = body.data?.data?.jobCardList;
  if (!Array.isArray(list)) throw fail('响应缺少岗位列表');
  return { list };
}

const text = v => String(v ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

export function normalizeLiepinCard(card, keyword, cityName, collectedAt = new Date().toISOString()) {
  const job = card?.job || {}, comp = card?.comp || {};
  if (!job.jobId || !job.title) throw fail('岗位缺少 ID 或标题');
  return {
    platform: '猎聘', query_keyword: keyword, query_city: cityName, job_id: String(job.jobId), job_name: text(job.title),
    company_id: String(comp.compId ?? ''), company_name: text(comp.compName), salary: text(job.salary),
    city: text(job.dq), district: '', experience: text(job.requireWorkYears), education: text(job.requireEduLevel),
    employment_type: text(job.jobKind), company_nature: '', company_size: text(comp.compScale), industry: text(comp.compIndustry),
    publish_time: '', refresh_time: text(job.refreshTime), deadline: '', tags: text((job.labels || []).map(l => l?.label || l).join(' | ')),
    skills: '', job_description: '', address: text(job.dq), recruiter_name: '', recruiter_title: '',
    job_url: job.link || `https://www.liepin.com/job/${job.jobId}.shtml`, company_url: comp.link || '',
    source_total: 0, acquisition_mode: 'session_json_api', detail_status: 'list_only',
    access_level: '猎聘搜索接口列表字段（完整 JD 需详情页）', collected_at: collectedAt,
  };
}

export async function fetchLiepinPage(request, keyword, cityCode, currentPage, session, pageSize = 40) {
  const headers = liepinHeaders(session);
  const body = liepinRequestBody(keyword, cityCode, currentPage, pageSize, session.ckId);
  const response = await request(ENDPOINT, { method: 'POST', headers, body: JSON.stringify(body) });
  const status = typeof response.status === 'function' ? response.status() : response.status;
  if ([401, 403, 429].includes(status)) throw fail(`HTTP ${status}，已停止`, 'access_blocked');
  if (status !== 200) throw fail(`HTTP ${status}`, 'http_error');
  let parsed; try { parsed = JSON.parse(await response.text()); } catch { throw fail('响应不是有效 JSON'); }
  return parseLiepinResponse(parsed);
}