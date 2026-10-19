import fs from 'node:fs/promises';
import {assertCollectorResources} from './collector_resources.mjs';
import {writeJsonAtomic} from './collector_storage.mjs';
import {connectManagedContext,assertBrowserPlatform} from './managed_browser.mjs';
import {blockedReason} from './access_block_reason.mjs';
export {blockedReason} from './access_block_reason.mjs';

export class ChannelError extends Error {
  constructor(message, code='layout_changed') { super(message); this.code=code; this.stopChannel=true; }
}

export async function guard(page) {
  const visible=page.locator('#WAF_NC_WRAPPER, .aliyunCaptcha-sliding-body, .nc-container, .geetest_panel, .verify-wrap, .captcha-dialog').filter({visible:true});
  const challengeText=(await visible.allInnerTexts()).join('\n');
  const bodyText=await page.locator('body').innerText({timeout:2000}).catch(()=>'');
  // Jobonline's public search footer advertises optional personalized recommendations.
  // This observed standalone CTA does not gate the public list or detail APIs.
  // Remove only that exact auxiliary line; real dialogs and login prompts still stop.
  const text=bodyText.replace(/^[ \t]*登录后查看更多推荐内容\s*>>[ \t]*$/gm,'');
  const prompt=/请按住滑块|拖动到最右边|请进行如下验证|请先登录|登录后.{0,8}(查看|搜索)|登录已失效|账号.{0,8}(异常|保护|限制)/.test(text)?text:'';
  const reason=blockedReason(challengeText||prompt);
  if(reason)throw new ChannelError(reason,'verification_required');
}

export async function openContext(key) {
  assertBrowserPlatform(key);
  await assertCollectorResources();
  return connectManagedContext(key);
}

export async function readCheckpoint(file) {
  try{
    const saved=JSON.parse(await fs.readFile(file,'utf8'));
    if(saved.task_id&&process.env.JOB_COLLECTOR_TASK_ID&&saved.task_id!==process.env.JOB_COLLECTOR_TASK_ID)throw new ChannelError('断点任务 ID 不匹配，拒绝混入其他任务','TASK_OUTPUT_OWNERSHIP');
    return saved;
  }
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
