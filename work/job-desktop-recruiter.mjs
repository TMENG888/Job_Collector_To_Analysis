import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
import {extractResumeAttachment} from './job_assistant_resume.mjs';
import {renderResumePages} from './job-browser-resume-pages.mjs';
import {createRecruiterModel} from './job-recruiter-model.mjs';
import {createJobFinder} from './job-browser-finder.mjs';
import {createBrowserDelivery,groundedBrowserGreeting} from './job-browser-delivery.mjs';
import {redactMatchText} from './job-browser-match.mjs';
import {desktopMatchPrompt,validateDesktopJobMatch} from './job-desktop-match-policy.mjs';

export function createDesktopRecruiter({dataDir,runtimeDir,rpc,screening,model=createRecruiterModel({dataDir,runtimeDir}),parse=extractResumeAttachment,render=renderResumePages,now=Date.now,wait,pauseMs=5000}={}){
  let resume=null,uploading=false,starting=false,epoch=0,disposed=false,previewTicket=null;
  const rawResume=()=>{if(resume&&now()-resume.usedAt>30*60000){resume=null;previewTicket=null;void rpc('halt');finder.reset();model.cancel();}return resume;};
  const getResume=()=>{const r=rawResume();return r?{...r,text:redactMatchText(r.text)}:null;};
  const delivery=createBrowserDelivery({rpc,getResume:rawResume,runtimeDir:path.join(runtimeDir,'delivery'),now,wait,minIntervalSeconds:60,dailyLimit:10,greeting:groundedBrowserGreeting});
  const finder=createJobFinder({rpc,screening,requestModel:model.request,getResume,matchJob,delivery,onUse:()=>{},now,wait,pauseMs,minQueries:3,maxQueries:5,transport:'desktop-native',enablePagination:true,maxCandidateLimit:300,defaultCandidates:100,defaultCoverage:.6});
  const expiryTimer=setInterval(rawResume,60000);expiryTimer.unref();
  function info(){const r=rawResume();return r?{configured:true,filename:r.filename,characters:r.text.length,revision:r.revision,documentHash:r.document.sha256,pages:r.document.pages.length,previewed:r.previewedHash===r.document.sha256}:{configured:false};}
  async function status(){return {resume:info(),uploading,model:await model.status(),finder:finder.snapshot(),limits:{maxCandidates:300,maxRecipients:5,minIntervalSeconds:60,dailyLimit:10,consecutiveNonTarget:5,maxPagesPerQuery:30}};}
  async function upload({filename,base64}){
    if(disposed||uploading||starting||finder.busy)throw Error('请先停止批次并等待简历处理完成');
    uploading=true;const revision=++epoch;
    void rpc('halt');finder.reset();model.cancel();resume=null;previewTicket=null;
    try{
      if(typeof filename!=='string'||path.extname(filename).toLowerCase()!=='.pdf')throw Error('只接受原版式PDF，DOCX请先用Word或LibreOffice另存PDF');
      const attachment=await parse({filename,base64});
      if(attachment.text.length<30||attachment.text.length>24000)throw Error('简历需含30–24000字可解析正文；扫描PDF请先自行处理');
      const document=await render(Buffer.from(base64,'base64'));
      if(disposed||revision!==epoch)throw Error('上传已取消或简历已变化');
      resume={text:attachment.text,filename:path.basename(filename),revision:randomUUID(),document,usedAt:now()};return info();
    }finally{uploading=false;}
  }
  async function preview(){
    const r=rawResume();if(!r)throw Error('请先上传原版式PDF');
    previewTicket={id:randomUUID(),revision:r.revision,expires:now()+10*60000};
    return {ticket:previewTicket.id,revision:r.revision,pages:r.document.pages.map(p=>({...p}))};
  }
  async function acknowledge({ticket,revision,pages}){
    const r=rawResume();
    if(!r||!previewTicket||ticket!==previewTicket.id||revision!==r.revision||previewTicket.revision!==revision||now()>previewTicket.expires||!Array.isArray(pages)||pages.length!==r.document.pages.length||r.document.pages.some(p=>!pages.includes(p.sha256)))throw Error('请逐页核对当前PDF预览，再确认');
    r.previewedHash=r.document.sha256;previewTicket=null;return info();
  }
  async function matchJob(job,options){
    const r=getResume();if(!r)throw Error('简历已过期');resume.usedAt=now();
    const safeJob={title:redactMatchText(job.title),company:redactMatchText(job.company||''),description:redactMatchText(job.description).slice(0,16000)};
    const parsed=await model.request(desktopMatchPrompt,{resume:r.text,job:safeJob},options);
    if(rawResume()?.revision!==r.revision)throw Error('简历变化，匹配已作废');
    return {...validateDesktopJobMatch(parsed,r.text,safeJob),resumeFilename:r.filename,resumeRevision:r.revision,fingerprint:createHash('sha256').update(JSON.stringify([job.url,job.title,job.company,job.description])).digest('hex'),truncatedJD:job.description.length>16000,model:parsed._model,usage:parsed._usage};
  }
  async function generate(body){
    if(body?.shareConfirmed!==true)throw Error('请先同意向助手DeepSeek发送脱敏简历和JD');
    const limit=Number(body.budget??.5);if(!Number.isFinite(limit)||limit<.05||limit>2)throw Error('方案预算需0.05–2元');
    if(disposed||starting||uploading)throw Error('批次正在启动或简历正在处理');return finder.generate({budget:{limit,spent:0}});
  }
  async function start(body){
    if(disposed||starting||finder.busy||uploading)throw Error('已有批次进行中或简历正在处理');
    if(!rawResume())throw Error('请先上传PDF简历');starting=true;
    try{await rpc('begin');try{return await finder.start(body);}catch(e){await rpc('halt');throw e;}}
    finally{starting=false;}
  }
  return {status,upload,preview,acknowledge,generate,start,get busy(){return starting||finder.busy;},cancel(){void rpc('halt');finder.cancel();model.cancel();return {message:'已请求停止；已发生的发送不会撤回，不自动重试'};},clear(){epoch++;void rpc('halt');finder.reset();model.cancel();resume=null;previewTicket=null;return info();},dispose(){disposed=true;clearInterval(expiryTimer);this.clear();}};
}
