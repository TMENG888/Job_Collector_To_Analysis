export const publicCountChannels=['shixiseng','iguopin','mohrss','jobonline','job51','liepin'];
const extraChannels=['zhaopin','yupao','boss','nowcoder'];
const count=value=>Number.isFinite(Number(value))?Math.max(0,Number(value)):0;
// The integrated manifest total already contains session channels. Sum distinct
// channel buckets, never add zhaopin to that integrated total a second time.
export function collectionCounts({native={},live={},manifest=null,csv={}}={}){
  const platformCounts={};
  for(const key of [...publicCountChannels,...extraChannels])platformCounts[key]=Math.max(count(native.platformCounts?.[key]),count(live.platformCounts?.[key]),count(manifest?.platforms?.[key]?.rows),count(csv[key]));
  let publicRows=publicCountChannels.reduce((n,key)=>n+platformCounts[key],0);
  // Legacy manifests without channel buckets described the public-only stage.
  // Retain that compatibility only when there is no detailed manifest contract.
  if(!manifest?.platforms)publicRows=Math.max(publicRows,count(manifest?.total_rows),count(live.publicRows));
  return {platformCounts,publicRows,zhaopinRows:platformCounts.zhaopin,yupaoRows:platformCounts.yupao,bossRows:platformCounts.boss,candidates:publicRows+extraChannels.reduce((n,key)=>n+platformCounts[key],0)};
}
