import fs from 'node:fs/promises';
import path from 'node:path';
// Only a completed healthy round may schedule another round. Never retry a
// blocked channel, a user pause, source exhaustion, or a round without growth.
export async function runStructuredTargetRounds({task,count,run,onRound=async()=>{},isCancelled=()=>false}){
  if(!task.platforms?.includes('jobonline'))return {rounds:0,reason:'not_enabled'};
  const config=JSON.parse(await fs.readFile(task.publicConfigPath,'utf8'));
  if(config.task_id!==task.id)throw Error('目标执行配置任务 ID 不匹配');
  const settings=config.platforms?.jobonline;
  if(!settings?.enabled||!settings.totalMaxRows)return {rounds:0,reason:'single_round'};
  const target=Number(task.targetRows);
  if(!Number.isSafeInteger(target)||target<1)throw Error('目标执行数量无效');
  const perRound=Math.max(1,Math.min(1000,Number(settings.maxRows)||1000));
  const maxRounds=Math.min(151,Math.ceil(Number(settings.totalMaxRows)/perRound)+1);
  let valid=await count(),rounds=0;
  while(valid<target&&rounds<maxRounds){
    if(isCancelled())return {rounds,valid,reason:'paused',paused:true};
    const manifest=JSON.parse(await fs.readFile(path.join(task.outputDir,'采集清单.json'),'utf8'));
    if(manifest.task_id!==task.id)throw Error('目标执行采集清单任务 ID 不匹配');
    const channel=manifest.platforms?.jobonline;
    if(channel?.errors?.length)return {rounds,valid,reason:'channel_blocked'};
    if(channel?.continuation?.safe!==true||channel.continuation.reason!=='round_limit')return {rounds,valid,reason:channel?.continuation?.reason||'source_or_budget_finished'};
    const before=valid;
    rounds++;await onRound({round:rounds,valid,target,perRound});
    if(isCancelled())return {rounds:rounds-1,valid,reason:'paused',paused:true};
    const result=await run();
    if(result?.paused)return {rounds,valid:await count(),reason:'paused',paused:true};
    valid=await count();
    if(valid<=before)return {rounds,valid,reason:'no_valid_growth'};
  }
  return {rounds,valid,reason:valid>=target?'target_reached':'round_budget_finished',targetReached:valid>=target};
}
