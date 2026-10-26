// 就业在线（jobonline.cn）HTTP 直连适配器 —— 纯接口逆向成果。
// 逆向要点：
//  - 接口：POST https://api.jobonline.cn/jobtbao-es-api/elastic/api/position/common/v1/showlist?bodytarget=SEARCH_RESULT_PAGE
//  - 请求体：{"businessData": <SM4 密文 hex>}，密钥/IV 随机，用服务器 SM2 公钥封装在 E-CONTENT-PATH
//  - E-CONTENT-PATH = "04" + SM2(`${sm4Key},${sm4Iv},${respKey},${respIv}`, pubKey, 1)
//  - E-SIGN = SM3("business" + businessData + "data")
//  - 响应为明文 JSON：object.searchList
//  - 无服务端分页；按 关键词 × 城市 组合扩量（每组合约 20 条）
// 说明：公钥/SM 算法来自网站公开前端 bundle；不伪造设备指纹、不绕过验证码。
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
let cryptoImplementation;
function loadJobonlineCrypto() {
  if (cryptoImplementation) return cryptoImplementation;
  try {
    const sm = require('sm-crypto');
    if (typeof sm.sm2?.doEncrypt !== 'function' || typeof sm.sm3 !== 'function' || typeof sm.sm4?.encrypt !== 'function') throw Error('unsupported crypto API');
    cryptoImplementation=sm;
    return sm;
  } catch {
    throw fail('缺少或无法加载 sm-crypto 运行依赖；请运行 npm run install:collector -- <E盘依赖目录> <E盘缓存目录>，修复前不发请求', 'dependency_missing');
  }
}
// Call once before keyword × city loops so a local installation failure does
// not produce dozens of identical query errors or make any network request.
export function checkJobonlineDependencies() {
  try {loadJobonlineCrypto();return {ok:true};}
  catch(error){return {ok:false,code:error.code,message:error.message,stopChannel:true};}
}
const ENDPOINT = 'https://api.jobonline.cn/jobtbao-es-api/elastic/api/position/common/v1/showlist';
const TARGET = 'SEARCH_RESULT_PAGE';
// 网站前端 bundle 中硬编码的服务器 SM2 公钥（非用户凭据）。
export const JOBONLINE_SM2_PUBLIC_KEY = '043f4a9673db98fd52a87e087da75ca8d4978748188e29373acc131887d7b78ee89b07364f644352e4cb4029d8330509368b27b10638345c8afd41149626d917aa';

const fail = (message, code = 'invalid_response') => Object.assign(Error(`就业在线：${message}`), { code, stopChannel: true });
const rand32 = () => { const b = new Uint8Array(16); crypto.getRandomValues(b); return [...b].map(x => x.toString(16).padStart(2, '0')).join(''); };

// 组装标准请求头（与页面一致）。不含用户凭据。
export function jobonlineHeaders(extra = {}) {
  return {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN',
    'content-type': 'application/json;charset=UTF-8',
    'e-version': 'v2.0.0',
    encryptflag: '2',
    msha: '9',
    origin: 'https://www.jobonline.cn',
    platform: '3',
    referer: 'https://www.jobonline.cn/',
    'sec-ch-ua': '"Google Chrome";v="140", "Not_A Brand";v="8"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
    testentype: '1',
    trackplatform: 'JPLN06',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    ...extra,
  };
}

