import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createAssistantSessionStore} from './job_assistant_sessions.mjs';
import {extractResumeAttachment} from './job_assistant_resume.mjs';
import {renderResumePages} from './job-browser-resume-pages.mjs';
import {buildPersonalResume,localImageText,readGitHub} from './personal-wiki-import.mjs';
import {organizeSource,wikiAgentVersion,wikiScopeVersion,wikiEvidenceVersion,needsWikiOrganization} from './personal-wiki-agent.mjs';

const hash=v=>createHash('sha256').update(typeof v==='string'||Buffer.isBuffer(v)?v:JSON.stringify(v)).digest('hex');
const manifestId='00000000-0000-4000-8000-000000000001';
const groups={profile:'个人信息',education:'教育经历',experience:'实习与工作',projects:'项目实践',skills:'专业技能',awards:'获奖与证书'};
const stamp=()=>new Date().toISOString();
const cleanName=value=>path.basename(String(value||'').replaceAll('\\','/')).slice(0,180);
const reviewable=f=>f.method!=='raw-fragment'||f.status==='approved';
export function personalWikiDirectory(dataDir){return process.env.JOB_PERSONAL_WIKI_DIR||path.join('E:/Codex/work/20261020-personal-wiki/runtime',hash(path.resolve(dataDir)).slice(0,16));}
export function createPersonalWiki(dataDir,{directory=personalWikiDirectory(dataDir),protect,parse=extractResumeAttachment,render=renderResumePages,ocr=localImageText,pdf=buildPersonalResume,github=readGitHub,now=Date.now}={}){
  const storage=createAssistantSessionStore(directory,{...(protect?{protect}:{}),now}),tickets=new Map();let organizing=false;
  const empty=()=>({id:manifestId,turns:[],version:1,revision:0,sources:[],facts:[],resumes:[],log:[]});
  const read=async()=>await storage.read(manifestId)||empty();
  const transaction=fn=>storage.withLock(manifestId,async()=>{const state=await read();const result=await fn(state);state.revision++;await storage.write(state);return result;});
  const log=(s,action,id)=>{s.log.push({at:stamp(),action,id});s.log=s.log.slice(-200);};
  function sourceActive(s,id,visited=new Set()){
    if(visited.has(id))return false;visited.add(id);const source=s.sources.find(x=>x.id===id);
    return !!source&&!source.archived&&(!source.url?.startsWith('local-source:')||sourceActive(s,source.url.slice(13),visited));
  }
  function validEvidence(s,f){return sourceActive(s,f.sourceId)&&(!f.evidence||f.evidence.every(e=>sourceActive(s,e.sourceId)&&s.sources.find(x=>x.id===e.sourceId)?.sha256===e.sourceHash&&hash(e.quote)===e.quoteHash));}
  function approvedFacts(s){return s.facts.filter(f=>f.status==='approved'&&validEvidence(s,f));}
  function evidenceHash(s,r){const facts=approvedFacts(s);return hash((r.factIds||[]).map(id=>{const fact=facts.find(f=>f.id===id);return fact?fact.method===wikiAgentVersion?[id,fact.quote,fact.sourceId,fact.basis,fact.evidence]:[id,fact.quote,fact.sourceId]:[id,'REVOKED'];}));}
  function sendable(s,r){return r.status==='approved'&&(r.generated||sourceActive(s,r.sourceId))&&r.approval?.documentHash===r.documentHash&&(!r.generated||r.approval?.evidenceHash===evidenceHash(s,r));}
  function resumeMeta(s,r){const {blobId,...meta}=r;return {...meta,sendable:sendable(s,r)};}
  async function addSource({filename,base64,text,url,kind,warning='',documents,commit,reading}){
    const digest=hash(base64?Buffer.from(base64,'base64'):JSON.stringify([url,text]));
    return transaction(async s=>{
      const duplicate=s.sources.find(x=>x.sha256===digest&&!x.archived);if(duplicate)return {source:duplicate,resume:s.resumes.find(r=>r.sourceId===duplicate.id),duplicate:true};
      if(s.sources.filter(x=>!x.archived).length>=200||s.facts.length>=12000)throw Error('个人资料库达到保护上限，请先整理材料或联系维护人员');
      const id=randomUUID(),source={id,filename:cleanName(filename),kind,url,sha256:digest,createdAt:stamp(),warning,characters:text.length,archived:false,...(reading?{reading,commit}:{})};
      await storage.write({id,turns:[],...source,base64,text,...(documents?.length?{documents}:{})});s.sources.push(source);
      // Preserve the immutable source, but do not turn lines into skill/project facts.
      // Only the evidence-reviewed resume agent publishes new fact proposals.
      let resume;if(kind==='pdf'){resume={id:randomUUID(),sourceId:id,blobId:id,filename:source.filename,textLength:text.length,documentHash:digest,status:'draft',generated:false,createdAt:stamp(),factIds:[]};s.resumes.push(resume);}
      log(s,'source-import',id);return {source,resume,duplicate:false};
    });
  }
  async function importFile(body){
    const filename=cleanName(body.filename),ext=path.extname(filename).toLowerCase(),encoded=body.base64;
    if(!filename||typeof encoded!=='string'||!encoded.length||encoded.length>4194304||encoded.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))throw Error('文件无效或超过3MB');
    const bytes=Buffer.from(encoded,'base64');if(!bytes.length||bytes.length>3*1024*1024)throw Error('文件无效或超过3MB');
    const old=(await read()).sources.find(x=>x.sha256===hash(bytes)&&!x.archived);if(old){const s=await read();return {source:old,resume:s.resumes.find(r=>r.sourceId===old.id),duplicate:true};}
    let text='',kind='',warning='';
    if(['.png','.jpg','.jpeg'].includes(ext)){
      if(!(ext==='.png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):bytes[0]===255&&bytes[1]===216))throw Error('图片格式与文件内容不符');
      kind='image';
      if(typeof body.transcription==='string'&&body.transcription.trim())text=body.transcription.trim();
      else try{text=await ocr(bytes,ext,path.join(directory,'temp'));}catch{warning='本机OCR不可用或未识别文字；请补充转录后核实，不会把图片当作已确认能力';}
    }else{
      const parsed=await parse({filename,base64:encoded});text=parsed.text;kind=ext==='.pdf'?'pdf':'document';
      if(kind==='pdf')await render(bytes); // Reject unreadable/oversized-page PDFs before library registration.
    }
    if(text.length>40000)throw Error('个人材料正文超过40000字');
    return addSource({filename,base64:encoded,text,kind,warning});
  }
  async function importGitHub(body){const source=await github(body.url,{deep:true});return addSource({...source,kind:'github',filename:new URL(source.url).pathname.slice(1).replaceAll('/','-')+'.md'});}
  async function source(id){const s=await read(),meta=s.sources.find(x=>x.id===id);if(!meta||meta.deletedAt)throw Error('材料不存在或已删除，请先从回收站恢复');const record=await storage.read(meta.id);return {...meta,text:record.text,documents:record.documents,facts:s.facts.filter(f=>f.sourceId===id&&f.status!=='superseded'&&reviewable(f)),base64:record.base64||''};}
  async function reviewSource({id,factIds,confirmed,ownershipConfirmed}){
    if(confirmed!==true||!Array.isArray(factIds))throw Error('请核对原文并明确确认事实');
    return transaction(s=>{const source=s.sources.find(x=>x.id===id&&sourceActive(s,id));if(!source)throw Error('材料不存在或来源已归档');if(source.kind==='github'&&ownershipConfirmed!==true)throw Error('请确认GitHub材料中所选内容为本人经历/贡献，仓库归属不代表个人能力');
      const facts=s.facts.filter(f=>f.sourceId===id&&f.status!=='superseded');if(factIds.some(fid=>!facts.some(f=>f.id===fid&&reviewable(f))))throw Error('事实引用无效；原始片段须先整理为简历语义条目');
      if(facts.some(f=>factIds.includes(f.id)&&f.basis==='project')&&ownershipConfirmed!==true)throw Error('请确认项目证据为本人实际经历或贡献');
      for(const f of facts)f.status=factIds.includes(f.id)?'approved':'rejected';source.reviewedAt=stamp();source.ownershipConfirmed=!!ownershipConfirmed;log(s,'source-reviewed',id);return {approved:factIds.length};});
  }
  async function transcribe({id,text}){if(typeof text!=='string'||!text.trim()||text.length>20000)throw Error('请输入1–20000字转录');const original=await source(id);if(original.kind!=='image')throw Error('只接受图片转录；其他材料请导入修订文件');return addSource({filename:original.filename+'.转录.txt',text,url:'local-source:'+id,kind:'transcription'});}
  async function resume(id,{approvedOnly=false,materialize=false}={}){
    const s=await read(),r=s.resumes.find(x=>x.id===id);if(!r||s.sources.find(x=>x.id===r.sourceId)?.archived)throw Error('简历不存在或来源已归档');if(approvedOnly&&!sendable(s,r))throw Error('简历尚未人工批准或证据已失效，不允许发送');
    const blob=await storage.read(r.blobId);if(hash(Buffer.from(blob.base64,'base64'))!==r.documentHash)throw Error('简历文件完整性校验失败');
    return {...resumeMeta(s,r),text:blob.text,base64:materialize?blob.base64:undefined,...(materialize?{document:await render(Buffer.from(blob.base64,'base64'))}:{})};
  }
  async function previewResume(id){const r=await resume(id,{materialize:true}),ticket=randomUUID();for(const [key,value]of tickets)if(value.expires<now())tickets.delete(key);if(tickets.size>100)throw Error('预览过多，请稍后重试');tickets.set(ticket,{id,hash:r.documentHash,expires:now()+10*60000,pages:r.document.pages.map(p=>p.sha256)});return {id,ticket,documentHash:r.documentHash,filename:r.filename,pages:r.document.pages};}
  async function approveResume({id,ticket,documentHash,pages}){
    const p=tickets.get(ticket);if(!p||p.id!==id||p.hash!==documentHash||p.expires<now()||!Array.isArray(pages)||pages.length!==p.pages.length||new Set(pages).size!==pages.length||p.pages.some(h=>!pages.includes(h)))throw Error('请逐页预览当前版本，勾选核对后批准');
    return transaction(s=>{const r=s.resumes.find(x=>x.id===id);if(!r||r.documentHash!==documentHash||s.sources.find(x=>x.id===r.sourceId)?.archived)throw Error('简历已变化');if(r.generated&&r.evidenceHash!==evidenceHash(s,r))throw Error('简历依据已撤销，请重新生成后审核');r.status='approved';r.approval={id:randomUUID(),at:stamp(),documentHash,evidenceHash:evidenceHash(s,r),pages:p.pages};tickets.delete(ticket);log(s,'resume-approved',id);return resumeMeta(s,r);});
  }
  async function revokeResume(id){return transaction(s=>{const r=s.resumes.find(x=>x.id===id);if(!r)throw Error('简历不存在');r.status='rejected';r.approval=null;log(s,'resume-revoked',id);return resumeMeta(s,r);});}
  async function archiveSource(id){return transaction(s=>{const source=s.sources.find(x=>x.id===id);if(!source)throw Error('材料不存在');source.archived=true;let changed=true;while(changed){changed=false;for(const child of s.sources)if(!child.archived&&child.url?.startsWith('local-source:')&&!sourceActive(s,child.id)){child.archived=true;changed=true;}}log(s,'source-archived',id);return {archived:true};});}
  async function deleteSource({id,confirmed}){
    if(confirmed!==true)throw Error('请确认删除该材料及停用关联证据');
    if(organizing)throw Error('请先停止 Wiki 整理，待任务结束后删除材料');
    return transaction(s=>{
      if(organizing)throw Error('请先停止 Wiki 整理，待任务结束后删除材料');
      const source=s.sources.find(x=>x.id===id);if(!source)throw Error('材料不存在');
      if(source.deletedAt)return {deleted:true,recoverable:true};
      const ids=new Set([id]);let expanded=true;
      while(expanded){expanded=false;for(const child of s.sources)if(!child.archived&&child.url?.startsWith('local-source:')&&ids.has(child.url.slice(13))&&!ids.has(child.id)){ids.add(child.id);expanded=true;}}
      const deletedAt=stamp();for(const item of s.sources)if(ids.has(item.id)){item.deletedAt=deletedAt;item.deletedWith=id;item.archived=true;}
      const factIds=new Set(s.facts.filter(f=>ids.has(f.sourceId)||f.evidence?.some(e=>ids.has(e.sourceId))).map(f=>f.id));
      let affectedResumes=0;
      for(const r of s.resumes)if(ids.has(r.sourceId)||r.factIds?.some(fid=>factIds.has(fid))){
        r.status='draft';r.approval=null;r.invalidatedByDeletion=true;affectedResumes++;
        if(ids.has(r.sourceId))r.deletedWith=id;
        for(const [key,ticket]of tickets)if(ticket.id===r.id)tickets.delete(key);
      }
      log(s,'source-deleted',id);return {deleted:true,recoverable:true,affectedSources:ids.size,affectedResumes};
    });
  }
  async function restoreSource({id,confirmed}){
    if(confirmed!==true)throw Error('请确认恢复材料');
    if(organizing)throw Error('请等待 Wiki 整理结束后恢复材料');
    return transaction(s=>{
      if(organizing)throw Error('请等待 Wiki 整理结束后恢复材料');
      const root=s.sources.find(x=>x.id===id&&x.deletedAt&&x.deletedWith===id);if(!root)throw Error('回收站材料不存在');
      const restoring=s.sources.filter(x=>x.deletedWith===id),ids=new Set(restoring.map(x=>x.id));
      if(restoring.some(x=>s.sources.some(other=>!other.archived&&!ids.has(other.id)&&other.sha256===x.sha256)))throw Error('相同材料已重新导入，无需重复恢复');
      for(const item of restoring)if(item.url?.startsWith('local-source:')&&!ids.has(item.url.slice(13))&&!sourceActive(s,item.url.slice(13)))throw Error('原始来源仍不可用，请先恢复原始材料');
      for(const item of restoring){item.archived=false;delete item.deletedAt;delete item.deletedWith;}
      for(const r of s.resumes)if(r.deletedWith===id)delete r.deletedWith;
      log(s,'source-restored',id);return {restored:true,resumesRequireApproval:true};
    });
  }
  async function factsForJob(job,limit=45){
    const s=await read(),terms=new Set((String(job.title)+' '+String(job.description)).toLowerCase().match(/[a-z][\w+#.-]*|[\u4e00-\u9fff]{2}/g)||[]);
    return approvedFacts(s).map(f=>({...f,score:[...terms].reduce((n,t)=>n+(f.quote.toLowerCase().includes(t)?1:0),0)})).sort((a,b)=>b.score-a.score).slice(0,limit);
  }
  async function createDraft({job,factIds}){
    if(!job||typeof job.title!=='string'||job.title.length>150||!Array.isArray(factIds)||factIds.length<1||factIds.length>60)throw Error('定制简历缺少有效岗位和已确认事实');
    const s=await read(),facts=approvedFacts(s);const selected=[...new Set(factIds)].map(id=>facts.find(f=>f.id===id));if(selected.some(f=>!f))throw Error('定制简历引用未核实或不存在的事实');
    // Identity/education only comes from explicitly reviewed material, never inference.
    const context=facts.filter(f=>['profile','education'].includes(f.category)).slice(0,10);
    const all=[...new Map([...context,...selected].map(f=>[f.id,f])).values()];
    const ids=all.map(f=>f.id),fingerprint=evidenceHash(s,{factIds:ids}),jobKey=hash([job.url,job.title,job.company,job.description]),key=hash([jobKey,ids,fingerprint]);
    const existing=s.resumes.find(r=>r.draftKey===key&&r.status!=='rejected');if(existing)return resumeMeta(s,existing);
    const sections=Object.entries(groups).map(([group,title])=>({title,quotes:all.filter(f=>f.category===group).map(f=>f.quote)}));
    const bytes=await pdf({target:job.title,sections});if(!bytes.subarray(0,5).equals(Buffer.from('%PDF-'))||bytes.length>3*1024*1024)throw Error('生成的简历PDF无效或过大');await render(bytes);
    const text='求职意向：'+job.title+'\n'+sections.filter(x=>x.quotes.length).map(x=>x.title+'\n'+x.quotes.join('\n')).join('\n');
    return transaction(async current=>{
      if(evidenceHash(current,{factIds:ids})!==fingerprint)throw Error('生成期间Wiki证据变化，草稿未入库');
      const duplicate=current.resumes.find(r=>r.draftKey===key&&r.status!=='rejected');if(duplicate)return resumeMeta(current,duplicate);
      const blobId=randomUUID(),id=randomUUID(),documentHash=hash(bytes),filename=cleanName(job.title)+'-定制-'+stamp().slice(0,10)+'.pdf';
      await storage.write({id:blobId,turns:[],base64:bytes.toString('base64'),text});
      const record={id,blobId,filename,generated:true,status:'draft',documentHash,createdAt:stamp(),factIds:ids,evidenceHash:fingerprint,draftKey:key,jobKey,target:{title:job.title,company:job.company||'',url:job.url||''},textLength:text.length};
      current.resumes.push(record);log(current,'resume-draft-created',id);return resumeMeta(current,record);
    });
  }
  async function annotate({request,budget,signal,sourceIds,force=false}){
    if(organizing)throw Error('Wiki整理智能体已在运行');organizing=true;
    const runId=randomUUID(),startedAt=stamp();let metrics={requests:0,input:0,output:0,estimate:0},runStarted=false;
    try{
      const s=await read();
      if(sourceIds&&(!Array.isArray(sourceIds)||sourceIds.length>3||sourceIds.some(id=>!s.sources.some(x=>x.id===id&&sourceActive(s,id)))))throw Error('材料选择无效，每轮最多3份');
      const sources=s.sources.filter(x=>sourceActive(s,x.id)&&(!sourceIds||sourceIds.includes(x.id))&&(force||needsWikiOrganization(x))).slice(0,3);
      if(!sources.length)return {labeled:0,message:'没有待整理材料'};
      await transaction(current=>{current.agent={id:runId,state:'running',stage:'planning',startedAt,total:sources.length,completed:0,metrics};});runStarted=true;
      const results=[];
      for(const item of sources){
        signal?.throwIfAborted();const record=await storage.read(item.id);if(!record)throw Error('材料快照不可读取');
        const result=await organizeSource({source:{...record,...item},existing:[...approvedFacts(s),...results.flatMap(r=>r.result.facts)],request,budget,signal,onProgress:async(stage,partial,diagnostics=[])=>transaction(current=>{current.agent={...current.agent,stage,sourceId:item.id,filename:item.filename,completed:results.length,readChunks:partial.readChunks,totalChunks:partial.totalChunks,diagnostics:[...results.flatMap(r=>(r.result.diagnostics||[]).map(d=>({...d,sourceId:r.item.id}))),...diagnostics.map(d=>({...d,sourceId:item.id}))].slice(0,80),metrics:Object.fromEntries(Object.keys(metrics).map(k=>[k,metrics[k]+(partial[k]||0)]))};})});
        results.push({item,result});for(const k of Object.keys(metrics))metrics[k]+=result.metrics[k]||0;
      }
      signal?.throwIfAborted();
      return await transaction(current=>{
        signal?.throwIfAborted();if(current.facts.length+results.reduce((n,r)=>n+r.result.facts.length,0)>12000)throw Error('Wiki条目达到保护上限');
        for(const {item} of results)if(!sourceActive(current,item.id)||current.sources.find(x=>x.id===item.id)?.sha256!==item.sha256)throw Error('整理期间来源已变化或归档，未发布候选');
        let count=0;const summaries=[];
        for(const {item,result} of results){
          for(const f of current.facts)if(f.sourceId===item.id&&f.status==='proposed')f.status='superseded';
          const fingerprints=new Set(current.facts.filter(f=>['approved','proposed'].includes(f.status)).map(f=>f.quote.toLowerCase().replace(/\s+/g,'')));
          for(const f of result.facts){const key=f.quote.toLowerCase().replace(/\s+/g,'');if(!fingerprints.has(key)){current.facts.push(f);fingerprints.add(key);count++;}}
          const meta=current.sources.find(x=>x.id===item.id);meta.agentVersion=wikiAgentVersion;meta.scopeVersion=wikiScopeVersion;meta.evidenceVersion=wikiEvidenceVersion;meta.organizedAt=stamp();meta.agentSummary={...result.metrics,reason:result.reason,rejected:result.rejected||0,conflicts:result.conflicts||[],diagnostics:result.diagnostics||[]};summaries.push({sourceId:item.id,...meta.agentSummary});
        }
        current.agent={...current.agent,state:'completed',stage:'completed',completed:results.length,finishedAt:stamp(),metrics,labeled:count,summaries};log(current,'wiki-semantic-organized',runId);return {labeled:count,metrics,summaries};
      });
    }catch(error){if(runStarted)await transaction(current=>{current.agent={...current.agent,state:signal?.aborted?'cancelled':'failed',finishedAt:stamp(),error:String(error.message).replace(/sk-[\w.\-]+/g,'[隐藏]').slice(0,300),metrics:current.agent?.metrics||metrics,...(error.wikiDiagnostics?{diagnostics:[...(current.agent?.diagnostics||[]).filter(d=>d.sourceId!==current.agent?.sourceId),...error.wikiDiagnostics.map(d=>({...d,sourceId:current.agent?.sourceId}))].slice(0,80)}:{})};});throw error;
    }finally{organizing=false;}
  }
  async function state(){const s=await read();const sources=s.sources.filter(x=>!x.archived),deletedSources=s.sources.filter(x=>x.deletedAt&&x.deletedWith===x.id).map(({id,filename,kind,deletedAt})=>({id,filename,kind,deletedAt})),facts=approvedFacts(s),visible=s.facts.filter(f=>sources.some(x=>x.id===f.sourceId)&&f.status!=='superseded'&&reviewable(f)),resumes=s.resumes.filter(r=>!r.deletedWith).map(r=>resumeMeta(s,r));return {revision:s.revision,sources,deletedSources,resumes,facts:visible,agent:s.agent?{...s.agent,...(s.agent.state==='running'&&!organizing?{state:'interrupted',error:'服务已重启，本轮未发布候选；用量请核对模型账本'}:{})}:null,log:s.log.slice(-20).reverse(),stats:{sources:sources.length,confirmedFacts:facts.length,pendingFacts:visible.filter(f=>f.status==='proposed'&&f.method===wikiAgentVersion).length,pendingSources:sources.filter(needsWikiOrganization).length,approvedResumes:resumes.filter(r=>r.sendable).length,drafts:resumes.filter(r=>r.status==='draft').length},storage:'当前Windows用户加密 · E盘持久保存',markdown:'# 个人求职 Wiki\n\n'+Object.entries(groups).map(([key,title])=>'## '+title+'\n'+facts.filter(f=>f.category===key).map(f=>'- '+f.quote+' [['+f.sourceId+']]').join('\n')).join('\n\n')};}
  return {directory,importFile,importGitHub,source,reviewSource,transcribe,resume,previewResume,approveResume,revokeResume,archiveSource,deleteSource,restoreSource,factsForJob,createDraft,annotate,state};
}
const instances=new Map();
export function personalWiki(dataDir){const key=path.resolve(dataDir);if(!instances.has(key))instances.set(key,createPersonalWiki(dataDir));return instances.get(key);}
