import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {writeJsonAtomic} from './collector_storage.mjs';
import {cleanJobURL} from './job-browser-contracts.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
export function groundedBrowserGreeting(job,analysis){
  const facts=[...new Set((analysis.matches||[]).map(m=>m.resume_evidence?.trim()).filter(Boolean))].slice(0,2);
  if(!facts.length)throw Error('自动招呼缺少可核对简历证据');
  return `您好，我对${String(job.title).replace(/[\r\n]/g,' ').slice(0,60)}岗位感兴趣。简历中有相关经历：${facts.map(f=>'“'+f.slice(0,65)+(f.length>65?'…':'')+'”').join('；')}。随附简历供您了解，希望进一步沟通，谢谢。`;
}

// A durable attempt reservation is written BEFORE any external side effect.
// An uncertain attempt remains reserved across restart; never auto-retry it.
export function createBrowserDelivery({rpc,getResume,runtimeDir,now=Date.now,wait=(ms,signal)=>delay(ms,undefined,{signal}),minIntervalSeconds=30,dailyLimit=Infinity,greeting=groundedBrowserGreeting,resolveResume,beforeExternal}){
  const journal=path.join(runtimeDir,'delivery-attempts.json');let busy=false;
  async function ledger(){try{const value=JSON.parse(await fs.readFile(journal,'utf8'));if(value.version!==1||!value.jobs||!value.recipients)throw Error();return value;}catch(e){if(e.code==='ENOENT')return {version:1,jobs:{},recipients:{}};throw Error('发送防重账本不可读取，停止发送');}}
  function authorize(body,resume,planId){
    if(!body?.enabled)return null;
    const max=Number(body.maxRecipients),interval=Number(body.intervalSeconds??60);
    if(body.confirmed!==true||body.planId!==planId||body.resumeRevision!==resume.revision||body.documentHash!==resume.document?.sha256||resume.previewedHash!==resume.document?.sha256)throw Error('请先预览当前PDF全部页面，再确认本批发送授权');
    if(!resume.document?.pages.length)throw Error('没有原版式PDF截图，未授权发送');
    if(!Number.isInteger(max)||max<1||max>5||!Number.isFinite(interval)||interval<minIntervalSeconds||interval>300)throw Error(`每批最多1–5个新岗位，间隔${minIntervalSeconds}–300秒`);
    return {id:randomUUID(),planId,resumeRevision:resume.revision,documentHash:resume.document.sha256,approvedResumes:resume.approvedResumes,maxRecipients:max,intervalSeconds:interval,attempts:0,sent:0,lastAttemptAt:0,expires:now()+20*60000};
  }
  function check(grant,signal){signal?.throwIfAborted();const resume=getResume();if(!resume||!grant||now()>grant.expires||resume.revision!==grant.resumeRevision||resume.document?.sha256!==grant.documentHash)throw Error('本批发送授权或简历已失效');return resume;}
  async function send({grant,job,analysis,tabId,signal}){
    if(busy)throw Error('已有发送流程进行中');busy=true;
    let lock=null;
    try{
      await fs.mkdir(runtimeDir,{recursive:true});
      try{lock=await fs.open(path.join(runtimeDir,'delivery.lock'),'wx');}catch{throw Error('发送账本已被其他进程锁定或上轮异常退出，停止；请人工核对历史发送后处理锁文件');}
      const anchor=check(grant,signal),resume=resolveResume?await resolveResume({grant,analysis}):anchor;if(grant.attempts>=grant.maxRecipients)return {state:'quota',message:'本批发送人数已达授权上限，未沟通此岗位'};
      if(analysis.resumeRevision!==anchor.revision||!analysis.greeting?.trim())throw Error('匹配与简历版本不一致');
      const verify=async()=>{check(grant,signal);await beforeExternal?.({grant,analysis});check(grant,signal);};
      const remaining=grant.lastAttemptAt+grant.intervalSeconds*1000-now();if(remaining>0)await wait(remaining,signal);check(grant,signal);
      const jobKey=hash(cleanJobURL(job.url)),log=await ledger();
      if(log.jobs[jobKey])return {state:'skipped',message:'此岗位已有发送/不确定记录，未重复执行'};
      const attempts=Object.values(log.jobs).map(row=>Date.parse(row.at));
      if(attempts.some(t=>!Number.isFinite(t)))throw Error('发送历史时间无效，停止');
      if(attempts.filter(t=>t>now()-24*3600000).length>=dailyLimit)throw Error('过去24小时沟通尝试已达保护上限，停止；不会新建批次绕过');
      const globalWait=Math.max(0,...attempts.map(t=>t+minIntervalSeconds*1000-now()));
      if(globalWait>0)await wait(globalWait,signal);check(grant,signal);
      // Revalidate the full JD immediately before reserving/clicking communication.
      await verify();const prepared=await rpc('prepare-action',{tabId,kind:'apply'});check(grant,signal);
      if(prepared.fingerprint!==analysis.fingerprint||!/^立即沟通$/.test(prepared.label)){await rpc('cancel-action',{tabId});throw Error('岗位变化、已经沟通过或当前按钮不支持安全开启会话，未执行');}
      grant.attempts++;grant.lastAttemptAt=now();
      log.jobs[jobKey]={at:new Date(now()).toISOString(),grantId:grant.id,resumeId:analysis.resumeId||null,documentHash:resume.document.sha256,state:'opening-reserved'};await writeJsonAtomic(journal,log);check(grant,signal);
      await verify();await rpc('confirm-action',{tabId,ticketId:prepared.id});
      await wait(2200,signal);check(grant,signal);
      const context=await rpc('delivery-context',{tabId,job});check(grant,signal);
      const recipientKey=hash(context.recipientId);
      if(log.recipients[recipientKey])throw Error('收件人已有发送/不确定记录，停止，未重复发送招呼');
      log.recipients[recipientKey]={at:new Date(now()).toISOString(),state:'message-reserved',jobKey};log.jobs[jobKey].state='message-reserved';await writeJsonAtomic(journal,log);check(grant,signal);
      await verify();const result=await rpc('delivery-message',{tabId,binding:context.binding,job,message:analysis.greeting});
      if(!result.confirmed)throw Error('招呼可能已发送，但未取得网页确认；请人工核对，不自动发送图片或重试');
      log.jobs[jobKey].state='greeting-confirmed';await writeJsonAtomic(journal,log);
      let pages=0;
      for(const page of resume.document.pages){
        await wait(2200,signal);check(grant,signal);
        log.jobs[jobKey].state=`image-${page.page}-reserved`;await writeJsonAtomic(journal,log);check(grant,signal);
        await verify();const image=await rpc('delivery-image',{tabId,binding:context.binding,job,image:{...page,filename:`resume-${resume.document.sha256.slice(0,12)}-${page.page}.jpg`}});
        if(!image.confirmed)throw Error(`招呼已发；第${page.page}页图片结果未确认，停止，不重试`);pages++;
      }
      log.jobs[jobKey].state='completed';log.recipients[recipientKey].state='completed';await writeJsonAtomic(journal,log);grant.sent++;
      return {state:'sent',message:`已确认招呼和${pages}页原版式简历图片`,pages};
    }finally{try{if(lock){await lock.close();await fs.unlink(path.join(runtimeDir,'delivery.lock'));}}finally{busy=false;}}
  }
  return {authorize,send,greeting};
}
