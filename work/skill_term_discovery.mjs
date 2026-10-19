import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {readMemorySnapshot,resourceDecision} from './collector_resources.mjs';
import {skillEvidenceSections,TERM_MODEL,TERM_PIPELINE} from './skill_term_review.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const python=path.join(root,'work/wordcloud_uie_env',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const assets=['gliner_config.json','model.safetensors','encoder/config.json','encoder/spm.model'];
export async function termModelAvailability(){
  const missing=[];
  for(const file of [python,...assets.map(f=>path.join(root,'work/wordcloud_uie_models/gliner-multi-v2.1',f))])if(!await fs.stat(file).catch(()=>null))missing.push(path.basename(file));
  return {available:missing.length===0,missing,model:TERM_MODEL,pipeline:TERM_PIPELINE,local_only:true};
}

export function createTermDiscovery(store,{probe=readMemorySnapshot}={}){
  let starting=false,child=null;
  async function start({limit=20,taskId=''}={}){
    if(starting||child)throw new Error('已有新词扫描正在执行');starting=true;
    try{
      const available=await termModelAvailability();if(!available.available)throw new Error(`本机模型尚未安装完整：${available.missing.join('、')}`);
      const memory=await probe();const decision=resourceDecision(memory,4*1024**3);
      if(!decision.ok||Number(memory.AvailableMBytes)<3584)throw new Error('新词扫描资源不足：至少需要3.5GB可用物理内存和4GB可提交内存；原采集及规则分析不受影响');
      const jobs=await store.termReview.batch({limit,taskId});
      if(!jobs.length)return {status:'completed',completed:0,total:0,added:0,message:'该范围当前内容已扫描，或没有可扫描的正文'};
      const run=await store.termReview.beginRun({total:jobs.length,taskId,model:TERM_MODEL,pipeline:TERM_PIPELINE,started_at:new Date().toISOString()});
      // Do not await: bounded work runs outside the HTTP request and exits when done.
      execute(run,jobs).catch(()=>{});
      return run;
    }finally{starting=false;}
  }
  async function execute(run,jobs){
    let errorMessage='',chain=Promise.resolve(),timer,worker;const processed=new Set();
    try{
      worker=spawn(python,[path.join(root,'work/discover_skill_terms.py')],{cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',PYTHONIOENCODING:'utf-8',JOB_TERM_PARENT_PID:String(process.pid)}});child=worker;
      timer=setTimeout(()=>{errorMessage='本批扫描超时，已停止；已完成岗位保留，可再次分批扫描';worker.kill();},15*60*1000);timer.unref();
      const lines=createInterface({input:worker.stdout});let outputBytes=0;
      worker.stdout.on('data',chunk=>{outputBytes+=chunk.length;if(outputBytes>8*1024**2){errorMessage='模型输出超限';worker.kill();}});
      lines.on('line',line=>{
        if(!line.startsWith('@@TERMS@@'))return;
        chain=chain.then(async()=>{
          const result=JSON.parse(line.slice(9));const job=jobs.find(j=>j.job_key===result.job_key&&j.content_hash===result.content_hash);
          if(!job||processed.has(job.job_key))throw new Error('模型返回了不属于本批的岗位或重复结果');
          const saved=await store.termReview.record(job,result.hits);processed.add(job.job_key);
          run.completed++;run.added+=saved.added;run.stale=(run.stale||0)+Number(!!saved.stale);run.peak_rss_mib=Math.max(run.peak_rss_mib||0,Number(result.rss_mib)||0);await store.termReview.updateRun(run);
        }).catch(error=>{errorMessage=error.message;worker.kill();});
      });
      worker.stderr.on('data',chunk=>{const message=String(chunk);const index=message.indexOf('@@ERROR@@');if(index>=0)errorMessage=message.slice(index+9).trim().slice(0,300);});
      const closed=new Promise((resolve,reject)=>{worker.once('error',reject);worker.once('close',code=>resolve(code));});
      closed.catch(()=>{}); // Attach immediately, including spawn failure during DB persistence.
      worker.stdin.on('error',()=>{});
      run.worker_pid=worker.pid;await store.termReview.updateRun(run);
      worker.stdin.end(JSON.stringify({docs:jobs.map(j=>({job_key:j.job_key,content_hash:j.content_hash,sections:skillEvidenceSections(j.raw.job_description)}))}));
      const code=await closed;await chain;
      if(code!==0||errorMessage||processed.size!==jobs.length)throw new Error(errorMessage||`本机模型进程中断（代码${code}），已完成岗位保留，可重试未完成部分`);
      run.status='completed';
    }catch(error){if(worker?.exitCode===null)worker.kill();run.status='failed';run.message=String(error.message).slice(0,300);}
    finally{clearTimeout(timer);child=null;run.finished_at=new Date().toISOString();await store.termReview.updateRun(run);}
  }
  return {start,async status(){return {model:await termModelAvailability(),run:await store.termReview.latestRun()};}};
}
