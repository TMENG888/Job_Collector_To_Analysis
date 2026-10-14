import fs from 'node:fs/promises';
import {assertCollectorResources} from './collector_resources.mjs';
import {writeJsonAtomic} from './collector_storage.mjs';
import {connectManagedContext} from './managed_browser.mjs';

export class ChannelError extends Error {
  constructor(message, code='layout_changed') { super(message); this.code=code; this.stopChannel=true; }
}

export function blockedReason(text) {
  if (/访问验证|请按住滑块|拖动到最右边|人机验证|安全验证|验证码/.test(text)) return '检测到网站安全验证，请通过平台登录入口人工完成验证后再续采；不会自动处理滑块';
  if (/登录后.{0,8}(查看|搜索)|请先登录|登录已失效|账号.{0,8}(异常|保护|限制)/.test(text)) return '登录或账号状态需要人工处理，请重新登录后续采';
  return '';
}

export async function guard(page) {
  const visible=page.locator('#WAF_NC_WRAPPER, .aliyunCaptcha-sliding-body, .nc-container, .geetest_panel, .verify-wrap, .captcha-dialog').filter({visible:true});
  const challengeText=(await visible.allInnerTexts()).join('\n');
  const text=await page.locator('body').innerText({timeout:2000}).catch(()=>'');
  const prompt=/请按住滑块|拖动到最右边|请进行如下验证|请先登录|登录后.{0,8}(查看|搜索)|登录已失效|账号.{0,8}(异常|保护|限制)/.test(text)?text:'';
  const reason=blockedReason(challengeText||prompt);
  if(reason)throw new ChannelError(reason,'verification_required');
}

export async function openContext(key) {
  await assertCollectorResources();
  return connectManagedContext(key);
}

export async function readCheckpoint(file) {
  try{return JSON.parse(await fs.readFile(file,'utf8'));}
  catch(error){if(error.code==='ENOENT')return {};throw error;}
}

export async function saveCheckpoint(file,data) {
  await writeJsonAtomic(file,{...data,task_id:process.env.JOB_COLLECTOR_TASK_ID||data.task_id||null});
}

export async function evidence(page,file,error) {
  const details={code:error.code||'navigation_error',message:error.message,url:page.url(),at:new Date().toISOString(),pageText:(await page.locator('body').innerText().catch(()=>'')).slice(0,2000)};
  await fs.writeFile(file+'.diagnostic.json',JSON.stringify(details,null,2),'utf8');
  await page.screenshot({path:file+'.png'}).catch(()=>{});
}
