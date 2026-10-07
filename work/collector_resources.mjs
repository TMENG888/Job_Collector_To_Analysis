import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import os from 'node:os';
const exec=promisify(execFile),GB=1024**3;
let cache=null,pending=null;
export function resourceDecision(snapshot,reserveBytes=2*GB){
  const limit=Number(snapshot.CommitLimit),used=Number(snapshot.CommittedBytes),physical=Number(snapshot.AvailableMBytes)*1024**2;
  if(!Number.isFinite(limit)||!Number.isFinite(used)||limit<=0||used<0||!Number.isFinite(physical))return {ok:false,message:'无法可靠读取系统内存状态，暂不启动采集'};
  const remaining=Math.max(0,limit-used);
  const ok=remaining>=reserveBytes&&physical>=512*1024**2;
  return {ok,remainingBytes:remaining,usedBytes:used,limitBytes:limit,message:ok?'系统资源可用':`系统可提交内存不足（剩余 ${(remaining/GB).toFixed(2)}GB，要求至少 ${(reserveBytes/GB).toFixed(1)}GB），已暂停；请关闭不需要的程序或由管理员检查分页文件/系统资源，再从断点续采`};
}
export async function readMemorySnapshot(){
  if(process.platform!=='win32')return {CommitLimit:os.totalmem(),CommittedBytes:os.totalmem()-os.freemem(),AvailableMBytes:os.freemem()/1024**2};
  if(cache&&Date.now()-cache.at<4000)return cache.data;
  if(!pending)pending=exec('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoProfile','-NonInteractive','-Command','Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory | Select-Object CommittedBytes,CommitLimit,AvailableMBytes | ConvertTo-Json -Compress'],{windowsHide:true,timeout:15000,maxBuffer:16384}).then(({stdout})=>{const data=JSON.parse(stdout.trim());cache={at:Date.now(),data};return data;}).finally(()=>pending=null);
  return pending;
}
export async function assertCollectorResources(reserveBytes=2*GB,probe=readMemorySnapshot){
  let snapshot;
  try{snapshot=await probe();}catch(cause){throw Object.assign(new Error('系统资源检查失败，安全暂停采集；请检查系统资源后重试'),{code:'RESOURCE_PRESSURE',stopChannel:true,cause});}
  const result=resourceDecision(snapshot,reserveBytes);
  if(!result.ok)throw Object.assign(new Error(result.message),{code:'RESOURCE_PRESSURE',stopChannel:true,snapshot});
  return result;
}
export function nativeCrashMessage(code){
  if((Number(code)>>>0)===0xc0000409)return '采集进程发生 Windows 原生异常 0xC0000409（非网站接口错误）；近期系统虚拟内存不足，请检查系统资源，保留断点且不自动重启';
  if((Number(code)>>>0)===0xc0000017)return '采集进程因 Windows 内存不足退出；请释放系统资源后从断点续采';
  return '';
}
