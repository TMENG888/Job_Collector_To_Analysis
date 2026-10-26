// Legacy HTTP adapter retained for diagnostics; production uses the explicitly
// approved official website-session transport in liepin_website_session.mjs.
// 逆向要点：
//  - 接口：POST https://api-c.liepin.com/api/com.liepin.searchfront4c.pc-search-job
//  - 请求体：{"data":{"mainSearchPcConditionForm":{key,city,dq,currentPage,pageSize,...},"passThroughForm":{scene,ckId,...}}}
//  - 关键：passThroughForm.ckId 必须为服务器认可的会话级标识（由页面生成，可复用多个请求）
//  - 需完整会话 cookie + x-xsrf-token
//  - 分页：currentPage 递增；以 data.pagination.totalPage 为准，不信 hasNext
// 说明：模板(cookie/ckId)来自本人人工过 IP 验证后的浏览器会话；不模拟滑块、不轮换代理。
import fs from 'node:fs/promises';
import path from 'node:path';
import {LIEPIN_SESSION_HEADERS} from './liepin_session_capture.mjs';
import {jsonBodyBytes} from './json_request_body.mjs';

const ENDPOINT = 'https://api-c.liepin.com/api/com.liepin.searchfront4c.pc-search-job';
export const DEFAULT_TEMPLATE_FILE = path.resolve(import.meta.dirname, '../ui_data/liepin_login/session_template.json');
export const DEFAULT_COOKIE_FILE = path.resolve(import.meta.dirname, '../ui_data/liepin_login/cookies.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const fail = (message, code = 'invalid_response') => Object.assign(Error(`猎聘：${message}`), { code, stopChannel: true });

// Only a fresh, observed successful template is eligible. No cookies-only fallback.
export async function loadLiepinSession({ templateFile = DEFAULT_TEMPLATE_FILE, cookieFile = DEFAULT_COOKIE_FILE } = {}) {
  let template = null;
  try { template = JSON.parse(await fs.readFile(templateFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (template?.cookie) {
    const now = Date.now() / 1000;
    const fresh = Number.isFinite(template.expires_at)&&template.expires_at>now;
    if (fresh&&template.validated===true&&template.request_body?.data?.passThroughForm?.ckId&&template.ckId===template.request_body.data.passThroughForm.ckId) return { cookie: template.cookie, xsrf: template.xsrf || '', ckId: template.ckId, headers:template.headers,requestBody:template.request_body,savedAt: template.saved_at || null, source: 'observed-template' };
  }
  // Cookie-only/expired snapshots cannot certify a valid search. Keeping them
  // on disk is safe; sending them with an empty/generated ckId was the bug.
  return null;
}

export function liepinHeaders(session, { location = 'https://www.liepin.com/zhaopin/' } = {}) {
  const captured={};for(const name of LIEPIN_SESSION_HEADERS){const value=session.headers?.[name];if(typeof value==='string'&&!/[\r\n]/.test(value))captured[name]=value;}
  return {
    accept: 'application/json, text/plain, */*', 'accept-language': 'zh-CN', 'content-type': 'application/json;charset=UTF-8',
    origin: 'https://www.liepin.com', referer: 'https://www.liepin.com/', 'user-agent': UA, cookie: session.cookie,
    'x-client-type': 'web', 'x-fscp-version': '1.1', 'x-fscp-std-info': '{"client_id": "40108"}',
    'x-requested-with': 'XMLHttpRequest', 'x-xsrf-token': session.xsrf,
    'x-fscp-bi-stat': JSON.stringify({ location }),
    ...captured,
    cookie:session.cookie,'x-xsrf-token':session.xsrf||'',
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

export function parseLiepinResponse(body,{expectedPage,requirePagination=false}={}) {
  if (!body || typeof body !== 'object') throw fail('响应不是有效 JSON');
  if(body.data?.backUrl||body.data?.euuid)throw fail('官网要求人工登录或验证','verification_required');
  if (Number(body.flag) !== 1) {
    const msg = String(body.msg || '');
    if (/验证|安全|登录|风控|会话/.test(msg) || ['-1400', '-1001', '400'].includes(String(body.code))) throw fail(`接口拒绝（${msg || body.code}）；会话/模板可能失效，请重新运行 liepin_captcha_helper.mjs`, 'verification_required');
    throw fail(`业务失败（flag ${body.flag}）`, 'api_schema_changed');
  }
  const list = body.data?.data?.jobCardList;
  if (!Array.isArray(list)) throw fail('响应缺少岗位列表');
  const pagination=body.data?.pagination;
  if(pagination||requirePagination){
    if(!pagination||!['currentPage','pageSize','totalPage','totalCounts'].every(key=>Number.isSafeInteger(pagination[key])&&pagination[key]>=0)||pagination.pageSize<1)throw fail('搜索分页字段变化，未认定采集完成','api_schema_changed');
    if(expectedPage!=null&&pagination.currentPage!==expectedPage)throw fail('实际页码与请求不符，保留断点停止','pagination_stalled');
    if(list.length&&pagination.totalCounts===0||pagination.totalCounts>0&&pagination.totalPage<1||!list.length&&pagination.totalCounts>0)throw fail('岗位列表与总数不一致','api_schema_changed');
  }
  return { list,...(pagination?{pagination}: {}) };
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
  if(!session?.cookie||!session.ckId||!session.requestBody)throw fail('缺少官网成功搜索模板，请运行会话助手；不发送旧 Cookie 或虚构 ckId','session_required');
  const headers = liepinHeaders(session);
  const validated=liepinRequestBody(keyword, cityCode, currentPage, pageSize, session.ckId);
  const body=structuredClone(session.requestBody);
  if(!body?.data?.mainSearchPcConditionForm||!body.data.passThroughForm)throw fail('会话请求模板损坏','session_required');
  Object.assign(body.data.mainSearchPcConditionForm,{key:validated.data.mainSearchPcConditionForm.key,city:validated.data.mainSearchPcConditionForm.city,dq:validated.data.mainSearchPcConditionForm.dq,currentPage,pageSize});
  const response = await request(ENDPOINT, { method: 'POST', headers, body: jsonBodyBytes(body) });
  const status = typeof response.status === 'function' ? response.status() : response.status;
  if ([401, 403, 429].includes(status)) throw fail(`HTTP ${status}，已停止`, 'access_blocked');
  if (status !== 200) throw fail(`HTTP ${status}`, 'http_error');
  let parsed; try { parsed = JSON.parse(await response.text()); } catch { throw fail('响应不是有效 JSON'); }
  return parseLiepinResponse(parsed,{expectedPage:currentPage,requirePagination:true});
}