// 构造一次加密请求：返回 {url, options}。每次调用生成新的随机会话密钥（与页面行为一致）。
export function jobonlineRequest(keyword, city, { encrypt } = {}) {
  if (typeof keyword !== 'string' || !keyword.trim()) throw fail('关键词无效', 'invalid_config');
  encrypt ??= loadJobonlineCrypto();
  const cityCode = city?.code && /^\d{6}$/.test(String(city.code)) ? Number(city.code) : null;
  const A = rand32(), y = rand32(), w = rand32(), x = rand32();
  const plain = {
    target: TARGET,
    param: {
      jobFairId: null, licenseNumber: null, industryCode: null, jobAge: null, eduDegree: null, salaryRange: null,
      nature: null, size: null, introCategory: null, channelNumber: null, cityCode, areaCode: null, areaCodes: null,
      positionCode: null, positionCode1: null, positionCode1s: null, positionCode2: null, positionCode3: null,
      name: null, id: null, positionName3: keyword.trim(), companyId: null, sortType: 1, provinceCode: null,
      provinceCodes: null, areaId: null, zc: null, zcAreaId: null, cityCodes: null, category: '', pageorder: 'DESC',
    },
  };
  const businessData = encrypt.sm4.encrypt(JSON.stringify(plain), x, { mode: 'cbc', iv: A });
  const eContentPath = '04' + encrypt.sm2.doEncrypt(`${x},${A},${y},${w}`, JOBONLINE_SM2_PUBLIC_KEY, 1);
  const eSign = encrypt.sm3('business' + businessData + 'data');
  return {
    url: `${ENDPOINT}?bodytarget=${TARGET}`,
    options: { method: 'POST', headers: jobonlineHeaders({ 'e-content-path': eContentPath, 'e-sign': eSign }), body: JSON.stringify({ businessData }) },
    keys: { x, A, y, w },
  };
}

// 校验并解析明文响应。
export function parseJobonlineResponse(body) {
  if (!body || typeof body !== 'object') throw fail('响应不是有效 JSON');
  if (String(body.code) === '5009') throw fail('接口未识别加密数据（契约变化）', 'api_schema_changed');
  if (String(body.code) !== '200') throw fail(`业务状态异常（code ${body.code ?? 'missing'}）`);
  const list = body.object?.searchList;
  if (!Array.isArray(list)) throw fail('响应缺少岗位列表');
  return { list, message: body.message || '' };
}

const text = v => String(v ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const salary = row => {
  if (row.salaryRange === 70 || (row.lowSalary == null && row.highSalary == null)) return '面议';
  const lo = row.lowSalary, hi = row.highSalary, unit = '万元';
  if (lo == null && hi == null) return '';
  return `${lo ?? ''}-${hi ?? ''}${unit}`;
};

// 标准化为统一 30 字段。
export function normalizeJobonline(row, keyword, cityName, collectedAt = new Date().toISOString()) {
  if (row?.id == null || !String(row.positionName || '').trim()) throw fail('岗位缺少稳定 ID 或标题');
  return {
    platform: '就业在线', query_keyword: keyword, query_city: cityName, job_id: String(row.id), job_name: text(row.positionName),
    company_id: String(row.companyId ?? ''), company_name: text(row.companyName || row.aliasName), salary: salary(row),
    city: text(row.cityName), district: text(row.address), experience: text(row.jobAge), education: text(row.eduDegree),
    employment_type: text(row.category), company_nature: text(row.nature), company_size: text(row.companySize),
    industry: text(row.industryName), publish_time: row.publishTime ? new Date(row.publishTime * 1000).toISOString() : '',
    refresh_time: '', deadline: '', tags: text(row.channelNumber || row.name), skills: '', job_description: text(row.positionDesc || row.positionName),
    address: text(row.address), recruiter_name: '', recruiter_title: '',
    job_url: `https://www.jobonline.cn/positionDetail?id=${row.id}`, company_url: row.companyId ? `https://www.jobonline.cn/company?id=${row.companyId}` : '',
    source_total: 0, acquisition_mode: 'public_json_api', detail_status: 'list_only',
    access_level: '就业在线公开搜索接口（明文响应，SM 加密请求）', collected_at: collectedAt,
  };
}

// 采集一个关键词×城市条件。
export async function fetchJobonlinePage(request, keyword, city) {
  const contract = jobonlineRequest(keyword, city);
  const response = await request(contract.url, contract.options);
  const status = typeof response.status === 'function' ? response.status() : response.status;
  if ([401, 403, 429].includes(status)) throw fail(`HTTP ${status}，已停止`, 'access_blocked');
  if (status !== 200) throw fail(`HTTP ${status}`, 'http_error');
  let body; try { body = JSON.parse(await response.text()); } catch { throw fail('响应不是有效 JSON'); }
  return parseJobonlineResponse(body);
}
