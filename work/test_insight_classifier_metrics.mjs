import test from 'node:test';
import assert from 'node:assert/strict';
import {renderClassifierMetrics} from '../job_collector_ui/public/insight-classifier.js';

const metrics={n:80,accuracy:.9,precision:.9,recall:.9,f1:.9,tp:36,fp:4,fn:4,tn:36};
const run={role:'数据分析',targeted:true,labeled:400,sampled:400,budget:.5,
  evaluation:{test:metrics,counts:{train:{n:420},validation:{n:120},test:{n:80}},excluded_rows:70,
    comparison:[{name:'旧候选',metrics},{name:'新候选',metrics}]}};

test('result retains the F1 summary without detailed evaluation panels, showing concise token usage',()=>{
  const html=renderClassifierMetrics(run);
  assert.match(html,/测试 F1 · 对 Qwen 标签/);
  assert.match(html,/90\.0%/);
  assert.doesNotMatch(html,/评测与用量|留出测试|验证集|classifier-metric-details|classifier-comparison/);
  assert.match(html,/Token/);assert.doesNotMatch(html,/费用／预算/);
  assert.equal(run.evaluation.test,metrics);
});

test('comparison labels are escaped and metrics render without adding analysis controls',()=>{
  const data=structuredClone(run);data.evaluation.comparison[0].name='<script>injection</script>';
  const html=renderClassifierMetrics(data);
  assert.doesNotMatch(html,/<script>/);
  assert.doesNotMatch(html,/injection/);
  assert.doesNotMatch(html,/<button/);
});

test('legacy evaluation is not presented as a new targeted test',()=>{
  const data=structuredClone(run);delete data.targeted;delete data.evaluation.comparison;
  const html=renderClassifierMetrics(data);
  assert.doesNotMatch(html,/新留出测试|本轮新增|classifier-comparison/);
});
