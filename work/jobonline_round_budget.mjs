const positive=(value,fallback)=>Number.isFinite(Number(value))&&Number(value)>0?Math.floor(Number(value)):fallback;
export function jobonlineRoundBudget(settings={},existing=0,{targetRemaining=Infinity}={}){
  const start=Math.max(0,Math.floor(Number(existing)||0));
  const perRound=Math.min(1000,positive(settings.maxRows,1000));
  // Missing totalMaxRows preserves the old explicit whole-task quota.
  const totalLimit=positive(settings.totalMaxRows,perRound);
  const remaining=Number.isFinite(targetRemaining)?Math.max(0,Math.floor(targetRemaining)):Infinity;
  const limit=Math.min(totalLimit,start+perRound,start+remaining);
  return {start,perRound,totalLimit,limit,maxNewRows:Math.max(0,limit-start),mode:settings.totalMaxRows?'checkpoint_rounds':'legacy_task_cap'};
}
