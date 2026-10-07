import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { savePlatformLoginStatus } from './platform_login_status.mjs';
import {connectManagedContext,browserProfileRoot} from './managed_browser.mjs';
import {navigatePlatformLogin} from './platform_login_navigation.mjs';

const outputDir = path.resolve(process.argv[2] || 'outputs');
const requested = String(process.argv[3] || 'all').toLowerCase();
const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const profileRoot = browserProfileRoot();
const statusPath = path.join(outputDir, '登录会话状态.json');

const targets = [
  { key: 'jobonline', platform: '就业在线', host: 'jobonline.cn', url: 'https://www.jobonline.cn/' },
  { key: 'job51', platform: '前程无忧', host: '51job.com', url: 'https://we.51job.com/pc/search' },
  { key: 'boss', platform: 'BOSS直聘', host: 'zhipin.com', url: 'https://www.zhipin.com/' },
  { key: 'liepin', platform: '猎聘', host: 'liepin.com', url: 'https://www.liepin.com/' },
  { key: 'zhaopin', platform: '智联招聘', host: 'zhaopin.com', url: 'https://www.zhaopin.com/' },
  { key: 'yupao', platform: '鱼泡直聘', host: 'yupao.com', url: 'https://www.yupao.com/zhaogong/' },
  { key: 'deepseek', platform: 'DeepSeek', host: 'chat.deepseek.com', url: 'https://chat.deepseek.com/' },
  { key: 'kimi', platform: 'Kimi', host: 'kimi.com', url: 'https://kimi.com/' },
  { key: 'tongyi', platform: '通义', host: 'qianwen.com', url: 'https://www.qianwen.com/' },
  { key: 'zhipu', platform: '智谱清言', host: 'chatglm.cn', url: 'https://chatglm.cn/' },
  { key: 'doubao', platform: '豆包', host: 'doubao.com', url: 'https://www.doubao.com/chat/' },
];

const selected = requested === 'all' ? targets : targets.filter((item) => item.key === requested);
if (!selected.length) throw new Error(`未知平台：${requested}。可选 ${targets.map((item) => item.key).join('、')}、all`);

await fs.mkdir(outputDir, { recursive: true });
await fs.mkdir(profileRoot, { recursive: true });
async function launchForManualLogin(target) {
  const context=await connectManagedContext(target.key,{lease:false});
  try {
    const page=context.pages().find(p=>{try{return new URL(p.url()).hostname.endsWith(target.host);}catch{return false;}})||context.pages()[0]||await context.newPage();
    await navigatePlatformLogin(page,target.key,target.url,{onlyIfBlank:true});
    // Reopening login focuses the current platform page; never reset a collector's search.
    await page.bringToFront();
    await savePlatformLoginStatus(statusPath,profileRoot,target.key,{
      platform:target.platform,host:target.host,profile_dir:context.managedSession.profile_dir,
      browser_session_id:context.managedSession.session_id,browser_opened_at:new Date().toISOString(),
      login_status:'unknown',state:'共享浏览器已打开，请人工登录和验证；不要关闭窗口，采集将复用当前实例',
    });
    console.log(target.platform+' 共享浏览器已打开/复用，无需关闭窗口；登录状态等待页面确认。');
  }finally{await context.close();}
}

for (const target of selected) await launchForManualLogin(target);
console.log(JSON.stringify({ statusPath, completed: selected.map((item) => item.platform) }));
