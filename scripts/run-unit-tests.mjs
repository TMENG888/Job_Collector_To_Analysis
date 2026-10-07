import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tests = [
  'test_role_evidence_v2.mjs',
  'test_keyword_role_matcher.mjs',
  'test_rule_seed_keywords.mjs',
  'test_joint_job_expansion.mjs',
  'test_reviewed_job_labels.mjs',
  'test_platform_login_status.mjs',
  'test_zero_list_guard.mjs',
  'test_collector_resources.mjs',
  'test_task_dataset_scope.mjs',
  'test_salary_condition_statistics.mjs',
];
for (const name of tests) {
  console.log(`\n[unit] ${name}`);
  const result = spawnSync(process.execPath, [path.join('work', name)], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`\n${tests.length} 个单元测试脚本通过。`);
