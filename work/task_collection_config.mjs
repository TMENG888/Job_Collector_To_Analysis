import fs from 'node:fs/promises';
import {writeJsonAtomic} from './collector_storage.mjs';

// Older UI services wrote only the primary keyword to public configuration.
// Reconcile at launch, without resetting checkpoints or request limits.
export async function synchronizePublicKeywords(task) {
  const config = JSON.parse(await fs.readFile(task.publicConfigPath, 'utf8'));
  if (config.task_id !== task.id) throw new Error('公开采集配置不属于当前任务，拒绝启动');
  const keywords = [...new Set([task.primaryKeyword, ...(task.keywords || [])].map(value=>String(value||'').trim()).filter(Boolean))];
  if (!keywords.length) throw new Error('任务没有采集关键词');
  let logged=null,loggedChanged=false;
  if(task.platforms?.includes('zhaopin')&&task.zhaopinConfigPath){
    logged=JSON.parse(await fs.readFile(task.zhaopinConfigPath,'utf8'));
    if(logged.task_id!==task.id)throw Error('智联采集配置不属于当前任务，拒绝同步关键词');
    loggedChanged=JSON.stringify(logged.keywords)!==JSON.stringify(keywords);
  }
  const changed = JSON.stringify(config.keywords) !== JSON.stringify(keywords);
  if (changed) await writeJsonAtomic(task.publicConfigPath, {...config, keywords});
  if(loggedChanged)await writeJsonAtomic(task.zhaopinConfigPath,{...logged,keywords});
  return {changed:changed||loggedChanged, keywords};
}

export const isConditionScopedStop=error=>['pagination_stalled','legacy_pagination_unverified','empty_unverified'].includes(error?.code);

export function readCollectionRound(taskId,value=process.env.JOB_COLLECTION_ROUND){
  if(!value)return null;
  const round=JSON.parse(value);
  if(!taskId||round.task_id!==taskId||!Array.isArray(round.combinations)||round.combinations.length>3000)throw Error('采集轮次任务归属或条件无效');
  if(round.combinations.some(combo=>!combo?.platform||!combo.keyword||!combo.city?.name))throw Error('采集轮次缺少平台、关键词或城市');
  return round;
}

export function filterCollectionCombinations(round,platform,combinations){
  if(!round)return combinations;
  const key=combo=>JSON.stringify([combo.keyword,combo.city.name]);
  const configured=new Set(combinations.map(key));
  const selected=round.combinations.filter(combo=>combo.platform===platform);
  if(selected.some(combo=>!configured.has(key(combo))))throw Error('采集轮次条件超出已配置关键词或城市，拒绝启动');
  const allowed=new Set(selected.map(key));
  return combinations.filter(combo=>allowed.has(key(combo)));
}

export function retainedChannelErrors(manifest, taskId, platform, policy) {
  if (policy !== 'skip' || !taskId || manifest?.task_id !== taskId) return [];
  return (manifest.platforms?.[platform]?.errors || []).filter(error=>error.stopChannel&&!isConditionScopedStop(error));
}
