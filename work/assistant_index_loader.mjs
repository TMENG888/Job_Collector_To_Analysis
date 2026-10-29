import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {knowledgeStore} from './job_knowledge_store.mjs';
import {knowledgeDatabasePath} from './knowledge_storage.mjs';
import {assistantClassificationVersion} from './assistant_classification_cache.mjs';
import {abortReason,waitForRequest} from './assistant_request_budget.mjs';
import {createCandidateSearch,consultationSnapshot} from './job_assistant_candidates.mjs';

export function assistantIndexCacheDirectory(dataDir){
  const scope=createHash('sha256').update(path.resolve(dataDir)+'\n'+knowledgeDatabasePath(dataDir)).digest('hex').slice(0,20);
  if(process.platform==='win32'){
    if(!fs.existsSync('E:/'))throw Error('E 盘不可用，无法建立岗位检索缓存；不会改写到 C 盘');
    return path.join('E:/Codex/work/job-assistant-index-cache',scope);
  }
  return path.join(os.tmpdir(),'job-assistant-index-cache',scope);
}
export function createBackgroundAssistantStore(dataDir,{cacheDir,workerTimeoutMs=150000,WorkerClass=Worker}={}){
  let cached=null,cachedRevision=null,pending=null,closed=false;
  const pipeline=assistantClassificationVersion();
  const metadata=()=>knowledgeStore(dataDir).status({synchronize:false});
  function finish(task,error,index){
    if(pending!==task)return;pending=null;clearTimeout(task.timer);
    void task.worker.terminate();
    if(!error){cached=index;cachedRevision=index.report.revision==null?task.revision:`${index.report.revision}:${pipeline}`;}
    for(const waiter of task.waiters){waiter.signal?.removeEventListener('abort',waiter.abort);error?waiter.reject(error):waiter.resolve(index);}
    task.waiters.clear();
  }
  function start(revision){
    const worker=new WorkerClass(new URL('./assistant_index_worker.mjs',import.meta.url),{workerData:{dataDir:path.resolve(dataDir),cacheDir:cacheDir||assistantIndexCacheDirectory(dataDir)},execArgv:process.execArgv.filter(arg=>!arg.startsWith('--input-type'))});
    const task={worker,revision,waiters:new Set(),progress:null};pending=task;
    task.timer=setTimeout(()=>finish(task,Object.assign(new Error('岗位索引构建超时，已停止工作线程；已完成的分类缓存保留，不自动重试。'),{code:'ASSISTANT_INDEX_TIMEOUT'})),workerTimeoutMs);
    task.timer.unref?.();
    worker.on('message',event=>{
      if(pending!==task)return;
      if(event.type==='progress'){task.progress=event.progress;for(const waiter of task.waiters){try{waiter.onProgress?.(event.progress);}catch{}}}
      else if(event.type==='result')finish(task,null,event.index);
      else if(event.type==='error')finish(task,Object.assign(new Error(event.message),{code:event.code}));
    });
    worker.on('error',error=>finish(task,error));
    worker.on('exit',code=>{if(pending===task)finish(task,new Error(`岗位索引工作线程退出（${code}），未发布不完整索引`));});
    return task;
  }
  return {metadata,
    async load({signal,onProgress}={}){
      if(closed)throw Error('岗位索引服务已关闭');
      const state=await waitForRequest(metadata,signal),revision=`${state.revision}:${pipeline}`;
      if(signal?.aborted)throw abortReason(signal);
      if(cached&&cachedRevision===revision){onProgress?.({phase:'index_ready',completed:cached.report.candidate_rows,total:cached.report.candidate_rows,message:`已复用岗位检索索引 · ${cached.jobs.length.toLocaleString('zh-CN')} 条可检索岗位`});return cached;}
      // A running build is a consistent DB snapshot. All callers share that
      // snapshot; a newer revision is picked up by the next load, never mixed.
      const task=pending||start(revision);
      return new Promise((resolve,reject)=>{
        const waiter={resolve,reject,signal,onProgress};
        waiter.abort=()=>{
          task.waiters.delete(waiter);signal?.removeEventListener('abort',waiter.abort);reject(abortReason(signal));
          if(pending===task&&!task.waiters.size){pending=null;clearTimeout(task.timer);void task.worker.terminate();}
        };
        task.waiters.add(waiter);signal?.addEventListener('abort',waiter.abort,{once:true});
        try{onProgress?.(task.progress||{phase:'index_loading',message:'正在独立线程读取岗位库；后台可继续响应，可随时停止本轮'});}catch{}
        if(signal?.aborted)waiter.abort();
      });
    },
    searchCandidates:createCandidateSearch(dataDir),
    async consultationIndex(){const meta=await metadata();return cached?.report.revision===meta.revision?cached:consultationSnapshot(meta);},
    close(){closed=true;cached=null;cachedRevision=null;if(pending)finish(pending,new Error('岗位索引服务已关闭'));},
  };
}
