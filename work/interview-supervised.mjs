import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {classifierCredentials,QWEN_ENDPOINT,QWEN_MODEL} from './insight-supervised.mjs';
import {renameWithSharingRetry} from './collector_storage.mjs';
import {interviewAnnotationPrompt,interviewAnnotationSample,interviewSourceHash,validateInterviewAnnotations} from './interview-qwen-annotation.mjs';
import {loadInterviewRoleClassifier,prepareInterviewClassifierInput} from './interview-role-classifier.mjs';

const root=path.resolve(import.meta.dirname,'..'),role='智能体/大模型应用';
const defaultReference='E:/Codex/work/20261022-assistant-interviews/reference/codex-regression-v1.json';
const defaultReferenceHash='9bef097ce9e98f9457ac043ba2f4ed188fec95f6f6c934b40ac08acb2960f1ef';
const hash=value=>createHash('sha256').update(value).digest('hex');
const read=async(file,fallback)=>{try{if((await fs.stat(file)).size>64*1024*1024)throw Error('面经模型文件超出读取预算');return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}};
const save=async(file,data)=>{await fs.mkdir(path.dirname(file),{recursive:true});const tmp=file+'.'+randomUUID()+'.tmp';await fs.writeFile(tmp,JSON.stringify(data),{mode:0o600});await renameWithSharingRetry(tmp,file);};
const alive=pid=>{if(!Number.isSafeInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}};
const scrub=message=>String(message).replace(/sk-[\w.\-]+/g,'[密钥隐藏]').slice(0,1200);
export const interviewClassifierDirectory=()=>process.env.JOB_INTERVIEW_CLASSIFIER_DIR||'E:/Codex/work/nowcoder-interview-classifier/runtime';

