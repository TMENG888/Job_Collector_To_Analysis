import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {classifierCredentials,QWEN_ENDPOINT,QWEN_MODEL,readClassifierRows} from './insight-supervised.mjs';
import {roleClassifier} from './role-classifier-registry.mjs';
import {createRoleClassifierMatcher} from './data-analysis-classifier.mjs';
import {scopedClassifierRow,redactClassifierText as redact} from './insight-classifier-input.mjs';
import {writeJsonAtomic} from './collector_storage.mjs';
import {summarizeJointSemantics} from './insight-joint-annotation.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const read=async(file,fallback)=>{try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}};
const now=()=>new Date().toISOString();
import {semanticRowKey,extractionPrompt,semanticEvidence,validateExtraction,concreteSemanticVersion} from './insight-semantic-contract.mjs';
export {semanticRowKey,semanticPrompt,semanticEvidence,validateSemantic} from './insight-semantic-contract.mjs';
export async function loadSemanticCloud(spec,{role,inputFile,classifierId}){
  if(!spec)return null;
  const bytes=await fs.readFile(spec.file);if(hash(bytes)!==spec.sha256)throw Error('词云语义结果校验失败，未回退规则');
  let doc=JSON.parse(bytes);
  if(doc.segments){
    if(!Array.isArray(doc.segments)||doc.segments.length>10001)throw Error('增量标签清单无效');
    const parts=await Promise.all(doc.segments.map(async segment=>{const data=await fs.readFile(segment.file);if(hash(data)!==segment.sha256)throw Error('增量标签校验失败');const payload=JSON.parse(data);if(!Array.isArray(payload.rows))throw Error('增量标签内容无效');return payload.rows;}));
    doc={...doc,rows:parts.reduce((rows,part)=>mergeSemanticRows(rows,part),[])};
  }
  if(spec.format==='joint-trial-v1'){
    if(spec.experimental!==true||spec.role!==role||spec.inputFile!==inputFile||spec.classifierId!==classifierId||!Array.isArray(doc.rows))throw Error('试分析语义标签范围不一致');
    doc={...doc,role:spec.role,inputFile:spec.inputFile,classifierId:spec.classifierId,model:spec.model,sampled:doc.rows.length,experimental:true};
  }
  if(doc.role!==role||doc.inputFile!==inputFile||doc.classifierId!==spec.classifierId||spec.screeningVersion&&spec.screeningVersion!==classifierId)throw Error('词云语义结果与当前岗位、数据集或版本不一致');
  return {...doc,byKey:new Map(doc.rows.map(r=>[r.key,r]))};
}
export function mergeSemanticRows(previous,incoming){
  const rows=new Map(previous.map(row=>[row.key,row]));
  for(const row of incoming){const current=rows.get(row.key);if(current?.contractVersion===concreteSemanticVersion&&row.contractVersion!==concreteSemanticVersion)continue;rows.set(row.key,row);}
  return [...rows.values()];
}
export function createSemanticCloud(dataDir,{supervised,scope,fetcher=fetch,credentials=classifierCredentials(dataDir),readRows=uri=>readClassifierRows(dataDir,uri,uri==='kb://all'?null:100000),matcherFor,directory=process.env.JOB_INSIGHT_SEMANTIC_DIR||(process.env.JOB_UI_DATA_DIR?path.join(dataDir,'semantic_cloud'):'E:/Codex/work/20261018-semantic-cloud/runtime')}={}){
  let active=null;const summaryCache=new Map();
  const indexFile=path.join(directory,'index.json'),lockFile=path.join(directory,'run.lock');
  const runFile=id=>{if(!/^[a-f0-9-]{36}$/.test(String(id)))throw Error('无效语义任务ID');return path.join(directory,id,'state.json');};
  const save=async(file,data)=>{await fs.mkdir(path.dirname(file),{recursive:true});await writeJsonAtomic(file,data);};
  const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}};
  async function currentRows(inputFile,role){
    const index=await read(indexFile,{}),spec=index[inputFile];if(!spec||spec.role!==role)return [];
    return (await loadSemanticCloud(spec,{inputFile,role,classifierId:spec.classifierId})).rows;
  }
  async function cachedRows(inputFile,role){
    const index=await read(indexFile,{});let rows=[];
    for(const spec of Object.values(index).filter(spec=>spec.role===role&&spec.inputFile!==inputFile))rows=mergeSemanticRows(rows,(await loadSemanticCloud(spec,{role,inputFile:spec.inputFile,classifierId:spec.classifierId})).rows);
    return mergeSemanticRows(rows,await currentRows(inputFile,role));
  }
  async function publish(run,rows,suffix){
    const index=await read(indexFile,{}),previousSpec=index[run.inputFile]?.role===run.role?index[run.inputFile]:null;
    const previous=previousSpec?await loadSemanticCloud(previousSpec,{inputFile:run.inputFile,role:run.role,classifierId:previousSpec.classifierId}):null;
    const merged=mergeSemanticRows(previous?.rows||[],rows);
    const document={version:'qwen-semantic-cloud-v2',inputFile:run.inputFile,role:run.role,classifierId:run.classifierId,model:QWEN_MODEL,generatedAt:now(),sampled:merged.length,sourceRows:run.sourceRows,scannedRows:run.scannedRows};
    if(suffix.startsWith('complete-')||suffix.startsWith('joint-'))document.rows=merged;
    else{
      const previousByKey=new Map((previous?.rows||[]).map(row=>[row.key,JSON.stringify(row)])),changed=merged.filter(row=>previousByKey.get(row.key)!==JSON.stringify(row));
      document.segments=previous?.segments?[...previous.segments]:previousSpec?[{file:previousSpec.file,sha256:previousSpec.sha256}]:[];
      if(changed.length){const deltaFile=path.join(directory,run.id,'delta-'+suffix+'.json');await save(deltaFile,{rows:changed});document.segments.push({file:deltaFile,sha256:hash(await fs.readFile(deltaFile))});}
    }
    const file=path.join(directory,run.id,'labels-'+suffix+'.json');await save(file,document);
    const spec={id:run.id,inputFile:run.inputFile,role:run.role,classifierId:run.classifierId,file,sha256:hash(await fs.readFile(file))};
    index[run.inputFile]=spec;await save(indexFile,index);return spec;
  }
  async function resolveMatcher(inputFile,role,model){
    if(matcherFor)return matcherFor({inputFile,role,model});
    const candidate=model?createRoleClassifierMatcher(model.file,model):null;
    return candidate?{match:row=>candidate.match(scopedClassifierRow(row)),metadata:candidate.metadata}:roleClassifier(role);
  }
  async function resolve(inputFile,role,model){
    const index=await read(indexFile,{}),spec=index[inputFile];if(!spec)return null;
    const classifierId=model?.id||roleClassifier(role)?.metadata.version;
    if(spec.role!==role||!classifierId)return null;
    const bound={...spec,screeningVersion:classifierId,attributeBinding:'role-and-content-hash'};
    await loadSemanticCloud(bound,{role,inputFile,classifierId});return bound;
  }
  async function status(inputFile,role=''){
    const last=await read(path.join(directory,'latest.json'),{}),run=last[inputFile]?await read(runFile(last[inputFile]),null):null;
    const lock=await read(lockFile,null),busy=!!(lock&&alive(lock.pid));
    if(run&&['preparing','extracting'].includes(run.status)&&!busy){run.status='interrupted';run.unknownUsageRequests=Math.max(run.unknownUsageRequests||0,run.inFlight?1:0);run.message='服务中断；已记录用量，不自动重试付费请求';}
    if(run?.jointAnnotations&&!run.semanticSummary&&(!role||run.role===role)){
      const spec=(await read(indexFile,{}))[inputFile];
      if(spec?.id===run.id&&spec.role===run.role){
        if(!summaryCache.has(spec.sha256))summaryCache.set(spec.sha256,summarizeJointSemantics((await loadSemanticCloud(spec,{inputFile,role:run.role,classifierId:spec.classifierId})).rows));
        run.semanticSummary=summaryCache.get(spec.sha256);
      }
    }
    return {run:!role||run?.role===role?run:null,busy,capabilities:{incrementalConcreteSkills:true,allLibraryScope:true,contractVersion:concreteSemanticVersion}};
  }
  async function execute(run,signal,matcher){
    let key='';
    const update=async patch=>{Object.assign(run,patch,{updatedAt:now()});await save(runFile(run.id),run);};
    try{
      let selected,reused=[];
      if(run.resume){
        const sampling=await read(path.join(directory,run.id,'sampling.json'),null);if(!sampling?.selected?.length)throw Error('找不到固定抽样断点，不重复发起已计费请求');
        selected=sampling.selected;reused=sampling.reused||[];await update({status:'extracting',processed:0,dropped:0,message:'复用已付费响应，从固定样本断点继续技术提取'});
      }else{
      const source=await readRows(run.inputFile),seen=new Set(),candidates=[],cache=new Map((await cachedRows(run.inputFile,run.role)).map(row=>[row.key,row]));let eligible=0,upgrading=0;
      for(const [rowIndex,row]of source.rows.entries()){
        if(rowIndex%100===0){signal.throwIfAborted();await new Promise(resolve=>setImmediate(resolve));}
        if(!matcher.match(row).matched)continue;
        const id=semanticRowKey(row);if(seen.has(id))continue;seen.add(id);eligible++;
        const cached=cache.get(id);if(cached?.fit==='include'&&cached.contractVersion===concreteSemanticVersion){reused.push(cached);continue;}
        if(cached)upgrading++;
        candidates.push({key:id,title:redact(row.job_name??row['岗位名称']),options:semanticEvidence(row),classifierId:run.classifierId});
      }
      candidates.sort((a,b)=>a.key.localeCompare(b.key));
      const count=Math.min(run.sampleCount,candidates.length);selected=Array.from({length:count},(_,i)=>candidates[Math.floor(i*candidates.length/count)]);
      await update({status:'extracting',sampled:count,sourceRows:source.total,scannedRows:source.rows.length,eligibleUniqueRows:eligible,reusedRows:reused.length,pendingRows:candidates.length,upgradingRows:upgrading,remainingRows:candidates.length-count,message:count?'仅提取筛选结果中缺失或旧版的技术标签，不重新分类岗位':'筛选结果的具体技术标签已齐全；本轮无需模型请求'});
      await save(path.join(directory,run.id,'sampling.json'),{selection:'仅扫描范围内目标岗位，按内容哈希增量抽取；旧版泛化标签升级；不外推全库频率',selected,reused,sourceRows:source.total,scannedRows:source.rows.length});
      }
      const rows=[];
      if(reused.length)await publish(run,reused,'reused-'+randomUUID());
      for(let offset=0;offset<selected.length;offset++){
        signal.throwIfAborted();
        const batch=[{...selected[offset],id:'1'}];
        const cachedResponse=await read(path.join(directory,run.id,'responses',String(offset+1)+'.json'),null);
        let content;
        if(cachedResponse){if(cachedResponse.finishReason!=='stop')throw Error('已付费响应未完整结束，未自动重试');content=cachedResponse.content;}
        else{
        const messages=[{role:'system',content:extractionPrompt},{role:'user',content:JSON.stringify({target_role:run.role,classification_source:'supervised-classifier',jobs:batch.map(r=>({id:r.id,title:r.title,evidence_options:r.options}))})}];
        const bytes=Buffer.byteLength(JSON.stringify(messages),'utf8');if(bytes>300000)throw Error('岗位全文超过单请求安全范围，未截断原文或发送模型');
        const reserve=(bytes+1024)*.2/1e6+6000*.8/1e6;
        if(run.costEstimate+reserve>run.budget)throw Error('本轮语义抽取已达费用估算预算；保留断点，不追加付费');
        if(!key)key=await credentials.load();
        await update({requestsStarted:run.requestsStarted+1,inFlight:true});
        let response;try{response=await fetcher(QWEN_ENDPOINT,{method:'POST',redirect:'error',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},signal:AbortSignal.any([signal,AbortSignal.timeout(90000)]),body:JSON.stringify({model:QWEN_MODEL,messages,enable_thinking:false,temperature:0,max_tokens:6000,response_format:{type:'json_object'}})});}catch{throw Error('模型请求中断，可能已计费；未自动重试');}
        if(!response.ok)throw Error(`语义抽取接口HTTP ${response.status}，已停止，不自动重试`);
        const payload=await response.json(),usage=payload.usage;
        if(!Number.isFinite(usage?.prompt_tokens)||!Number.isFinite(usage?.completion_tokens))throw Error('响应缺少Token用量，已停止');
        run.promptTokens+=usage.prompt_tokens;run.completionTokens+=usage.completion_tokens;run.costEstimate=(run.promptTokens*.2+run.completionTokens*.8)/1e6;
        content=payload.choices?.[0]?.message?.content;
        await save(path.join(directory,run.id,'responses',String(offset+1)+'.json'),{content,usage,finishReason:payload.choices?.[0]?.finish_reason});
        await update({requestsCompleted:run.requestsCompleted+1,inFlight:false});
        if(payload.choices?.[0]?.finish_reason!=='stop')throw Error('模型输出未完整结束，已记录用量与响应，不自动重试');
        }
        const validated=validateExtraction(JSON.parse(content),batch);rows.push(...validated.rows);
        await save(path.join(directory,run.id,'partial.json'),{rows});
        await publish(run,[...reused,...rows],String(offset+1)+'-'+randomUUID());
        await update({processed:rows.length,accepted:rows.length,excluded:0,uncertain:0,coveredUniqueRows:reused.length+rows.length,semanticSummary:summarizeJointSemantics([...reused,...rows]),dropped:run.dropped+validated.dropped});
        if(offset+1<selected.length)await new Promise(r=>setTimeout(r,350));
      }
      signal.throwIfAborted();
      await publish(run,[...reused,...rows],'complete-'+randomUUID());
      await update({status:'completed',coveredUniqueRows:reused.length+rows.length,semanticSummary:summarizeJointSemantics([...reused,...rows]),message:selected.length?'具体技术标签已增量保存；重新生成分析后应用，未替换岗位分类器':'没有缺失标签；复用缓存，零模型请求',finishedAt:now()});
    }catch(e){await update({status:signal.aborted?'cancelled':'failed',unknownUsageRequests:run.inFlight?1:0,inFlight:false,message:String(e.message).split(key||'__no_key__').join('[密钥隐藏]').slice(0,500)});}
    finally{key='';active=null;const lock=await read(lockFile,null);if(lock?.id===run.id)await fs.unlink(lockFile).catch(()=>{});}
  }
  async function launch(run,matcher){
    const inputFile=run.inputFile;
    if(active||(await status(inputFile)).busy||(await supervised.status(inputFile)).busy)throw Error('已有模型任务正在运行，请稍后重试');
    await fs.mkdir(directory,{recursive:true});const previous=await read(lockFile,null);if(previous&&!alive(previous.pid))await fs.unlink(lockFile);
    const lock=await fs.open(lockFile,'wx').catch(e=>{if(e.code==='EEXIST')throw Error('已有语义抽取进程运行中');throw e;});await lock.writeFile(JSON.stringify({id:run.id,pid:process.pid}));await lock.close();
    try{if((await supervised.status(inputFile)).busy)throw Error('已有联合标注或训练任务运行中');}catch(e){await fs.unlink(lockFile).catch(()=>{});throw e;}
    const controller=new AbortController();active={controller};
    try{await save(runFile(run.id),run);const last=await read(path.join(directory,'latest.json'),{});last[inputFile]=run.id;await save(path.join(directory,'latest.json'),last);}catch(e){active=null;await fs.unlink(lockFile);throw e;}
    void execute(run,controller.signal,matcher);return {run};
  }
  return {resolve,status,async importJoint({run,rows,sourceRows,scannedRows}){
    if(active||(await status(run.inputFile)).busy)throw Error('词云任务正在运行，未覆盖已有结果');
    const model=await supervised.resolve(run.inputFile,run.role),classifierId=model?.id||roleClassifier(run.role)?.metadata.version;
    if(!run.jointAnnotations||run.status!=='completed'||!classifierId)throw Error('尚无同岗位合格监督分类器；标签已保留');
    const id=run.id;
    const spec=await publish({...run,classifierId,sourceRows,scannedRows},rows,'joint-'+randomUUID());
    await save(runFile(id),{id,parentRunId:id,inputFile:run.inputFile,role:run.role,classifierId,status:'completed',jointAnnotations:true,message:'已绑定当前合格分类器；共享用量见联合任务',sampleCount:run.requestedSamples,sampled:rows.length,processed:rows.length,accepted:rows.filter(r=>r.fit==='include').length,excluded:rows.filter(r=>r.fit==='exclude').length,uncertain:rows.filter(r=>r.fit==='uncertain').length,promptTokens:0,completionTokens:0,costEstimate:0,budget:run.budget,usageSource:'classifier:'+id,createdAt:run.createdAt,finishedAt:now()});
    const last=await read(path.join(directory,'latest.json'),{});last[run.inputFile]=id;await save(path.join(directory,'latest.json'),last);
    return spec;
  },async cancel(){active?.controller.abort();return {message:'已请求停止；不会自动重发付费请求'};},async start({inputFile,role:requestedRole='',sampleCount=200,budget=.5,shareConfirmed=false}){
    if(shareConfirmed!==true)throw Error('请先确认向Qwen发送筛选后脱敏岗位及本轮预算');
    if(inputFile!=='kb://all'&&!String(inputFile).startsWith('kb://task/')||!Number.isInteger(sampleCount)||sampleCount<1||sampleCount>1000||!Number.isFinite(budget)||budget<=0||budget>20)throw Error('请选择全岗位知识库或有效岗位范围，单批上限1–1000，预算不超过20元');
    const {role}=await scope(inputFile,requestedRole),model=await supervised.resolve(inputFile,role),matcher=await resolveMatcher(inputFile,role,model);
    if(!matcher)throw Error('请先训练并启用岗位专用监督分类器');
    return launch({id:randomUUID(),inputFile,role,classifierId:model?.id||matcher.metadata.version,scoped:!!model,contractVersion:concreteSemanticVersion,shareConfirmed:true,status:'preparing',sampleCount,budget,promptTokens:0,completionTokens:0,costEstimate:0,requestsStarted:0,requestsCompleted:0,processed:0,dropped:0,createdAt:now()},matcher);
  },async resume(id){
    const run=await read(runFile(id),null);if(!run||!['failed','cancelled','interrupted','preparing','extracting'].includes(run.status)||run.unknownUsageRequests||run.inFlight)throw Error('该任务不可续跑，或存在用量不明的请求；不会自动重复计费');
    if(run.contractVersion!==concreteSemanticVersion||run.shareConfirmed!==true)throw Error('旧任务不使用新版提取协议；请通过增量提取复用已保存标签');
    const {role}=await scope(run.inputFile,run.role),model=await supervised.resolve(run.inputFile,role),matcher=await resolveMatcher(run.inputFile,role,model);
    if(!matcher||role!==run.role||(model?.id||matcher.metadata.version)!==run.classifierId)throw Error('岗位或分类器已变化，请重新抽样');
    return launch({...run,status:'preparing',resume:true,resumes:(run.resumes||0)+1},matcher);
  }};
}
export function createSemanticCloudHandler(service){
  return async(req,res,pathname)=>{
    if(!['/api/insights/semantic','/api/insights/semantic/start','/api/insights/semantic/cancel','/api/insights/semantic/resume'].includes(pathname))return false;
    const json=(code,data)=>{res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data));};
    try{
      const host=new URL('http://'+req.headers.host);if(!['localhost','127.0.0.1'].includes(host.hostname)||req.headers['sec-fetch-site']==='cross-site'||req.headers.origin&&req.headers.origin!==host.origin){json(403,{error:'仅允许当前本机控制台'});return true;}
      if(req.method==='GET'&&pathname==='/api/insights/semantic'){const query=new URL(req.url,host).searchParams;json(200,await service.status(query.get('inputFile')||'',query.get('role')||''));}
      else if(req.method==='POST'&&pathname!=='/api/insights/semantic'){
        if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))throw Error('请使用JSON请求');
        let bytes=0;const chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>4096)throw Error('请求体过大');chunks.push(chunk);}
        const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!(pathname.endsWith('/start')?['inputFile','role','sampleCount','budget','shareConfirmed']:pathname.endsWith('/resume')?['id']:[]).includes(k)))throw Error('不支持的请求参数');
        json(pathname.endsWith('/cancel')?200:202,pathname.endsWith('/start')?await service.start(body):pathname.endsWith('/resume')?await service.resume(body.id):await service.cancel());
      }else json(405,{error:'不支持的方法'});
    }catch(e){json(400,{error:String(e.message).replace(/sk-[\w.\-]+/g,'[密钥隐藏]').slice(0,500)});}return true;
  };
}
