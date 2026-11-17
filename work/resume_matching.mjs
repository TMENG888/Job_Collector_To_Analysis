import {assessRequirementJobs,coverageVersion} from './resume_requirement_coverage.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {writeJsonAtomic} from './collector_storage.mjs';
import {createRecruiterModel} from './job-recruiter-model.mjs';
import {managedComputeEnabled,startManagedCompute} from './managed-compute.mjs';
import {assertCollectorResources} from './collector_resources.mjs';
import {redactClassifierText} from './insight-classifier-input.mjs';
import {matchingVersion,matchHash,redactMatchingResume,validateMatchingProfile,validateMatchingReviews,matchingProfilePrompt,matchingReviewPrompt} from './resume_matching_contract.mjs';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=async(file,fallback)=>{try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fields=['key','job_id','platform','job_name','company','city','description','salary_raw','salary_midpoint_k','education','education_raw','experience','company_size','employment_type','industry','url','source_verified','content_hash'];
export const matchingDirectory=()=>path.resolve(process.env.JOB_RESUME_MATCHING_DIR||'E:/Codex/work/job-resume-matching');
export function createResumeMatching({dataDir,store,catalog,directory=matchingDirectory(),modelFactory=createRecruiterModel,resources=assertCollectorResources,compute,now=()=>new Date().toISOString()}={}){
  let active=null,starting=false;
  const folder=id=>{if(!uuid.test(String(id)))throw Error('匹配记录ID无效');return path.join(directory,'runs',id);};
  const stateFile=id=>path.join(folder(id),'state.json');
  const save=async run=>{run.updatedAt=now();await writeJsonAtomic(stateFile(run.id),run);};
  const modelFor=run=>modelFactory({dataDir,runtimeDir:path.join(folder(run.id),'deepseek')});
  async function record(id){const run=await read(stateFile(id),null);if(!run)throw Error('匹配记录不存在');return run;}
  function brief(r){return Object.fromEntries(['id','role','status','phase','progress','message','createdAt','updatedAt','sourceRows','candidateRows','estimate','budget','warning','resultAvailable','imported'].map(k=>[k,r[k]]));}
  async function status(){
    const ids=await read(path.join(directory,'index.json'),[]),runs=[];
    for(const id of ids.slice(0,30)){
      const r=await read(stateFile(id),null);if(!r)continue;
      if(!starting&&['preparing','profiling','queued','matching','reviewing'].includes(r.status)&&active?.run.id!==r.id){r.status='interrupted';r.message='服务已中断，结果与计算断点保留；继续操作沿用原预算';await save(r);}
      runs.push(brief(r));
    }
    const meta=await modelFactory({dataDir,runtimeDir:path.join(directory,'model-status')}).status();
    return {version:matchingVersion,busy:!!active||starting,active:active?brief(active.run):null,runs,model:{configured:meta.configured,model:meta.model},score:{type:coverageVersion,higherIsBetter:true,probability:false}};
  }
  async function result(id){const r=await record(id);const value=await read(path.join(folder(id),'result.json'),null);if(!value)throw Error('尚无匹配结果');return {...value,run:brief(r)};}
  async function update(task,values){Object.assign(task.run,values);await save(task.run);}
  function assertTask(task){task.abort.signal.throwIfAborted();}
  async function localCompute(task){
    if(compute)return compute({folder:folder(task.run.id),signal:task.abort.signal,onProgress:progress=>update(task,{progress})});
    await resources();assertTask(task);
    const child=managedComputeEnabled()?startManagedCompute('resume_matching',{folder:folder(task.run.id)}):spawn(path.join(project,'work/role_screening_env',process.platform==='win32'?'Scripts/python.exe':'bin/python'),['-B','-u',path.join(project,'work/match_resume_jobs.py'),folder(task.run.id)],{cwd:project,windowsHide:true,env:{...process.env,PYTHONIOENCODING:'utf-8',PYTHONDONTWRITEBYTECODE:'1',TEMP:path.join(folder(task.run.id),'temp'),TMP:path.join(folder(task.run.id),'temp')},stdio:['ignore','pipe','pipe']});
    task.child=child;let buffer='',tail='',saves=Promise.resolve(),logWrites=Promise.resolve();
    const log=await fs.open(path.join(folder(task.run.id),'compute.log'),'a');
    const writeLog=chunk=>{logWrites=logWrites.then(()=>log.write(chunk)).catch(error=>{task.progressError=error;child.kill('SIGTERM');});};
    const abort=()=>child.kill('SIGTERM');task.abort.signal.addEventListener('abort',abort,{once:true});
    const stages={bm25_done:'关键词初筛完成',embedding_started:'正在建立岗位向量缓存',embedding_progress:'正在计算岗位向量',embedding_cache_reused:'已复用岗位向量缓存',hybrid_done:'混合召回完成',reranker_started:'正在重排候选岗位',reranker_progress:'正在重排候选岗位',finished:'岗位重排完成'};
    child.stdout.on('data',chunk=>{
      writeLog(chunk);buffer+=chunk.toString();let i;
      while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);let p;try{p=JSON.parse(line);}catch{continue;}
        const progress={stage:p.stage,message:stages[p.stage]||'正在匹配',done:p.done??null,total:p.total??null,seconds:p.seconds};
        saves=saves.then(()=>update(task,{progress})).catch(error=>{task.progressError=error;child.kill('SIGTERM');});
      }
    });
    child.stderr.on('data',chunk=>{tail=(tail+chunk.toString()).slice(-3000);writeLog(chunk);});
    try{await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error(task.abort.signal.aborted?'已停止匹配':'本地匹配计算未完成，请查看执行日志；已保留向量断点')));});await saves;}
    finally{task.abort.signal.removeEventListener('abort',abort);task.child=null;await logWrites;await log.close();}
  }
  async function execute(task){
    const run=task.run,dir=folder(run.id),model=modelFor(run);task.model=model;
    let reviews=[],reviewWarning='';
    try{
      const resume=await fs.readFile(path.join(dir,'resume-redacted.txt'),'utf8');
      let source=await read(path.join(dir,'source.json'),null),jobs=await read(path.join(dir,'jobs.json'),null);
      if(!source||!jobs){
        await update(task,{status:'preparing',phase:'snapshot',message:'正在读取分类器岗位快照'});
        const index=await store.load({signal:task.abort.signal}),snapshot=index.roleSnapshots?.[run.role];assertTask(task);
        if(!snapshot?.jobs?.length)throw Error('当前岗位尚无可用分类器快照，请先生成该岗位的全量分析');
        const keys=new Set(snapshot.jobs.map(j=>j.key));jobs=index.jobs.filter(j=>keys.has(j.key)).map(j=>Object.fromEntries(fields.map(k=>[k,j[k]])));
        if(jobs.length!==keys.size)throw Error('分类器快照与岗位记录不一致，停止匹配');
        source={role:run.role,rows:jobs.length,snapshot:{...snapshot,jobs:undefined},revision:index.report.revision};
        await writeJsonAtomic(path.join(dir,'jobs.json'),jobs);await writeJsonAtomic(path.join(dir,'source.json'),source);
      }
      await update(task,{sourceRows:jobs.length});
      const usageBefore=(await model.status()).usage;if(usageBefore.unknown||usageBefore.inFlight)throw Error('存在用量未知的模型请求，已保留结果，不自动追加费用');
      const budget={limit:run.budget,spent:usageBefore.estimate};
      let profile=await read(path.join(dir,'profile.json'),null);
      if(!profile){
        await update(task,{status:'profiling',phase:'profile',message:'DeepSeek正在解析简历能力'});
        const parsed=await model.request(matchingProfilePrompt,{resume,target_role:run.role},{signal:task.abort.signal,budget,maxTokens:3600});assertTask(task);
        profile={...validateMatchingProfile(parsed,resume),model:parsed._model};await writeJsonAtomic(path.join(dir,'profile.json'),profile);
      }
      let ranked=await read(path.join(dir,'ranked.json'),null),performance=await read(path.join(dir,'performance.json'),null);
      if(!ranked||!performance){await update(task,{status:'matching',phase:'matching',message:'正在检索与重排岗位'});await localCompute(task);assertTask(task);ranked=await read(path.join(dir,'ranked.json'),null);performance=await read(path.join(dir,'performance.json'),null);}
      if(!Array.isArray(ranked)||!ranked.length||!performance||ranked.some((j,i)=>!Number.isFinite(j.rerank_score)||j.rank!==i+1))throw Error('本地匹配结果无效');
      await update(task,{candidateRows:ranked.length,status:'reviewing',phase:'review',message:'正在核对前列岗位的匹配依据'});
      const coverage=await read(path.join(dir,'coverage.json'),{});
      try{await assessRequirementJobs({jobs:ranked.slice(0,12).map(j=>({key:j.key,title:j.job_name,jd:redactClassifierText(j.description)})),resume,model,budget,cache:coverage,signal:task.abort.signal,onSave:value=>writeJsonAtomic(path.join(dir,'coverage.json'),value),onProgress:progress=>update(task,{progress})});}
      catch(error){assertTask(task);reviewWarning=error.message;}
      assertTask(task);const usage=(await model.status()).usage;
      const output={version:matchingVersion,role:run.role,sourceRows:jobs.length,createdAt:now(),profile,jobs:ranked,reviews:Object.fromEntries(reviews.map(r=>[r.key,r])),reviewCount:reviews.length,coverage,source,performance,usage,score:{type:coverageVersion,probability:false,higherIsBetter:true}};
      await writeJsonAtomic(path.join(dir,'result.json'),output);
      await update(task,{status:'completed',phase:'completed',message:'匹配完成',resultAvailable:true,estimate:usage.estimate,warning:reviewWarning||null,progress:null});
    }catch(error){
      const usage=await model.status().then(s=>s.usage).catch(()=>null);
      await update(task,{status:task.abort.signal.aborted?'cancelled':'failed',message:task.abort.signal.aborted?'已停止，计算断点与已发生用量保留':String(error.message).replace(/sk-[\w.-]+/g,'[密钥隐藏]'),estimate:usage?.estimate??run.estimate,progress:null});
    }finally{if(active===task)active=null;}
  }
  async function executeCoverage(task){
    const run=task.run,dir=folder(run.id),model=modelFor(run);task.model=model;
    try{
      const value=await read(path.join(dir,'result.json'),null),resume=await fs.readFile(path.join(dir,'resume-redacted.txt'),'utf8');
      const coverage=await read(path.join(dir,'coverage.json'),value.coverage||{}),usage=(await model.status()).usage;
      if(usage.unknown||usage.inFlight)throw Error('存在用量未知的请求，不自动继续付费');
      const budget={limit:run.budget,spent:(run.billingOffset||0)+usage.estimate};
      await assessRequirementJobs({jobs:value.jobs.filter(j=>run.coverageKeys.includes(j.key)).map(j=>({key:j.key,title:j.job_name,jd:redactClassifierText(j.description)})),resume,model,budget,cache:coverage,signal:task.abort.signal,
        onSave:async cache=>{await writeJsonAtomic(path.join(dir,'coverage.json'),cache);const usage=(await model.status()).usage;await writeJsonAtomic(path.join(dir,'result.json'),{...value,coverage:cache,coverageUpdatedAt:now(),score:{type:coverageVersion,probability:false},usage:{...usage,estimate:(run.billingOffset||0)+usage.estimate}});},
        onProgress:progress=>update(task,{progress})});
      const current=(await model.status()).usage;await update(task,{status:'completed',message:'岗位要求核验完成',resultAvailable:true,estimate:(run.billingOffset||0)+current.estimate,warning:null,progress:null});
    }catch(error){
      const usage=await model.status().then(s=>s.usage).catch(()=>null);await update(task,{status:task.abort.signal.aborted?'cancelled':'failed',message:String(error.message).replace(/sk-[\w.-]+/g,'[密钥隐藏]'),estimate:(run.billingOffset||0)+(usage?.estimate||0),progress:null});
    }finally{if(active===task)active=null;}
  }
  function launch(run){const task={run,abort:new AbortController(),child:null,model:null};active=task;task.promise=run.phase==='coverage'?executeCoverage(task):execute(task);}
  async function assess(body){
    if(body?.shareConfirmed!==true||!uuid.test(body.requestId||'')||!Array.isArray(body.keys)||!body.keys.length||body.keys.length>10||new Set(body.keys).size!==body.keys.length)throw Error('请明确确认本页最多10条岗位的逐项核验');
    const run=await record(body.id),dir=folder(run.id),fingerprint=matchHash(JSON.stringify(['coverage',body.id,body.keys.toSorted()])),receipt=path.join(directory,'requests',body.requestId+'.json'),prior=await read(receipt,null);
    if(prior){if(prior.fingerprint!==fingerprint)throw Error('同一请求标识不能用于不同参数');return brief(await record(prior.id));}
    if(active||starting)throw Error('已有匹配任务运行中');starting=true;
    try{
      const value=await read(path.join(dir,'result.json'),null);if(!value||body.keys.some(k=>!value.jobs.some(j=>j.key===k)))throw Error('请选择本轮候选岗位');
      await fs.access(path.join(dir,'resume-redacted.txt')).catch(()=>{throw Error('此历史记录未保存脱敏简历，请上传简历新建匹配');});
      const meta=await modelFor(run).status();if(!meta.configured)throw Error('请先配置DeepSeek');if(meta.usage.unknown||meta.usage.inFlight)throw Error('存在用量未知的请求，不自动追加付费');
      run.billingOffset=Math.max(run.billingOffset||0,(run.estimate||0)-meta.usage.estimate,(value.usage?.estimate||0)-meta.usage.estimate);
      if(run.billingOffset+meta.usage.estimate>=run.budget)throw Error('本轮预算已用完，不自动追加费用');
      Object.assign(run,{status:'reviewing',phase:'coverage',coverageKeys:body.keys,message:'正在逐项核验岗位要求',warning:null});await save(run);await fs.mkdir(path.dirname(receipt),{recursive:true});await writeJsonAtomic(receipt,{id:run.id,fingerprint});launch(run);return brief(run);
    }finally{starting=false;}
  }
  async function start(body){
    if(!body||body.shareConfirmed!==true)throw Error('请同意DeepSeek分析脱敏简历与少量JD');
    if(!uuid.test(body.requestId||''))throw Error('匹配请求标识无效');
    const resume=redactMatchingResume(body.resume,body.filename),fingerprint=matchHash(JSON.stringify([body.role,resume,body.budget??.5]));
    const prior=await read(path.join(directory,'requests',body.requestId+'.json'),null);
    if(prior){if(prior.fingerprint!==fingerprint)throw Error('同一请求标识不能用于不同的简历或参数');return brief(await record(prior.id));}
    if(active||starting)throw Error('已有简历匹配正在运行，请等待或停止');starting=true;
    try{
      const roles=(await catalog()).roles;if(!roles.some(r=>r.role===body.role&&r.status==='ready'))throw Error('请选择已训练成功且可用的岗位分类器');
      const limit=Number(body.budget??.5);if(!Number.isFinite(limit)||limit<.05||limit>.5)throw Error('匹配预算上限为¥0.50');
      if(!(await modelFactory({dataDir,runtimeDir:path.join(directory,'model-status')}).status()).configured)throw Error('请先在求职助手中配置DeepSeek');
      for(const f of ['bge-small-zh-v1.5','mmarco-mMiniLMv2-L12-H384-v1'])await fs.access(path.join(project,'work/role_screening_models',f,'model.safetensors')).catch(()=>{throw Error('本地匹配模型不可用，请检查运行环境');});
      const id=randomUUID(),dir=folder(id);await fs.mkdir(path.join(dir,'temp'),{recursive:true});
      const run={id,role:body.role,status:'preparing',phase:'snapshot',createdAt:now(),budget:limit,estimate:0,requestId:body.requestId,resumeHash:matchHash(resume),version:matchingVersion,message:'已创建匹配任务'};
      await fs.writeFile(path.join(dir,'resume-redacted.txt'),resume,{mode:0o600});await writeJsonAtomic(path.join(dir,'config.json'),{role:run.role,cacheDir:path.join(directory,'indexes')});await save(run);
      await fs.mkdir(path.join(directory,'requests'),{recursive:true});
      await writeJsonAtomic(path.join(directory,'requests',body.requestId+'.json'),{id,fingerprint});
      const ids=await read(path.join(directory,'index.json'),[]);await writeJsonAtomic(path.join(directory,'index.json'),[id,...ids]);launch(run);return brief(run);
    }finally{starting=false;}
  }
  async function resume(body){
    if(active||starting)throw Error('已有简历匹配正在运行');if(body.shareConfirmed!==true)throw Error('请确认继续原轮次及原预算');
    starting=true;try{const run=await record(body.id);if(!['failed','interrupted','cancelled'].includes(run.status)||(run.imported&&run.phase!=='coverage'))throw Error('当前记录不能继续');const usage=(await modelFor(run).status()).usage;if(usage.unknown||usage.inFlight)throw Error('上轮用量未知，不自动追加付费请求');run.status=run.phase==='coverage'?'reviewing':'preparing';run.message='沿用原预算继续匹配';await save(run);launch(run);return brief(run);}finally{starting=false;}
  }
  async function cancel(){if(active){active.abort.abort();active.model?.cancel();active.child?.kill('SIGTERM');}return {message:'已请求停止，已完成结果与用量保留'};}
  return {status,start,resume,assess,result,cancel,get busy(){return starting||!!active;},async close(){await cancel();await active?.promise;}};
}
export function createResumeMatchingHandler(service){
  return async(req,res,pathname)=>{
    if(!pathname.startsWith('/api/resume-matching'))return false;
    const send=(code,value)=>{res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value));return true;};
    try{
      const url=new URL(req.url,'http://localhost');
      if(req.method==='GET'&&pathname==='/api/resume-matching')return send(200,await service.status());
      if(req.method==='GET'&&pathname==='/api/resume-matching/result')return send(200,await service.result(url.searchParams.get('id')));
      if(req.method!=='POST')return send(405,{error:'请求方法不支持'});
      if(!String(req.headers['content-type']||'').startsWith('application/json'))return send(415,{error:'请使用JSON请求'});
      const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>200000)throw Error('简历请求过大');chunks.push(chunk);}
      const body=JSON.parse(Buffer.concat(chunks).toString());if(!body||typeof body!=='object'||Array.isArray(body))throw Error('请求参数无效');
      if(pathname==='/api/resume-matching/start')return send(202,{run:await service.start(body)});
      if(pathname==='/api/resume-matching/assess')return send(202,{run:await service.assess(body)});
      if(pathname==='/api/resume-matching/resume')return send(202,{run:await service.resume(body)});
      if(pathname==='/api/resume-matching/cancel')return send(202,await service.cancel());
      return send(404,{error:'接口不存在'});
    }catch(error){return send(400,{error:error.message});}
  };
}
