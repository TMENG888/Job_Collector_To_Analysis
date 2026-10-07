import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {writeJsonAtomic} from './collector_storage.mjs';
import {assertListPage} from './list_page_guard.mjs';
import {blockedReason} from './browser_public_channels.mjs';

export const sessionFileName=platform=>`${platform==='yupao'?'鱼泡直聘':'智联招聘'}_浏览器会话.json`;
export async function createManualSearchSession(outputDir, taskId, page, {pollMs=1000,platform='zhaopin',settleMs=15000,instanceId=null}={}) {
  const file=path.join(outputDir,sessionFileName(platform));
  const confirmation=file+'.confirm.json';
  const state={task_id:taskId,session_id:randomUUID(),pid:process.pid,platform,browser_instance_id:instanceId,
    login_status:'unknown',verification_status:'unchecked',browser_open:true};
  async function save(patch){Object.assign(state,patch,{updated_at:new Date().toISOString()});await writeJsonAtomic(file,state);}
  async function checkPage(){
    await assertListPage(page);
    const prompts=await page.locator('.geetest_panel, .verify-wrap, .captcha-dialog, .login-dialog').filter({visible:true}).allInnerTexts();
    const reason=blockedReason(prompts.join('\n'));
    if(reason)throw Object.assign(Error(reason),{code:'USER_ACTION_REQUIRED'});
  }
  await save({});
  return {
    async guard(current, forcedReason='') {
      const deadline=Date.now()+settleMs;
      while(!page.isClosed() && Date.now()<deadline) {
        try {await checkPage();break;}catch(error){
          if(!error.message.includes('页面空白或跳转异常'))break;
          await new Promise(r=>setTimeout(r,pollMs));
        }
      }
      try {if(forcedReason)throw Object.assign(Error(forcedReason),{code:'USER_ACTION_REQUIRED'});await checkPage();await save({verification_status:'clear',url:page.url(),keyword:current.keyword,city:current.city});return;}
      catch(error){if(error.code!=='USER_ACTION_REQUIRED')throw error;}
      await page.bringToFront();
      let reason='';
      while(!page.isClosed()) {
        try {await checkPage();reason='';}catch(error){reason=error.message;}
        await save({verification_status:'waiting_human',reason,url:page.url(),keyword:current.keyword,city:current.city,
          ...(reason.includes('登录会话')?{login_status:'login_required'}:{})});
        console.log(`[等待人工验证] ${current.keyword}/${current.city.name}：请在保留的浏览器完成登录/验证，不要关闭窗口；然后点击“已人工验证，继续当前会话”。`);
        let confirmed=false;
        while(!page.isClosed()) {
          const request=await fs.readFile(confirmation,'utf8').then(JSON.parse).catch(()=>null);
          if(request?.session_id===state.session_id && request?.task_id===taskId && request?.confirmed_at!==state.last_confirmation) {
            state.last_confirmation=request.confirmed_at;confirmed=true;break;
          }
          await new Promise(r=>setTimeout(r,pollMs));
        }
        if(!confirmed)break;
        try {
          await checkPage();
          const url=new URL(page.url());
          const valid=platform==='yupao'
            ? ['www.yupao.com','yupao.com'].includes(url.hostname)&&url.pathname.startsWith('/zhaogong/')&&(!current.detailUrl||url.href===current.detailUrl)
            : url.hostname==='www.zhaopin.com'&&url.pathname==='/jobs'&&url.searchParams.get('kw')===current.keyword&&url.searchParams.get('jl')===String(current.city.code);
          if(!valid)
            throw Error('请返回当前关键词和城市的受阻搜索页后再确认');
          current.responseError='';
          if(current.combo)current.combo.responseError='';
          await save({login_status:'human_confirmed',verification_status:'clear',reason:'',url:page.url()});
          console.log('[人工验证已确认] 页面检查通过，在同一浏览器和页面继续采集。');return;
        }catch(error){console.log('[仍需人工处理] '+error.message);}
      }
      throw Object.assign(Error('人工验证浏览器已关闭，已保留断点，请重新打开当前搜索页续采'),{code:'USER_ACTION_REQUIRED'});
    },
    async close(){await save({browser_open:false,verification_status:'session_closed'});},
  };
}
