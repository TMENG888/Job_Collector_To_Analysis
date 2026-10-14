import {isCollectionStage} from './coordinator_policy.mjs';

// Only collection failures may trigger delivery. Never recurse on export errors,
// run after a user pause, or spend more resources after storage/resource failure.
export function canDeliverPartial({stage,code,userPaused=false,signal=null}) {
  return isCollectionStage(stage) && !userPaused && !signal &&
    Number.isInteger(code) && code > 0 && code <= 125 && ![42,43].includes(code);
}

export async function deliverPartial({cause,count,run,finish}) {
  if(!canDeliverPartial(cause))return {skipped:true};
  const available=await count(); // Also verifies same-task directory ownership.
  if(available===0)return {skipped:true,reason:'no_valid_records'};
  for(const stage of ['finalize','workbook']) {
    const result=await run(stage);
    if(result?.paused || result?.code!==0)throw Error(`异常收尾${stage}未完成，不更新交付成功状态`);
  }
  await finish({available,cause});
  return {delivered:true,available};
}
