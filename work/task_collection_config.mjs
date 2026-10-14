import fs from 'node:fs/promises';
import {writeJsonAtomic} from './collector_storage.mjs';

// Older UI services wrote only the primary keyword to public configuration.
// Reconcile at launch, without resetting checkpoints or request limits.
export async function synchronizePublicKeywords(task) {
  const config = JSON.parse(await fs.readFile(task.publicConfigPath, 'utf8'));
  if (config.task_id !== task.id) throw new Error('公开采集配置不属于当前任务，拒绝启动');
  const keywords = [...new Set([task.primaryKeyword, ...(task.keywords || [])].map(value=>String(value||'').trim()).filter(Boolean))];
  if (!keywords.length) throw new Error('任务没有采集关键词');
  const changed = JSON.stringify(config.keywords) !== JSON.stringify(keywords);
  if (changed) await writeJsonAtomic(task.publicConfigPath, {...config, keywords});
  return {changed, keywords};
}

export function retainedChannelErrors(manifest, taskId, platform, policy) {
  if (policy !== 'skip' || !taskId || manifest?.task_id !== taskId) return [];
  return (manifest.platforms?.[platform]?.errors || []).filter(error=>error.stopChannel);
}
