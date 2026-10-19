// An absent goal means bounded exploration of configured conditions, not infinity
// requests and not an invented 100000-row delivery target.
export const untilExhausted=task=>task?.collectUntilExhausted===true||task?.collectionGoal==='available_scope';
export const goalText=task=>untilExhausted(task)?'按渠道可访问范围采集（无目标条数）':`${task.targetRows}条`;
export function collectionGoal(body={}){
  const unbounded=body.collectUntilExhausted===true||body.collectionGoal==='available_scope'||body.targetRows==null||body.targetRows==='';
  if(unbounded)return {collectUntilExhausted:true,collectionGoal:'available_scope',targetRows:null,candidateTarget:150000};
  const targetRows=Number(body.targetRows);
  if(!Number.isSafeInteger(targetRows)||targetRows<1||targetRows>100000)throw Error('目标数量须为1–100000的整数，或留空按渠道范围采集');
  const candidate=body.candidateTarget==null||body.candidateTarget===''?Math.min(150000,Math.ceil(targetRows*1.55)):Number(body.candidateTarget);
  if(!Number.isSafeInteger(candidate)||candidate<1||candidate>150000)throw Error('候选预算须为1–150000的整数');
  return {collectUntilExhausted:false,collectionGoal:'row_target',targetRows,candidateTarget:Math.max(targetRows,candidate)};
}
export function collectionOutcome(task,{valid,reason,issues=[]}){
  if(!untilExhausted(task))return {status:valid>=task.targetRows?'completed':'partial',targetReached:valid>=task.targetRows};
  // A depleted queue may contain page/row budgets, stalls and access blocks.
  // Never translate that into "the whole platform is exhausted".
  return {status:issues.length||['channels_blocked','round_budget_finished','no_direct_http_channels'].includes(reason)?'partial':'completed',targetReached:false};
}
