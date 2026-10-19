import fs from 'node:fs/promises';
import path from 'node:path';
import {collectionGoal} from './collection_goal.mjs';
import {writeJsonAtomic} from './collector_storage.mjs';

const read = async file => {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};

// Legacy tasks predate explicit collectionGoal. New explicitly bounded tasks
// remain bounded; migrating archived tasks must not restore or launch them.
export async function migrateLegacyCollectionGoals(tasks, {now = () => new Date().toISOString()} = {}) {
  let changed = 0;
  for (const task of tasks) {
    if (task.collectionGoal || task.goalMigration?.version === 1) continue;
    if (['running', 'stopping'].includes(task.status)) throw Error('请先暂停历史任务，再迁移采集目标');
    const updates = [], missing = [];
    const paths = new Map([
      [task.publicConfigPath, 'channel'], [task.zhaopinConfigPath, 'channel'],
      [task.profilePath, 'profile'],
    ].filter(([file]) => file));
    for (const [file, kind] of paths) {
      const config = await read(file);
      if (!config) { missing.push(file); continue; }
      if (config.task_id && config.task_id !== task.id) throw Error(`历史采集配置归属不匹配：${task.id}`);
      const goal = kind === 'profile'
        ? {target_rows: null, collect_until_exhausted: true}
        : {taskTargetRows: 0, collectUntilExhausted: true};
      updates.push([file, {...config, ...goal}]);
    }
    // Never recreate a lost output directory/owner or modify unowned data.
    if (task.outputDir) {
      const file = path.join(task.outputDir, '岗位配置.json');
      const owner = await read(path.join(task.outputDir, '任务归属.json'));
      if (owner?.task_id === task.id) {
        const profile = await read(file);
        if (profile) {
          if (profile.task_id && profile.task_id !== task.id) throw Error(`历史输出配置归属不匹配：${task.id}`);
          updates.push([file, {...profile, target_rows: null, collect_until_exhausted: true}]);
        } else missing.push(file);
      } else missing.push(file);
    }
    // Do not change channel page/row budgets, rate limits or any checkpoint.
    // Commit the task marker last: partial config writes are safe to retry.
    for (const [file, config] of updates) await writeJsonAtomic(file, config);
    task.goalMigration = {
      version: 1, at: now(), previousTargetRows: task.targetRows ?? null,
      previousCandidateTarget: task.candidateTarget ?? null, missingConfigPaths: missing,
    };
    Object.assign(task, collectionGoal({}));
    task.updatedAt = task.goalMigration.at;
    task.message = `${task.message || ''}；已取消原目标条数，旧进度描述仅为历史记录；暂停/受阻状态及渠道安全预算保留`;
    changed++;
  }
  return changed;
}
