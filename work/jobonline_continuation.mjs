export function jobonlineContinuation({budget,size,checkpoints,errors=[],deferred=false,maxPages}){
  if(!budget||budget.mode!=='checkpoint_rounds')return {safe:false,reason:'single_round'};
  const scopedCodes=['pagination_stalled','legacy_pagination_unverified'];
  const blockingErrors=errors.filter(error=>!scopedCodes.includes(error.code)&&error.stopChannel!==false);
  if(blockingErrors.length)return {safe:false,reason:'channel_blocked'};
  if(size>=budget.totalLimit)return {safe:false,reason:'total_limit'};
  const eligible=checkpoints.filter(c=>!scopedCodes.includes(c.stop_reason)&&!c.low_yield&&c.completed===false&&Number(c.nextPageNo||c.pageNo||1)<=maxPages);
  if(!deferred&&eligible.length&&size>=budget.limit&&size>budget.start)return {safe:true,reason:'round_limit'};
  if(errors.some(error=>error.code==='pagination_stalled')||checkpoints.some(c=>c.stop_reason==='pagination_stalled'))return {safe:false,reason:'pagination_stalled'};
  if(checkpoints.some(c=>c.stop_reason==='legacy_pagination_unverified'))return {safe:false,reason:'legacy_pagination_unverified'};
  if(deferred||checkpoints.some(c=>c.low_yield))return {safe:false,reason:'low_yield_deferred'};
  if(size>=budget.totalLimit)return {safe:false,reason:'total_limit'};
  const unfinished=checkpoints.filter(c=>c.completed===false);
  if(!unfinished.length)return {safe:false,reason:checkpoints.some(c=>c.completion_reason==='reported_window_end')?'reported_window_end':'source_finished'};
  if(!unfinished.some(c=>Number(c.nextPageNo||c.pageNo||1)<=maxPages))return {safe:false,reason:'page_limit'};
  if(size>=budget.limit&&size>budget.start)return {safe:true,reason:'round_limit'};
  return {safe:false,reason:'no_round_growth'};
}
