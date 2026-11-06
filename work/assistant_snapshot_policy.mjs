export const SNAPSHOT_GROWTH_PERCENT=20;
export function snapshotGrowth(baselineRows,currentRows){
  if(!Number.isSafeInteger(currentRows)||currentRows<0)throw Error('岗位总量无效，未安排快照更新');
  const known=Number.isSafeInteger(baselineRows)&&baselineRows>=0;
  const next=known&&baselineRows>0?baselineRows+Math.ceil(baselineRows*SNAPSHOT_GROWTH_PERCENT/100):1;
  return {threshold_percent:SNAPSHOT_GROWTH_PERCENT,baseline_rows:known?baselineRows:null,current_rows:currentRows,
    added_rows:known?currentRows-baselineRows:null,growth_rate:known&&baselineRows>0?(currentRows-baselineRows)/baselineRows:null,
    next_trigger_rows:next,reached:known&&(baselineRows===0?currentRows>0:currentRows>=next)};
}