export function createInterviewSupervised(dataDir,{directory=interviewClassifierDirectory(),referenceFile=process.env.JOB_INTERVIEW_REFERENCE_FILE||defaultReference,referenceSha256=process.env.JOB_INTERVIEW_REFERENCE_SHA256||(referenceFile===defaultReference?defaultReferenceHash:''),credentials=classifierCredentials(dataDir),readPosts,fetcher=fetch,runner}={}){
  if(!path.isAbsolute(directory)||!path.isAbsolute(referenceFile))throw Error('面经模型与参考基准必须使用绝对路径');
  const lockFile=path.join(directory,'run.lock'),indexFile=path.join(directory,'index.json'),activeFile=path.join(directory,'active.json'),publishedFile=path.join(directory,'published.json');
  let active=null,cachedModel=null;
  const runPath=id=>{if(!/^[a-f0-9-]{36}$/.test(String(id)))throw Error('无效面经训练ID');return path.join(directory,id);};
  async function reference(){
    if(!/^[a-f0-9]{64}$/.test(referenceSha256))throw Error('Codex参考基准缺少固定摘要，停止训练');
    if((await fs.stat(referenceFile)).size>16*1024*1024)throw Error('参考基准超出读取预算');
    const bytes=await fs.readFile(referenceFile);
    if(hash(bytes)!==referenceSha256)throw Error('Codex参考基准摘要不一致，不自动更换测试集');
    const data=JSON.parse(bytes);
    if(data.role!==role||typeof data.version!=='string'||typeof data.basis!=='string'||!Array.isArray(data.rows)||!data.rows.length||data.rows.length>2000||data.rows.some(r=>!r.id||!r.url||typeof r.body!=='string'||!r.title||!['include','exclude','review'].includes(r.label)))throw Error('Codex参考基准格式或岗位不匹配');
    return {...data,sha256:referenceSha256};
  }
  async function update(run,patch={}){Object.assign(run,patch,{updatedAt:new Date().toISOString()});await save(path.join(runPath(run.id),'state.json'),run);}
  async function processRun(stage,folder,signal){
    if(runner)return runner(stage,folder,signal);
    const python=path.join(root,'work/role_screening_env/Scripts/python.exe');
    await fs.access(python);
    await new Promise((resolve,reject)=>{
      const child=spawn(python,['-B',path.join(root,'work/train_interview_qwen.py'),stage,folder],{cwd:root,windowsHide:true,env:{...process.env,TEMP:directory,TMP:directory,PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1'},stdio:['ignore','pipe','pipe']});
      active.child=child;let error='';child.stdout.resume();child.stderr.on('data',b=>{error=(error+b.toString()).slice(-2000);});
      const stop=()=>child.kill('SIGTERM');signal.addEventListener('abort',stop,{once:true});
      child.once('error',()=>{signal.removeEventListener('abort',stop);reject(Error('面经训练进程无法启动'));});
      child.once('close',code=>{signal.removeEventListener('abort',stop);active.child=null;code===0?resolve():reject(Error('面经'+stage+'未完成：'+scrub(error)));});
    });
  }
  async function acquire(id){
    await fs.mkdir(directory,{recursive:true});
    const old=await read(lockFile,null);
    if(old&&!alive(old.pid)){const text=await fs.readFile(lockFile,'utf8');if(JSON.stringify(JSON.parse(text))===JSON.stringify(old))await fs.unlink(lockFile);}
    const handle=await fs.open(lockFile,'wx').catch(e=>{if(e.code==='EEXIST')throw Error('已有面经标注或训练运行中，不重复启动付费任务');throw e;});
    await handle.writeFile(JSON.stringify({id,pid:process.pid}));await handle.close();
  }
  async function release(id){const lock=await read(lockFile,null);if(lock?.id===id&&lock.pid===process.pid)await fs.unlink(lockFile).catch(e=>{if(e.code!=='ENOENT')throw e;});}
  async function publicRun(run){
    if(!run)return null;
    const evaluation=await read(path.join(runPath(run.id),'evaluation.json'),null);
    const {predictions,...summary}=evaluation||{};
    return {...run,evaluation:evaluation?summary:null};
  }
  async function status(taskId=''){
    const index=await read(indexFile,[]),latest=index.find(r=>!taskId||r.taskId===taskId),lock=await read(lockFile,null);
    let run=latest?await read(path.join(runPath(latest.id),'state.json'),null):null;
    const busy=!!active||!!(lock&&alive(lock.pid));
    if(run&&['preparing','labeling','training'].includes(run.status)&&active?.id!==run.id&&!(busy&&lock?.id===run.id))run={...run,status:'interrupted',message:'服务已停止；已保存标签与用量，不自动续费',unknownUsageRequests:run.unknownUsageRequests+(run.inFlight?1:0)};
    let benchmark;
    try{const ref=await reference();benchmark={available:true,version:ref.version,rows:ref.rows.length,basis:ref.basis};}catch(e){benchmark={available:false,error:scrub(e.message)};}
    const history=await Promise.all(index.filter(r=>!taskId||r.taskId===taskId).slice(0,1000).map(r=>read(path.join(runPath(r.id),'state.json'),null)));
    const totals=history.filter(Boolean).reduce((a,r)=>({runs:a.runs+1,promptTokens:a.promptTokens+r.promptTokens,completionTokens:a.completionTokens+r.completionTokens,costEstimate:a.costEstimate+r.costEstimate,unknownUsageRequests:a.unknownUsageRequests+r.unknownUsageRequests+(r.inFlight?1:0)}),{runs:0,promptTokens:0,completionTokens:0,costEstimate:0,unknownUsageRequests:0});
    const enabled=await read(activeFile,null),published=await read(publishedFile,null);
    return {role,model:QWEN_MODEL,credentials:await credentials.status(),run:await publicRun(run),busy,busyTaskId:active?.taskId||index.find(r=>r.id===lock?.id)?.taskId||null,totals,benchmark,activeModel:enabled?{id:enabled.id,version:enabled.version,role:enabled.role}:null,publishedRun:published?.id||null,limits:{minSamples:60,maxSamples:1000,maxBudget:20},pricing:{input_per_million:.2,output_per_million:.8,basis:'配置单价估算，非实际账单；不扣缓存折扣'},workflow:'Qwen标注→自动证据校验→训练→Codex参考标签离线回归；无Codex复核环节'};
  }
  async function execute(run,ref,signal){
    let key='';
    const folder=runPath(run.id),labeled=[];
    try{
      const posts=await readPosts({taskId:run.taskId});
      const samples=posts.filter(p=>p.platform==='nowcoder'&&p.content_status==='detail'&&Array.from(p.body??p.content??'').length>=40&&Array.from(p.body??p.content??'').length<=60000).slice(0,2000).map(interviewAnnotationSample).filter(s=>s.options.some(o=>o.field==='body'));
      if(!samples.length)throw Error('没有完整可用面经正文，未调用Qwen');
      const refSamples=ref.rows.map(r=>({...r,text:prepareInterviewClassifierInput(r).text}));
      await save(path.join(folder,'corpus.json'),{sampleCount:run.requestedSamples,rows:samples});
      await save(path.join(folder,'reference-grouping.json'),{version:ref.version,rows:refSamples.map(({label,evidenceType,...r})=>r)});
      await save(path.join(folder,'reference-evaluation.json'),{version:ref.version,basis:ref.basis,rows:refSamples});
      await processRun('prepare',folder,signal);signal.throwIfAborted();
      const prepared=await read(path.join(folder,'prepared.json'),null);
      if(!prepared||!Array.isArray(prepared.samples))throw Error('隔离分组结果不存在');
      await update(run,{sampled:prepared.sampled,sourceRows:prepared.corpus,referenceExcluded:prepared.reference_excluded,available:prepared.available,splitCounts:prepared.split_counts});
      if(prepared.sampled<60||Math.min(prepared.split_counts.train||0,prepared.split_counts.validation||0)<10)throw Error(`排除参考测试及同组材料后，剩余${prepared.sampled}篇；训练至少60篇且训练/验证各至少10篇，未调用Qwen`);
      key=await credentials.load();
      await update(run,{status:'labeling',message:'Qwen联合标注岗位相关性、材料类型与技术问题'});
      for(let offset=0;offset<prepared.samples.length;offset+=5){
        signal.throwIfAborted();
        const batch=prepared.samples.slice(offset,offset+5),maxTokens=5000;
        const messages=[{role:'system',content:interviewAnnotationPrompt},{role:'user',content:JSON.stringify({target_role:role,posts:batch.map(s=>({id:s.id,title:redactTitle(s.title),evidence_options:s.options}))})}];
        const inputUpper=Buffer.byteLength(JSON.stringify(messages),'utf8')+2048,reserved=(inputUpper*run.inputPrice+maxTokens*run.outputPrice)/1e6;
        if(run.budgetAccounted+reserved>run.budget)throw Error('已到费用预算，已保存标签；不自动追加费用或重试');
        await update(run,{requestsStarted:run.requestsStarted+1,inFlight:true,inFlightReservation:reserved});
        let payload;
        try{
          const response=await fetcher(QWEN_ENDPOINT,{method:'POST',redirect:'error',headers:{authorization:'Bearer '+key,'content-type':'application/json'},signal:AbortSignal.any([signal,AbortSignal.timeout(90000)]),body:JSON.stringify({model:QWEN_MODEL,messages,temperature:0,enable_thinking:false,max_tokens:maxTokens,response_format:{type:'json_object'}})});
          if(!response.ok)throw Error('Qwen返回HTTP '+response.status);
          payload=await response.json();
          const usage=payload.usage;
          if(!usage||!['prompt_tokens','completion_tokens'].every(k=>Number.isSafeInteger(usage[k])&&usage[k]>=0))throw Error('Qwen缺少完整Token用量');
          run.promptTokens+=usage.prompt_tokens;run.completionTokens+=usage.completion_tokens;
          run.cachedTokens+=Number.isSafeInteger(usage.prompt_tokens_details?.cached_tokens)?Math.max(0,usage.prompt_tokens_details.cached_tokens):0;
          const cost=(usage.prompt_tokens*run.inputPrice+usage.completion_tokens*run.outputPrice)/1e6;
          run.costEstimate+=cost;run.budgetAccounted+=cost;run.requestsCompleted++;
          run.inFlight=false;run.inFlightReservation=0;
          await update(run);
          await save(path.join(folder,'responses',String(run.requestsCompleted)+'.json'),{model:payload.model,usage,content:payload.choices?.[0]?.message?.content});
          if(cost>reserved||run.budgetAccounted>run.budget)throw Error('实际Token用量超过预留估算，停止后续请求');
        }catch(error){
          if(run.inFlight){run.unknownUsageRequests++;run.budgetAccounted+=reserved;run.inFlight=false;run.inFlightReservation=0;await update(run);}
          throw Error(scrub(error.message)+'；可能已计费，未自动重试');
        }
        if(payload.choices?.[0]?.finish_reason!=='stop')throw Error('Qwen响应被截断，用量已记录，不采用标签');
        let parsed;try{parsed=JSON.parse(payload.choices[0].message.content);}catch{throw Error('Qwen未返回合法JSON，用量已记录，不自动重试');}
        labeled.push(...validateInterviewAnnotations(parsed,batch));
        await save(path.join(folder,'samples.json'),{id:run.id,role,referenceSha256:ref.sha256,annotation:'Qwen3.7-Flash only; Codex labels are reference-only',samples:labeled});
        await update(run,{labeled:labeled.length,positive:labeled.filter(r=>r.label==='include').length,negative:labeled.filter(r=>r.label==='exclude').length,review:labeled.filter(r=>r.label==='review').length,materialCounts:Object.fromEntries(['single_interview','interview_collection','reference_guide','promotion','uncertain'].map(type=>[type,labeled.filter(r=>r.material_type===type).length])),tagCount:labeled.reduce((n,r)=>n+r.tags.length,0)});
        if(labeled.length>=20&&run.positive+run.negative<labeled.length*.25)throw Error('有效标签不足25%，停止后续付费请求');
      }
      signal.throwIfAborted();await update(run,{status:'training',message:'仅用Qwen训练/验证；阈值冻结后才读取Codex参考标签'});
      await processRun('train',folder,signal);signal.throwIfAborted();
      const evaluation=await read(path.join(folder,'evaluation.json'),null);
      if(!evaluation)throw Error('未生成面经分类器评测');
      const bytes=await fs.readFile(path.join(folder,'model.json')),model=await loadInterviewRoleClassifier(path.join(folder,'model.json'),{sha256:hash(bytes)});
      await update(run,{status:'completed',eligible:evaluation.eligible&&model.metadata.hardFilterEligible,artifactSha256:hash(bytes),message:evaluation.eligible&&model.metadata.hardFilterEligible?'候选通过验收，可手动启用硬筛':'标签已保存；候选未通过硬筛验收，保留原模型',finishedAt:new Date().toISOString()});
    }catch(error){
      if(run.inFlight){run.unknownUsageRequests++;run.budgetAccounted+=run.inFlightReservation||0;}
      await update(run,{status:signal.aborted?'cancelled':'failed',inFlight:false,inFlightReservation:0,message:scrub(String(error.message).split(key||'__no_secret__').join('[密钥隐藏]')),finishedAt:new Date().toISOString()});
    }finally{key='';await release(run.id);active=null;}
  }
  return {
    directory,credentials,status,
    async dispose(){if(active){active.controller.abort();active.child?.kill('SIGTERM');}},
    async start({taskId,sampleCount=200,budget=.5,inputPrice=.2,outputPrice=.8,confirmed=false}={}){
      if(confirmed!==true)throw Error('需要明确同意向Qwen发送脱敏公开面经及本轮预算');
      if(active)throw Error('已有面经模型任务运行中');
      if(typeof taskId!=='string'||!taskId||taskId.length>250||!Number.isSafeInteger(sampleCount)||sampleCount<60||sampleCount>1000||!Number.isFinite(budget)||budget<=0||budget>20||![inputPrice,outputPrice].every(p=>Number.isFinite(p)&&p>0&&p<=100))throw Error('请选择任务；样本60–1000，预算0–20元，单价须有效');
      const run={id:randomUUID(),taskId,role,model:QWEN_MODEL,requestedSamples:sampleCount,budget,inputPrice,outputPrice,status:'preparing',message:'冻结分组与参考测试隔离',sampled:0,labeled:0,positive:0,negative:0,review:0,promptTokens:0,completionTokens:0,cachedTokens:0,costEstimate:0,budgetAccounted:0,unknownUsageRequests:0,requestsStarted:0,requestsCompleted:0,inFlight:false,createdAt:new Date().toISOString()};
      const controller=new AbortController();active={id:run.id,taskId,controller,child:null};
      try{
        await acquire(run.id);
        const ref=await reference();
        if(!(await credentials.status()).configured)throw Error('请先在岗位洞察配置Qwen密钥，面经复用同一密钥');
        run.referenceVersion=ref.version;run.referenceSha256=ref.sha256;
        await update(run);const index=await read(indexFile,[]);await save(indexFile,[{id:run.id,taskId},...index].slice(0,1000));
        void execute(run,ref,controller.signal).catch(error=>console.error('面经任务状态记录失败：'+scrub(error.message)));
        return publicRun(run);
      }catch(error){await release(run.id);active=null;throw error;}
    },
    async cancel(taskId){if(active&&active.taskId!==taskId)throw Error('不能停止其他任务的标注');if(active){active.controller.abort();active.child?.kill('SIGTERM');}return {message:'已请求停止；已产生的用量和标签保留，不自动重试'};},
    async publish(id,taskId){
      if((await status(taskId)).busy)throw Error('标注或训练仍在运行');
      const run=await read(path.join(runPath(id),'state.json'),null),data=await read(path.join(runPath(id),'samples.json'),null);
      if(!run||run.taskId!==taskId||!data?.samples?.length||run.labeled!==run.sampled)throw Error('仅能应用当前任务已完整标注的一轮标签');
      await save(publishedFile,{id,taskId,role,labels:data.samples.map(({source_hash,label,material_type,questions,tags})=>({source_hash,label,material_type,questions,tags})),publishedAt:new Date().toISOString()});
      return {message:'已应用Qwen标签与原文问题；不代表候选LR已启用'};
    },
    async activate(id,taskId){
      if((await status(taskId)).busy)throw Error('模型任务仍在运行');
      const run=await read(path.join(runPath(id),'state.json'),null);
      if(!run||run.taskId!==taskId||run.status!=='completed'||!run.eligible)throw Error('当前候选未通过验收，不能启用硬筛');
      const model=await loadInterviewRoleClassifier(path.join(runPath(id),'model.json'),{sha256:run.artifactSha256});
      if(!model.metadata.hardFilterEligible)throw Error('模型文件的评测门槛未通过');
      await save(activeFile,{id,taskId,role,version:model.metadata.version,sha256:run.artifactSha256});cachedModel=null;
      return {message:'已启用面经专用监督分类器；不影响JD分类器'};
    },
    async enrich(posts,roles=[]){
      const published=await read(publishedFile,null),enabled=await read(activeFile,null);
      const annotations=new Map(published?.role===role&&roles.includes(role)?published.labels.map(r=>[r.source_hash,r]):[]);
      if(enabled&&roles.includes(role)&&cachedModel?.sha256!==enabled.sha256)cachedModel={sha256:enabled.sha256,model:await loadInterviewRoleClassifier(path.join(runPath(enabled.id),'model.json'),enabled)};
      return posts.map(post=>{
        const annotation=annotations.get(interviewSourceHash(post));
        return {...post,...(annotation?{qwen_annotation:annotation}:{}),...(enabled&&roles.includes(role)?{supervised_relevance:cachedModel.model.classify(post,{hardFilter:true})}:{})};
      });
    },
  };
}

function redactTitle(title){return String(title).replace(/https?:\/\/\S+/gi,'[链接]').replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi,'[邮箱]').replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g,'[电话]');}

export function createInterviewSupervisedHandler(service,{taskExists=async()=>true}={}){
  return async(req,res,pathname)=>{
    if(pathname!=='/api/interviews/classifier'&&!pathname.startsWith('/api/interviews/classifier/'))return false;
    const json=(code,value)=>{res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value));};
    try{
      const host=new URL('http://'+req.headers.host);
      if(!['127.0.0.1','localhost'].includes(host.hostname)||req.headers['sec-fetch-site']==='cross-site'||req.headers.origin&&req.headers.origin!==host.origin){json(403,{error:'仅允许当前本机控制台'});return true;}
      if(req.method==='GET'&&pathname==='/api/interviews/classifier'){
        const taskId=new URL(req.url,host).searchParams.get('taskId')||'';
        if(taskId&&!await taskExists(taskId))throw Error('任务不存在');
        json(200,await service.status(taskId));return true;
      }
      if(req.method!=='POST'){json(405,{error:'仅支持GET/POST'});return true;}
      if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))throw Error('请使用JSON请求');
      let size=0;const chunks=[];for await(const part of req){size+=part.length;if(size>32768)throw Error('请求体过大');chunks.push(part);}
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(!body||Array.isArray(body)||typeof body!=='object')throw Error('参数无效');
      const action=pathname.split('/').at(-1),allowed={start:['taskId','sampleCount','budget','inputPrice','outputPrice','confirmed'],cancel:['taskId'],activate:['id','taskId'],'publish-labels':['id','taskId']};
      if(!allowed[action]||Object.keys(body).some(k=>!allowed[action].includes(k)))throw Error('接口或参数不支持');
      if(!await taskExists(body.taskId))throw Error('任务不存在');
      const value=action==='start'?{run:await service.start(body)}:action==='cancel'?await service.cancel(body.taskId):action==='activate'?await service.activate(body.id,body.taskId):await service.publish(body.id,body.taskId);
      json(action==='start'?202:200,value);
    }catch(e){json(400,{error:scrub(e.message)});}return true;
  };
}
