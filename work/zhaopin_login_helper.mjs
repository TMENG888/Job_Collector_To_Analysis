// 智联登录助手（路线1）：
//  1) 打开有头浏览器到智联，由你手动完成登录（含短信/扫码/滑块）。
//  2) 登录后本脚本读取该会话的 cookie，写入 ui_data/zhaopin_login/，供 HTTP 直连复用。
//  3) 立刻用带 cookie 的 HTTP 直连验证 search/positions 是否解除第4页验证、并探测滚动分页接口。
// 说明：cookie 是网站合法下发给你本人账号的会话凭证；不盗用他人凭据、不破解验证。
// 用法： node zhaopin_login_helper.mjs          # 打开浏览器手动登录
//        node zhaopin_login_helper.mjs verify   # 仅用已保存 cookie 验证
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import {jsonBodyBytes} from './json_request_body.mjs';
import { refreshZhaopinSession } from './direct_zhaopin_session.mjs';

const PROFILE = process.env.ZHAOPIN_LOGIN_PROFILE
  || 'C:/Users/YS-Insight/AppData/Local/CodexJobCollectorProfilesV2/zhaopin-login-session';
const STATE_DIR = path.resolve(import.meta.dirname, '../ui_data/zhaopin_login');
const COOKIE_FILE = path.join(STATE_DIR, 'cookies.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

async function saveCookies(ctx) {
  const cookies = await ctx.cookies();
  const zhaopin = cookies.filter(c => /zhaopin\.com$/.test(c.domain.replace(/^\./, '')));
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(COOKIE_FILE, JSON.stringify({ saved_at: new Date().toISOString(), cookies: zhaopin }, null, 2), 'utf8');
  return zhaopin;
}

async function verify() {
  // 0) 先换票：rt 在有效期内即可静默换新 at（POST /c/i/refresh-token，body 仅 {rt}）。
  try {
    const renewed = await refreshZhaopinSession({ cookieFile: COOKIE_FILE });
    console.log(`换票: ${renewed.action}${renewed.reason ? `(${renewed.reason})` : ''} at 到期 ${renewed.atExpiresAt || '未变更'} rt 到期 ${renewed.rtExpiresAt || '未变更'}`);
  } catch (error) {
    console.log(`换票失败（继续用现有 cookie 验证）：${error.message}`);
  }
  const saved = JSON.parse(await fs.readFile(COOKIE_FILE, 'utf8')).cookies || [];
  const cookieStr = saved.map(c => `${c.name}=${c.value}`).join('; ');
  console.log(`已加载 cookie ${saved.length} 个`);
  // 1) 首页看登录态
  const home = await fetch('https://www.zhaopin.com/', { headers: { 'user-agent': UA, cookie: cookieStr }, signal: AbortSignal.timeout(15000) });
  const homeText = await home.text();
  console.log('首页登录迹象:', /退出|我的简历|个人中心/.test(homeText) ? '已登录' : '未登录/无法判断');
  // 2) search/positions 深翻页（北京）
  for (const p of [1, 2, 3, 4, 5]) {
    const r = await fetch('https://fe-api.zhaopin.com/c/i/search/positions', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', 'user-agent': UA, cookie: cookieStr },
      body: jsonBodyBytes({ S_SOU_FULL_INDEX: '销售工程师', S_SOU_WORK_CITY: '530', pageIndex: p, pageSize: 20, order: 0, platform: 13, version: '0.0.0' }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => null);
    console.log(`search/positions p${p}: code=${j?.code} list=${j?.data?.list?.length ?? '?'} isVerif=${j?.data?.isVerification} count=${j?.data?.count}`);
    await new Promise(r => setTimeout(r, 2600));
  }
  // 3) SSR 搜索页看 hasMore/pageIndex（带 cookie）
  const jobs = await fetch('https://www.zhaopin.com/jobs?jl=530&kw=' + encodeURIComponent('销售工程师'), { headers: { 'user-agent': UA, cookie: cookieStr, accept: 'text/html' }, signal: AbortSignal.timeout(20000) });
  const html = await jobs.text();
  const m = html.match(/__INITIAL_STATE__=(\{[\s\S]*?\})<\/script>/);
  if (m) {
    try {
      const st = JSON.parse(m[1]);
      console.log('SSR:', JSON.stringify({ pageIndex: st.pageIndex, hasMore: st.hasMore, count: st.positionList?.length, positionCount: st.positionCount }));
    } catch { console.log('SSR: 状态解析失败'); }
  } else {
    console.log('SSR: 未找到 __INITIAL_STATE__（可能返回非SSR页面，len=' + html.length + '）');
  }
}

const mode = process.argv[2];
if (mode === 'verify') {
  await verify();
} else {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://www.zhaopin.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  console.log('请在打开的浏览器中完成智联登录。登录成功后回到本窗口按 Enter 保存 cookie...');
  await new Promise(resolve => process.stdin.once('data', resolve));
  const cookies = await saveCookies(ctx);
  console.log(`已保存 ${cookies.length} 个 zhaopin cookie -> ${COOKIE_FILE}`);
  await ctx.close();
  console.log('开始验证...');
  await verify();
}