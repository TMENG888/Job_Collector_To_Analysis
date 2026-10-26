// 全渠道接口逆向侦察：只读探测，不落库、不改配置、不写断点。
// 目标：确认 7 个平台当前真实响应契约（状态码/正文类型/关键字段），为适配器逆向提供证据。
// 说明：使用浏览器已完成/会完成的公开请求参数形态；不使用他人凭据，不绕过验证码。
import fs from 'node:fs/promises';
import path from 'node:path';
import {jsonBodyBytes} from './json_request_body.mjs';

const OUT = path.resolve(import.meta.dirname, 'recon_out');
await fs.mkdir(OUT, { recursive: true });
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const KW = '销售工程师';

async function probe(name, url, options = {}) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      ...options,
      headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9', ...(options.headers || {}) },
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    const ct = res.headers.get('content-type') || '';
    let shape = null;
    if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
      try {
        const j = JSON.parse(text);
        shape = Array.isArray(j) ? `array:${j.length}` : `keys:${Object.keys(j).slice(0, 12).join(',')}`;
        await fs.writeFile(path.join(OUT, `${name}.json`), JSON.stringify(j, null, 2).slice(0, 200000), 'utf8');
      } catch { shape = 'json-parse-fail'; }
    } else {
      const title = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '';
      const challenge = /aliyun_waf|captcha|验证码|安全验证|人机验证|请按住滑块|访问验证|请先登录|登录后查看/i.test(text);
      shape = `html len=${text.length} title="${title.trim().slice(0, 60)}"${challenge ? ' CHALLENGE' : ''}`;
      await fs.writeFile(path.join(OUT, `${name}.html`), text.slice(0, 200000), 'utf8');
    }
    return { name, status: res.status, ct, ms: Date.now() - started, shape, location: res.headers.get('location') };
  } catch (e) {
    return { name, error: String(e.message || e), ms: Date.now() - started };
  }
}

const results = [];

// 1) 实习僧 列表 JSON（现有适配器契约）
{
  const u = new URL('https://www.shixiseng.com/app/interns/search/v2');
  u.search = new URLSearchParams({ page: '1', keyword: KW, city: '全国', type: 'intern' });
  results.push(await probe('shixiseng_list', u.href, { headers: { accept: 'application/json', referer: 'https://www.shixiseng.com/' } }));
}

// 2) 国聘 列表 POST JSON（已知可用）
results.push(await probe('iguopin_list', 'https://gp-api.iguopin.com/api/jobs/v1/recom-job', {
  method: 'POST',
  headers: { 'content-type': 'application/json; charset=utf-8', origin: 'https://www.iguopin.com', referer: 'https://www.iguopin.com/', device: 'pc', subsite: 'iguopin', version: '5.2.300' },
  body: jsonBodyBytes({ search: { page: 1, page_size: 20, keyword: KW }, recom: { update_time: true, company_nature: true, hot_job: true } }),
}));

// 3) 公共招聘网 SSR 内嵌 JSON（已知可用）
{
  const u = new URL('http://job.mohrss.gov.cn/cjobs/jobinfolist/listJobinfolist');
  u.search = new URLSearchParams({ textfield: KW, pageNo: '1', AREA: '', AREA_name: '', ACA111: '', ACA111_name: '', workType: '', workTypeName: '', acb332: '' });
  results.push(await probe('mohrss_list', u.href));
}

// 4) 智联 直连 POST JSON（v1.14.1 新适配器）
results.push(await probe('zhaopin_list', 'https://fe-api.zhaopin.com/c/i/search/positions', {
  method: 'POST',
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: jsonBodyBytes({ S_SOU_FULL_INDEX: KW, S_SOU_WORK_CITY: '530', pageIndex: 1, pageSize: 20, order: 0, platform: 13, version: '0.0.0' }),
}));

// 5) 前程无忧 搜索接口（带 sign/decode__1048，此处先无签名试探真实边界）
{
  const u = new URL('https://we.51job.com/api/job/search-pc');
  u.search = new URLSearchParams({ api_key: '51job', timestamp: String(Math.floor(Date.now() / 1000)), keyword: KW, searchType: '2', jobArea: '010000', sortType: '0', pageNum: '1', pageSize: '20', source: '1', pageCode: 'sou|sou|soulb', scene: '7' });
  results.push(await probe('job51_list_nosign', u.href, { headers: { accept: 'application/json, text/plain, */*', referer: 'https://we.51job.com/pc/search', 'from-domain': '51job_web' } }));
}

// 6) 前程无忧 搜索页 HTML（确认挑战页/正常页）
results.push(await probe('job51_page', 'https://we.51job.com/pc/search?jobArea=010000&keyword=' + encodeURIComponent(KW) + '&searchType=2', { headers: { accept: 'text/html' } }));

// 7) 就业在线（旧返回业务码5009）
results.push(await probe('jobonline_page', 'https://www.jobonline.cn/', { headers: { accept: 'text/html' } }));

// 8) 猎聘 搜索页 HTML + 已知接口方法名探测
results.push(await probe('liepin_page', 'https://www.liepin.com/zhaopin/?key=' + encodeURIComponent(KW), { headers: { accept: 'text/html' } }));

console.log('\n===== 侦察结果 =====');
for (const r of results) console.log(JSON.stringify(r));
await fs.writeFile(path.join(OUT, 'summary.json'), JSON.stringify(results, null, 2), 'utf8');