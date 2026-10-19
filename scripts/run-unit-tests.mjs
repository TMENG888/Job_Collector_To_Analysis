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
  'test_collection_concurrency.mjs',
  'test_collection_resilience.mjs',
  'test_collection_yield.mjs',
  'test_collection_dashboard.mjs',
  'test_collector_storage.mjs',
  'test_live_collection_metrics.mjs',
  'test_partial_delivery.mjs',
  'test_channel_retirement.mjs',
  'test_task_collection_config.mjs',
  'test_coordinator_policy.mjs',
  'test_embedded_role_evidence.mjs',
  'test_keyword_cloud_display.mjs',
  'test_keyword_cloud_generic.mjs',
  'test_insight_profile_charts.mjs',
  'test_insight_wordcloud.mjs',
  'test_wordcloud_interactions.mjs',
  'test_collector_native_sink.mjs',
  'test_job_knowledge_store.mjs',
  'test_job_decision_assistant.mjs',
  'test_job_assistant_chat.mjs',
  'test_job_assistant_collection.mjs',
  'test_job_assistant_http.mjs',
  'test_job_assistant_sessions.mjs',
  'test_knowledge_native_analysis.mjs',
  'test_knowledge_console_api.mjs',
];
const failures=[];
for (const name of tests) {
  console.log(`\n[unit] ${name}`);
  const result = spawnSync(process.execPath, [path.join('work', name)], { cwd: root, stdio: 'inherit',timeout:90000 });
  if (result.error || result.status !== 0) failures.push(name);
}
console.log(`\n${tests.length-failures.length}/${tests.length} 个单元测试脚本通过。`);
if(failures.length){console.error('未通过：'+failures.join(', '));process.exitCode=1;}
