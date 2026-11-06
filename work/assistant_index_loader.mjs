import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {knowledgeStore} from './job_knowledge_store.mjs';
import {knowledgeDatabasePath} from './knowledge_storage.mjs';
import {assistantClassificationVersion} from './assistant_classification_cache.mjs';
import {abortReason,waitForRequest} from './assistant_request_budget.mjs';
import {createCandidateSearch,consultationSnapshot} from './job_assistant_candidates.mjs';
import {snapshotGrowth} from './assistant_snapshot_policy.mjs';
import {assertCollectorResources} from './collector_resources.mjs';

export function assistantIndexCacheDirectory(dataDir){
  const scope=createHash('sha256').update(path.resolve(dataDir)+'\n'+knowledgeDatabasePath(dataDir)).digest('hex').slice(0,20);
  if(process.platform==='win32'){
    if(!fs.existsSync('E:/'))throw Error('E 盘不可用，无法建立岗位检索缓存；不会改写到 C 盘');
    return path.join('E:/Codex/work/job-assistant-index-cache',scope);
  }
  return path.join(os.tmpdir(),'job-assistant-index-cache',scope);
}
export function createBackgroundAssistantStore(dataDir,{cacheDir,workerTimeoutMs=600000,WorkerClass=Worker,getRoleModels=async()=>[],canRefresh=async()=>true,pollMs=60000,getMetadata,resourceProbe=assertCollectorResources}={}){
  let cached=null,cachedPipeline=null,pending=null,closed=false,checking=null,queued=null,lastError=null,failedKey=null,observed=null,retiring=Promise.resolve();
  const metadata=getMetadata||(()=>knowledgeStore(dataDir).status({synchronize:false}));
  const directory=()=>cacheDir||assistantIndexCacheDirectory(dataDir);
  const signature=(state,pipeline)=>`${state.revision}:${state.rows}:${pipeline}`;
  function lock(){
    fs.mkdirSync(directory(),{recursive:true});
    const file=path.join(directory(),'refresh.lock'),id=randomUUID();
    for(let attempt=0;attempt<2;attempt++){
      try{
        const fd=fs.openSync(file,'wx');let failure;
        try{fs.writeFileSync(fd,JSON.stringify({pid:process.pid,id}));}catch(error){failure=error;}finally{fs.closeSync(fd);}
        if(failure){fs.unlinkSync(file);throw failure;}
        return {file,id};
      }
      catch(error){
        if(error.code!=='EEXIST')throw error;
        let owner;try{owner=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}
        if(!owner?.pid)throw Object.assign(Error('其他进程正在准备岗位快照，请稍后查询'),{code:'ASSISTANT_SNAPSHOT_BUSY'});
        try{process.kill(owner.pid,0);}catch(probe){if(probe.code==='ESRCH'){fs.unlinkSync(file);continue;}}
        throw Object.assign(Error('其他进程正在更新岗位快照，已排队等待资源'),{code:'ASSISTANT_SNAPSHOT_BUSY'});
      }
    }
    throw Error('无法获得岗位快照更新锁');
  }
  function unlock(lease){try{if(JSON.parse(fs.readFileSync(lease.file,'utf8')).id===lease.id)fs.unlinkSync(lease.file);}catch(error){if(error.code!=='ENOENT')console.error('[assistant-snapshot-unlock]',String(error.code||error.message));}}
  function status(){
    const growth=snapshotGrowth(cached?.report.candidate_rows,observed?.rows??0);
    return {...growth,available:!!cached,status:pending?'updating':queued?'queued':lastError?'failed':cached?'ready':'not_built',
      source_revision:cached?.report.revision??null,current_revision:observed?.revision??null,
      generated_at:cached?.report.snapshot_generated_at||cached?.report.generated_at||null,
      stale:!!cached&&cached.report.revision!==observed?.revision,reason:queued?.reason||pending?.reason||null,waiting_for:queued?.message||null,
      roles:Object.entries(cached?.roleSnapshots||{}).map(([role,s])=>({role,rows:s.jobs.length,model_version:s.model_version})),
      progress:pending?.progress||null,error:lastError,concurrency:1};
  }
  function presented(){return {...cached,report:{...cached.report,snapshot:status()}};}
  function finish(task,error,index){
    if(pending!==task)return;pending=null;clearTimeout(task.timer);retiring=task.worker.terminate().then(()=>unlock(task.lease));
    if(error){
      lastError={code:error.code||'ASSISTANT_SNAPSHOT_FAILED',message:String(error.message).slice(0,500)};
      if(error.code==='ASSISTANT_SNAPSHOT_QUEUED'){queued={reason:task.reason,message:error.message};failedKey=null;}
      else{failedKey=task.key;queued=null;}
    }
    else{
      cached=index;cachedPipeline=task.pipeline;lastError=null;failedKey=null;queued=null;
      console.info('[assistant-snapshot-ready]',JSON.stringify({revision:index.report.revision,rows:index.report.candidate_rows,reason:task.reason}));
    }
    for(const waiter of task.waiters){waiter.signal?.removeEventListener('abort',waiter.abort);error?waiter.reject(error):waiter.resolve(presented());}
    task.waiters.clear();
  }
  function start(state,pipeline,models,{background=false,force=false,reuseLatest=false,allowBuild=true,reason='initial'}={}){
    const lease=lock();let worker;
    try{worker=new WorkerClass(new URL('./assistant_index_worker.mjs',import.meta.url),{workerData:{dataDir:path.resolve(dataDir),cacheDir:directory(),models,force,reuseLatest,allowBuild},execArgv:process.execArgv.filter(arg=>!arg.startsWith('--input-type'))});}
    catch(error){unlock(lease);throw error;}
    const task={worker,lease,pipeline,background,reason,key:signature(state,pipeline),waiters:new Set(),progress:null};pending=task;
    task.timer=setTimeout(()=>finish(task,Object.assign(Error('岗位快照更新超时，旧快照保留，不自动重复重试。'),{code:'ASSISTANT_INDEX_TIMEOUT'})),workerTimeoutMs);task.timer.unref?.();
    worker.on('message',event=>{
      if(pending!==task)return;
      if(event.type==='progress'){task.progress=event.progress;for(const waiter of task.waiters){try{waiter.onProgress?.(event.progress);}catch{}}}
      else if(event.type==='result')finish(task,null,event.index);
      else if(event.type==='error')finish(task,Object.assign(Error(event.message),{code:event.code}));
    });
    worker.on('error',error=>finish(task,error));
    worker.on('exit',code=>{if(pending===task)finish(task,Error(`岗位索引工作线程退出（${code}），未发布不完整快照`));});
    return task;
  }
  function wait(task,{signal,onProgress}={}){
    return new Promise((resolve,reject)=>{
      const waiter={resolve,reject,signal,onProgress};
      waiter.abort=()=>{
        task.waiters.delete(waiter);signal?.removeEventListener('abort',waiter.abort);reject(abortReason(signal));
        if(pending===task&&!task.background&&!task.waiters.size){pending=null;clearTimeout(task.timer);retiring=task.worker.terminate().then(()=>unlock(task.lease));}
      };
      task.waiters.add(waiter);signal?.addEventListener('abort',waiter.abort,{once:true});
      try{onProgress?.(task.progress||{phase:'index_loading',message:'正在读取已保存岗位快照；首次生成时在后台筛选岗位'});}catch{}
      if(signal?.aborted)waiter.abort();
    });
  }
  async function inputs(){
    const state=await metadata(),models=await getRoleModels();observed=state;
    return {state,models,pipeline:assistantClassificationVersion(models)};
  }
  async function resources(){
    const allowed=await canRefresh();if(allowed!==true)return typeof allowed==='string'?allowed:'等待采集、标注或分析任务释放资源';
    try{await resourceProbe();}catch(error){return error.message;}
    if(os.freemem()<512*1024**2)return '可用物理内存不足512MB，等待资源';
    await fs.promises.mkdir(directory(),{recursive:true});
    const disk=await fs.promises.statfs(directory());
    const needed=Math.max(256*1024**2,observed.rows*8192);
    if(Number(disk.bavail)*Number(disk.bsize)<needed)return '快照磁盘预留空间不足，等待资源';
    return true;
  }
  function need(state,pipeline){
    if(!cached)return 'initial';
    if(cachedPipeline!==pipeline)return 'classifier_changed';
    return snapshotGrowth(cached.report.candidate_rows,state.rows).reached?'growth_20_percent':null;
  }
  async function check({manual=false}={}){
    if(closed)throw Error('岗位索引服务已关闭');
    if(manual)queued={reason:'manual',force:true};
    if(checking)return checking;
    checking=(async()=>{
      await retiring;
      const {state,models,pipeline}=await inputs();if(closed)return status();
      if(pending&&pending.pipeline!==pipeline){finish(pending,Error('分类器目录已更新，停止旧版快照任务'));await retiring;}
      const reason=queued?.force?'manual':need(state,pipeline);
      if(!reason){queued=null;return status();}
      if(pending)return status();
      if(!manual&&failedKey===signature(state,pipeline))return status();
      queued={reason,force:!!queued?.force};
      const available=await resources();if(closed)return status();
      if(available!==true){queued.message=available;return status();}
      if(!pending){const force=queued.force;start(state,pipeline,models,{background:true,force,reuseLatest:reason==='initial'&&!force,reason});}
      return status();
    })().finally(()=>checking=null);
    return checking;
  }
  const timer=pollMs>0?setInterval(()=>{void check().catch(error=>{lastError={code:error.code||'SNAPSHOT_CHECK_FAILED',message:String(error.message).slice(0,500)};});},pollMs):null;
  timer?.unref?.();
  return {metadata,
    async load({signal,onProgress,forceRefresh=false}={}){
      if(closed)throw Error('岗位索引服务已关闭');
      await waitForRequest(()=>retiring,signal);
      const {state,models,pipeline}=await waitForRequest(inputs,signal);signal?.throwIfAborted();
      if(pending&&pending.pipeline!==pipeline){finish(pending,Error('分类器目录已更新，请重新查询；不会复用已删除分类器的结果'));await retiring;}
      if(cached&&cachedPipeline===pipeline&&!forceRefresh){
        if(need(state,pipeline)){void check().catch(error=>{lastError={code:error.code||'SNAPSHOT_CHECK_FAILED',message:error.message};});}
        onProgress?.({phase:'index_ready',message:`已读取岗位快照 · ${cached.jobs.length.toLocaleString('zh-CN')} 条；数据累计增长20%后后台更新`});
        return presented();
      }
      const available=pending?true:await resources();signal?.throwIfAborted();
      const task=pending||start(state,pipeline,models,{force:forceRefresh,reuseLatest:!forceRefresh,allowBuild:available===true,reason:forceRefresh?'manual':cached?'classifier_changed':'initial'});
      const result=await wait(task,{signal,onProgress});
      if(!closed&&need(state,pipeline))void check().catch(()=>{});
      return result;
    },
    snapshotStatus:async()=>{
      const {pipeline}=await inputs(),snapshot=status();
      return cached&&pipeline!==cachedPipeline?{...snapshot,available:false,status:'invalidated',reason:'classifier_changed'}:snapshot;
    },
    checkSnapshots:check,
    refreshSnapshots:()=>check({manual:true}),
    searchCandidates:createCandidateSearch(dataDir),
    async consultationIndex(){
      const {state,pipeline}=await inputs();
      if(cached&&cachedPipeline===pipeline){if(need(state,pipeline))void check().catch(()=>{});return presented();}
      return consultationSnapshot(state);
    },
    close(){closed=true;if(timer)clearInterval(timer);if(pending)finish(pending,Error('岗位索引服务已关闭'));cached=null;cachedPipeline=null;},
  };
}
