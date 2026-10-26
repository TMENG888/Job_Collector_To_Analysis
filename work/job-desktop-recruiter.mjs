import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
import {extractResumeAttachment} from './job_assistant_resume.mjs';
import {renderResumePages} from './job-browser-resume-pages.mjs';
import {createRecruiterModel} from './job-recruiter-model.mjs';
import {createJobFinder} from './job-browser-finder.mjs';
import {createBrowserDelivery,groundedBrowserGreeting} from './job-browser-delivery.mjs';
import {redactMatchText} from './job-browser-match.mjs';
import {desktopMatchPrompt,validateDesktopJobMatch} from './job-desktop-match-policy.mjs';
import {createPersonalWiki} from './personal-wiki.mjs';
import {tailorFromWiki,sufficientResume} from './personal-wiki-tailor.mjs';

export function createDesktopRecruiter({dataDir,runtimeDir,rpc,screening,model=createRecruiterModel({dataDir,runtimeDir}),parse=extractResumeAttachment,render=renderResumePages,wiki=createPersonalWiki(dataDir,{parse,render}),now=Date.now,wait,pauseMs=5000}={}){
  let resume=null,uploading=false,epoch=0,disposed=false,previewTicket=null;
  let libraryEnabled=false,tailoringEnabled=false,startingLibrary=false;
  const rawResume=()=>{if(resume&&now()-resume.usedAt>30*60000){resume=null;previewTicket=null;void rpc('halt');finder.reset();model.cancel();}return resume;};
  const getResume=()=>{const r=rawResume();return r?{...r,text:redactMatchText(r.text)}:null;};
  // The model selects relevant facts; sending assembles quoted facts instead of
  // trusting a free-form model draft to contain no invented qualifications.
  async function checkedLibraryResume(grant,analysis,materialize=false){
    const id=analysis.resumeId||rawResume()?.libraryId,allowed=grant.approvedResumes?.find(r=>r.id===id);
    if(!allowed)throw Error('此简历不在本批已审核版本授权范围内，请重新授权');
    const selected=await wiki.resume(id,{approvedOnly:true,materialize});
    if(selected.documentHash!==allowed.documentHash||selected.approval.at!==allowed.approvedAt||selected.approval.id!==allowed.approvalId)throw Error('简历审批状态已变化，本批停止');
    return selected;
  }
  const delivery=createBrowserDelivery({rpc,getResume:rawResume,runtimeDir:path.join(runtimeDir,'delivery'),now,wait,minIntervalSeconds:60,dailyLimit:10,greeting:groundedBrowserGreeting,
    resolveResume:({grant,analysis})=>checkedLibraryResume(grant,analysis,true),beforeExternal:({grant,analysis})=>checkedLibraryResume(grant,analysis)});
  const finder=createJobFinder({rpc,screening,requestModel:model.request,getResume,matchJob,delivery,onUse:()=>{},now,wait,pauseMs,minQueries:3,maxQueries:5,transport:'desktop-native',enablePagination:true,maxCandidateLimit:300,defaultCandidates:100,defaultCoverage:.6});
  const expiryTimer=setInterval(rawResume,60000);expiryTimer.unref();
  function info(){const r=rawResume();return r?{configured:true,libraryId:r.libraryId,filename:r.filename,characters:r.text.length,revision:r.revision,documentHash:r.document.sha256,pages:r.document.pages.length,previewed:r.previewedHash===r.document.sha256}:{configured:false};}
  async function status(){const library=await wiki.state(),active=info();if(active.configured&&!library.resumes.some(r=>r.id===active.libraryId&&r.sendable))active.previewed=false;return {resume:active,library:{resumes:library.resumes,stats:library.stats},uploading,model:await model.status(),finder:finder.snapshot(),limits:{maxCandidates:300,maxRecipients:5,minIntervalSeconds:60,dailyLimit:10,consecutiveNonTarget:5,maxPagesPerQuery:30}};}
  async function selectResume(id){
    if(disposed||startingLibrary||finder.busy||uploading)throw Error('请先停止批次，再切换简历');
    const revision=++epoch,selected=await wiki.resume(id,{materialize:true});
    if(disposed||revision!==epoch)throw Error('简历切换已取消');
    finder.reset();model.cancel();previewTicket=null;
    resume={text:selected.text,filename:selected.filename,libraryId:id,revision:randomUUID(),document:selected.document,usedAt:now(),...(selected.sendable?{previewedHash:selected.documentHash}:{})};return info();
  }
  async function upload({filename,base64}){
    if(disposed||uploading)throw Error('简历正在解析或工作台已关闭');uploading=true;const revision=++epoch;
    void rpc('halt');finder.reset();model.cancel();resume=null;previewTicket=null;
    try{
      if(path.extname(filename).toLowerCase()!=='.pdf')throw Error('只接受原版式PDF，DOCX请先用Word或LibreOffice另存PDF');
      const imported=await wiki.importFile({filename,base64});
      const selected=await wiki.resume(imported.resume.id,{materialize:true});
      if(selected.text.length<30||selected.text.length>24000)throw Error('简历需含30–24000字可解析正文；扫描PDF请先自行处理');
      if(disposed||revision!==epoch)throw Error('上传已取消或简历已变化');
      resume={text:selected.text,filename:path.basename(filename),libraryId:selected.id,revision:randomUUID(),document:selected.document,usedAt:now(),...(selected.sendable?{previewedHash:selected.documentHash}:{})};return info();
    }finally{uploading=false;}
  }
  async function preview(){const r=rawResume();if(!r)throw Error('请先上传原版式PDF');const p=await wiki.previewResume(r.libraryId);if(rawResume()?.revision!==r.revision)throw Error('简历变化，请重试预览');previewTicket={id:p.ticket,revision:r.revision,expires:now()+10*60000};return {ticket:previewTicket.id,revision:r.revision,pages:p.pages};}
  async function acknowledge({ticket,revision,pages}){const r=rawResume();if(!r||!previewTicket||ticket!==previewTicket.id||revision!==r.revision||previewTicket.revision!==revision||now()>previewTicket.expires||!Array.isArray(pages)||pages.length!==r.document.pages.length||r.document.pages.some(p=>!pages.includes(p.sha256)))throw Error('请逐页核对当前PDF预览，再确认');await wiki.approveResume({id:r.libraryId,ticket,documentHash:r.document.sha256,pages});if(rawResume()?.revision!==r.revision)throw Error('简历变化，审核未绑定到当前会话');r.previewedHash=r.document.sha256;previewTicket=null;return info();}
  async function matchJob(job,options){
    const r=getResume();if(!r)throw Error('简历已过期');resume.usedAt=now();
    const safeJob={title:redactMatchText(job.title),company:redactMatchText(job.company||''),description:redactMatchText(job.description).slice(0,16000)};
    async function evaluate(text,id,filename){
    const safeText=redactMatchText(text),parsed=await model.request(desktopMatchPrompt,{resume:safeText,job:safeJob},options);
    if(rawResume()?.revision!==r.revision)throw Error('简历变化，匹配已作废');
    return {...validateDesktopJobMatch(parsed,safeText,safeJob),resumeId:id,resumeFilename:filename,resumeRevision:r.revision,fingerprint:createHash('sha256').update(JSON.stringify([job.url,job.title,job.company,job.description])).digest('hex'),truncatedJD:job.description.length>16000,model:parsed._model,usage:parsed._usage};
    }
    if(!libraryEnabled)return evaluate(r.text,r.libraryId,r.filename);
    const state=await wiki.state(),terms=(safeJob.title+' '+safeJob.description).toLowerCase().match(/[a-z][\w+#.-]*|[\u4e00-\u9fff]{2}/g)||[];
    const pool=await Promise.all(state.resumes.filter(x=>x.sendable&&resume.approvedResumes?.some(a=>a.id===x.id)).map(x=>wiki.resume(x.id,{approvedOnly:true})));
    const ranked=pool.map(x=>({...x,rank:terms.reduce((n,t)=>n+(x.text.toLowerCase().includes(t)?1:0),0)})).sort((a,b)=>b.rank-a.rank).slice(0,3);
    let best=null;
    for(const candidate of ranked){const analysis=await evaluate(candidate.text,candidate.id,candidate.filename);if(!best||analysis.coverage>best.coverage)best=analysis;if(sufficientResume(analysis,options?.minCoverage??.6))return analysis;}
    if(tailoringEnabled){const tailored=await tailorFromWiki({wiki,job,request:model.request,options,coverage:options?.minCoverage??.6});if(tailored.draft)return {...(best||{matches:[],gaps:[],coverage:0,droppedEvidence:0,greeting:''}),resumeRevision:r.revision,draft:tailored.draft,awaitingReview:true,safetyNote:tailored.message};}
    return best||{matches:[],gaps:[],coverage:0,droppedEvidence:0,greeting:'',resumeRevision:r.revision,safetyNote:'没有已审核且匹配的库存简历；Wiki证据不足，不发送'};
  }
  async function generate(body){
    if(body?.shareConfirmed!==true)throw Error('请先同意向助手DeepSeek发送脱敏简历和JD');
    const limit=Number(body.budget??.5);if(!Number.isFinite(limit)||limit<.05||limit>2)throw Error('方案预算需0.05–2元');
    if(startingLibrary)throw Error('已有批次正在启动');return finder.generate({budget:{limit,spent:0}});
  }
  async function start(body){
    if(disposed||startingLibrary||finder.busy||uploading)throw Error('已有批次进行中或简历正在处理');
    const r=rawResume();if(!r)throw Error('请先选用库存简历');startingLibrary=true;
    try{
      const useLibrary=body.libraryMode===true;
      if(useLibrary&&body.wikiShareConfirmed!==true)throw Error('请明确同意由DeepSeek使用脱敏Wiki和库存简历');
      const stock=(await wiki.state()).resumes;
      if(rawResume()?.revision!==r.revision)throw Error('简历已变化，启动已取消');
      r.approvedResumes=stock.filter(x=>x.sendable&&(useLibrary||x.id===r.libraryId)).map(x=>({id:x.id,documentHash:x.documentHash,approvedAt:x.approval.at,approvalId:x.approval.id}));
      libraryEnabled=useLibrary;tailoringEnabled=useLibrary&&body.autoTailor===true;
      await rpc('begin');try{return await finder.start(body);}catch(e){await rpc('halt');throw e;}
    }finally{startingLibrary=false;}
  }
  return {status,upload,selectResume,preview,acknowledge,generate,start,get busy(){return startingLibrary||finder.busy;},cancel(){void rpc('halt');finder.cancel();model.cancel();return {message:'已请求停止；已发生的发送不会撤回，不自动重试'};},clear(){epoch++;void rpc('halt');finder.reset();model.cancel();resume=null;previewTicket=null;return info();},dispose(){disposed=true;clearInterval(expiryTimer);this.clear();}};
}
