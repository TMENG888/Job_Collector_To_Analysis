import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {withAccountLock} from './collection_concurrency.mjs';
import {writeJsonAtomic} from './collector_storage.mjs';
import {nativeCrashMessage} from './collector_resources.mjs';

const settings=JSON.parse(process.argv[2]);
const root=path.dirname(fileURLToPath(import.meta.url));
const children=new Set();
let paused=0;
function stopChildren() {
  for(const child of children) {
    if(process.platform==='win32')spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true});
    else child.kill('SIGTERM');
  }
}
process.on('SIGTERM',()=>{stopChildren();process.exit(43);});
async function run(key,args,extraEnv={}) {
  if(paused)return {platform:key,code:paused};
  console.log(`[并发渠道] ${key} 开始；各平台保留独立断点`);
  const child=spawn(process.execPath,args,{cwd:path.dirname(root),env:{...process.env,...extraEnv,JOB_COLLECTOR_COORDINATOR_PID:String(process.pid)},windowsHide:true,stdio:['ignore','pipe','pipe']});
  children.add(child);
  child.stdout.pipe(process.stdout,{end:false});child.stderr.pipe(process.stderr,{end:false});
  const code=await new Promise(resolve=>{
    child.once('error',error=>{console.error(`[${key}] ${error.message}`);resolve(1);});
    child.once('close',value=>resolve(value??1));
  });
  children.delete(child);
  if([42,43].includes(code)||nativeCrashMessage(code)){paused=nativeCrashMessage(code)?43:code;stopChildren();}
  console.log(`[并发渠道] ${key} 结束，代码 ${code}；其他渠道不因普通失败停止`);
  return {platform:key,code};
}
const jobs=[];
let lastQueueLog=0;
if(settings.public)jobs.push(run('public',[path.join(root,'collect_public_job_platforms.mjs'),settings.publicConfigPath,settings.outputDir]));
if(settings.zhaopin)jobs.push(withAccountLock(path.join(settings.lockDir,'zhaopin-account.lock'),process.env.JOB_COLLECTOR_TASK_ID,async()=>run('zhaopin',[
  path.join(root,'collect_logged_zhaopin_batch.mjs'),settings.outputDir,String(settings.candidateTarget),settings.zhaopinConfigPath,
]),{shouldStop:()=>Boolean(paused),onWait:()=>{
  if(Date.now()-lastQueueLog>30000){lastQueueLog=Date.now();console.log('[账号排队] 智联会话被其他任务使用；等待释放，公开渠道继续运行');}
}}).catch(error=>({platform:'zhaopin',code:1,error:error.message})));
const results=await Promise.all(jobs);
if(settings.zhaopin && !paused && results.find(row=>row.platform==='zhaopin')?.code===0) {
  const checkpointDir=path.join(settings.outputDir,'断点数据','智联招聘');
  let deferred=false;
  for(const name of await fs.readdir(checkpointDir).catch(()=>[])) {
    if(!name.endsWith('.json'))continue;
    const checkpoint=await fs.readFile(path.join(checkpointDir,name),'utf8').then(JSON.parse);
    if(checkpoint.low_yield || checkpoint.reason==='low_yield_deferred' && checkpoint.remaining?.length)deferred=true;
  }
  if(deferred) {
    console.log('[低收益补采] 其他渠道已处理，重新排队恢复智联暂缓条件；不将低收益认定为穷尽');
    const recovered=await withAccountLock(path.join(settings.lockDir,'zhaopin-account.lock'),process.env.JOB_COLLECTOR_TASK_ID,()=>run('zhaopin',[
      path.join(root,'collect_logged_zhaopin_batch.mjs'),settings.outputDir,String(settings.candidateTarget),settings.zhaopinConfigPath,
    ],{JOB_COLLECTOR_YIELD_RECOVERY:'1'}));
    results.push({...recovered,recovery:true});
  }
}
await writeJsonAtomic(path.join(settings.outputDir,'并发渠道状态.json'),{task_id:process.env.JOB_COLLECTOR_TASK_ID,updatedAt:new Date().toISOString(),results});
process.exitCode=paused|| (results.some(result=>result.code!==0)?44:0);
