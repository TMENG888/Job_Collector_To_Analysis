import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {writeJsonAtomic} from './collector_storage.mjs';
import {trainingKeywords} from './insight-sampling.mjs';

const running=new Set(['drafting','retrieving','labeling','training','cancelling']);
const finished=new Set(['completed','rejected','needs_samples','failed','cancelled','interrupted']);
const read=async file=>{try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return {version:1,jobs:[]};throw e;}};
const clean=e=>String(e?.message||e).replace(/sk-[\w.-]+/g,'[密钥隐藏]').slice(0,500);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// Collection creates durable work only. A separate confirmed start owns all
// model calls; neither startup nor polling can start/retry a paid operation.
export function createInsightTrainingQueue({directory,service,pollMs=1000,now=()=>new Date().toISOString()}){
  const file=path.join(directory,'state.json');let state,init,serial=Promise.resolve(),active=null;
  const persist=async()=>{await fs.mkdir(directory,{recursive:true});await writeJsonAtomic(file,state);};
  const ready=()=>init??=(async()=>{state=await read(file);if(state.version!==1||!Array.isArray(state.jobs))throw Error('训练队列不可读取');let changed=false;for(const job of state.jobs)if(running.has(job.status)){job.status='interrupted';job.message='服务已重启，不自动付费续跑；已保存的训练记录可查看';job.updatedAt=now();changed=true;}if(changed)await persist();})();
  const mutate=fn=>{const op=serial.then(async()=>{await ready();const result=await fn();await persist();return structuredClone(result);});serial=op.catch(()=>{});return op;};
  const find=id=>{const job=state.jobs.find(j=>j.id===id);if(!job)throw Error('训练任务不存在');return job;};
  const update=(id,patch)=>mutate(()=>Object.assign(find(id),patch,{updatedAt:now()}));
  async function execute(id){
    try{
      let job=find(id);
      const check=()=>{if(find(id).cancelRequested)throw Error('queue_cancelled');};
      if(!(await service.credentials.status()).configured)throw Error('请先配置Qwen标注密钥');
      const scope={inputFile:job.inputFile,role:job.role},schemaState=await service.schemas.status(scope.inputFile,scope.role);
      check();
      const notes=job.keywords?'用户输入的岗位检索关键词：'+job.keywords:'';
      if(!schemaState.approved?.schema?.retrieval||notes&&schemaState.approved.notes!==notes){
        if(!schemaState.model?.configured)throw Error('请先配置DeepSeek规范起草模型');
        await update(id,{status:'drafting',message:'DeepSeek扩展岗位职称、技术检索词及分类边界'});
        const draft=await service.schemas.draft({...scope,budget:job.schemaBudget,shareConfirmed:true,notes});
        check();
        const approved=await service.schemas.approve({...scope,id:draft.id,confirmed:true,approvalMode:'workflow'});
        await update(id,{schemaId:approved.id,schemaEstimate:Number(draft.usage?.estimate||0),schemaAdoption:'workflow'});
      }else await update(id,{schemaId:schemaState.approved.id,schemaAdoption:'existing'});
      check();
      await update(id,{status:'retrieving',message:'按扩展检索词扫描全岗位库，保留目标、相近和随机候选'});
      const preview=await service.previewSampling(scope.inputFile,scope.role,job.sampleCount,{trainingScope:'all',keywords:job.keywords||''});
      await update(id,{retrieval:preview.sampling?.retrieval,library:preview.sampling?.library,sampling:preview.sampling});
      if(!preview.canStart){await update(id,{status:'needs_samples',message:'可用去重样本不足120条，保留任务和已起草规范，不继续付费'});return;}
      check();
      const run=await service.start({...scope,sampleCount:job.sampleCount,budget:job.labelBudget,jointAnnotations:true,trainingScope:'all',trainingKeywords:job.keywords||''});
      await update(id,{status:'labeling',runId:run.id,message:'Qwen联合标注，随后训练与隔离评测'});
      const deadline=Date.now()+2*60*60*1000;
      while(Date.now()<deadline){
        const current=await service.run(run.id);if(!current)throw Error('训练运行记录丢失，停止追踪，不重新付费启动');
        if(current.settling&&!['preparing','labeling','training'].includes(current.status)){await delay(pollMs);continue;}
        if(['preparing','labeling','training'].includes(current.status)){
          if(find(id).cancelRequested)await service.cancelRun(run.id);
          await update(id,{status:find(id).cancelRequested?'cancelling':current.status==='training'?'training':'labeling',message:current.message,labelEstimate:current.costEstimate||0});
          await delay(pollMs);continue;
        }
        const status=current.status==='completed'?(current.eligible?'completed':'rejected'):finished.has(current.status)?current.status:'failed';
        await update(id,{status,message:status==='completed'?'验收通过，分类器已加入岗位洞察':status==='rejected'?'分类器未通过验收，保留标签和评测；不用于正式筛选':current.message,labelEstimate:current.costEstimate||0,eligible:current.eligible===true});return;
      }
      throw Error('追踪已超过2小时，请核对训练记录；不自动重发模型请求');
    }catch(error){await update(id,{status:find(id).cancelRequested?'cancelled':'failed',message:find(id).cancelRequested?'已停止后续步骤；在途请求费用需核对':clean(error)});}
    finally{active=null;}
  }
  return {
    async list(){await serial;await ready();return {workflow:'keyword-training-v1',trainingScope:'all',autoCreate:true,autoExecute:false,busy:!!active,jobs:structuredClone(state.jobs),defaults:{sampleCount:400,schemaBudget:.1,labelBudget:1.9}};},
    async enqueue({taskId,label,inputFile,role,rows,keywords=''}){
      const seeds=trainingKeywords(keywords);keywords=seeds.join('，');
      const global=inputFile==='kb://all'&&taskId==='all'&&seeds.length>0;
      if(!taskId||!role||!global&&(!String(inputFile).startsWith('kb://task/')||decodeURIComponent(new URL(inputFile).pathname.slice(1))!==taskId)||!Number.isSafeInteger(rows)||rows<=0)throw Error('请选择有岗位数据的数据源，全库训练须输入明确岗位检索词');
      return mutate(()=>{const key=createHash('sha256').update(JSON.stringify([taskId,inputFile,role,rows,...(keywords?[keywords]:[])])).digest('hex');const existing=state.jobs.find(j=>j.key===key&&(!keywords||!finished.has(j.status)));if(existing)return existing;
        const job={id:randomUUID(),key,taskId,label,inputFile,role,keywords,sourceRows:rows,status:'queued',sampleCount:400,schemaBudget:.1,labelBudget:1.9,message:'待启动：扩展检索词 → 全库选样 → Qwen标注 → 训练评测',createdAt:now(),updatedAt:now()};state.jobs.unshift(job);return job;});
    },
    async start(id,{confirmed,sampleCount=400,schemaBudget=.1,labelBudget=1.9}={}){
      if(confirmed!==true)throw Error('需明确确认本次模型处理和预算');
      if(!Number.isInteger(sampleCount)||sampleCount<120||sampleCount>2000||!Number.isFinite(schemaBudget)||schemaBudget<.05||schemaBudget>.5||!Number.isFinite(labelBudget)||labelBudget<=0||labelBudget>20)throw Error('请填写有效抽样条数与起草/标注预算');
      const job=await mutate(async()=>{const job=find(id);if(active||running.has(job.status))throw Error('已有队列任务运行中');if(job.status!=='queued')throw Error('此任务已执行，不自动付费重试；请查看原训练记录');const status=await service.status('');if(status.busy)throw Error('已有规范、标注或训练任务运行中');if(!status.credentials?.configured)throw Error('请先配置Qwen标注密钥');const schema=await service.schemas.status(job.inputFile,job.role);const notes=job.keywords?'用户输入的岗位检索关键词：'+job.keywords:'';if((!schema.approved?.schema?.retrieval||notes&&schema.approved.notes!==notes)&&!schema.model?.configured)throw Error('请先配置DeepSeek检索词扩展模型');Object.assign(job,{status:'drafting',sampleCount,schemaBudget,labelBudget,confirmedAt:now(),cancelRequested:false,updatedAt:now()});active=id;return job;});
      void execute(id);return job;
    },
    async cancel(id){return mutate(()=>{const job=find(id);if(finished.has(job.status))return job;return Object.assign(job,{cancelRequested:true,updatedAt:now()},job.status==='queued'?{status:'cancelled',message:'已取消待执行任务，未调用模型'}:{});});},
  };
}

