import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {writeJsonAtomic} from './collector_storage.mjs';
import {nativeCrashMessage} from './collector_resources.mjs';

const settings=JSON.parse(process.argv[2]);
const transportPauses=[];
// 统一 HTTP 直连：智联已并入 public（会话直连），不再启动独立 zhaopin worker。
// 兼容旧调用：若只请求 zhaopin，则改为 public 采集（智联已在其中）。
if(settings.zhaopin && !settings.public) settings.public=true;
settings.zhaopin=false;
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
if(settings.public)jobs.push(run('public',[path.join(root,'collect_public_job_platforms.mjs'),settings.publicConfigPath,settings.outputDir]));
const results=await Promise.all(jobs);
results.push(...transportPauses);
await writeJsonAtomic(path.join(settings.outputDir,'并发渠道状态.json'),{task_id:process.env.JOB_COLLECTOR_TASK_ID,updatedAt:new Date().toISOString(),results});
process.exitCode=paused|| (results.some(result=>result.code!==0)?44:0);