export function createInsightTrainingHandler({queue,catalog,enqueueTask}){
  return async(req,res,pathname)=>{
    if(!['/api/insights/classifiers','/api/insights/training','/api/insights/training/create','/api/insights/training/start','/api/insights/training/cancel'].includes(pathname))return false;
    const json=(code,value)=>{res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value));};
    try{
      const host=new URL('http://'+req.headers.host);
      if(!['127.0.0.1','localhost'].includes(host.hostname)||req.headers['sec-fetch-site']==='cross-site'||req.headers.origin&&req.headers.origin!==host.origin){json(403,{error:'仅允许当前本机控制台'});return true;}
      if(req.method==='GET'&&pathname==='/api/insights/classifiers'){
        const result=await catalog(),training=await queue.list(),roles=new Map(result.roles.map(r=>[r.role,r]));
        for(const job of training.jobs)if(!roles.has(job.role))roles.set(job.role,{role:job.role,status:job.status,source:'queue',inputFile:job.inputFile});
        const entries=[...roles.values()];json(200,{roles:entries,readyCount:entries.filter(r=>r.status==='ready').length,pendingCount:entries.filter(r=>r.status!=='ready').length});
      }else if(req.method==='GET'&&pathname==='/api/insights/training')json(200,await queue.list());
      else if(req.method==='POST'&&pathname.startsWith('/api/insights/training/')){
        if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))throw Error('请使用JSON请求');
        let bytes=0;const chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>32768)throw Error('请求体过大');chunks.push(chunk);}
        const body=JSON.parse(Buffer.concat(chunks).toString('utf8')),action=pathname.split('/').at(-1);
        const allowed={create:['taskId','keywords'],start:['id','confirmed','sampleCount','schemaBudget','labelBudget'],cancel:['id']}[action];
        if(!body||Array.isArray(body)||Object.keys(body).some(k=>!allowed.includes(k)))throw Error('不支持的请求参数');
        if(action==='create')json(200,{job:await enqueueTask(body.taskId,{keywords:body.keywords})});
        if(action==='start')json(202,{job:await queue.start(body.id,body)});
        if(action==='cancel')json(200,{job:await queue.cancel(body.id)});
      }else json(405,{error:'接口不支持此请求方法'});
    }catch(error){json(400,{error:clean(error)});}return true;
  };
}
