import test from 'node:test';
import assert from 'node:assert/strict';
import {renderClassifierMetrics} from '../job_collector_ui/public/insight-classifier.js';

const metrics={n:80,accuracy:.9,precision:.9,recall:.9,f1:.9,tp:36,fp:4,fn:4,tn:36};
const run={role:'数据分析',targeted:true,labeled:400,sampled:400,budget:.5,
  evaluation:{test:metrics,counts:{train:{n:420},validation:{n:120},test:{n:80}},excluded_rows:70,
    comparison:[{name:'旧候选',metrics},{name:'新候选',metrics}]}};

test('targeted evaluation identifies fresh holdout, reused labels and excluded old test',()=>{
  const html=renderClassifierMetrics(run);
  assert.match(html,/新留出测试/);
  assert.match(html,/本轮新增 400 条/);
  assert.match(html,/旧测试 70 条不参与训练或调参/);
  assert.match(html,/同一批新测试样本对照/);
  assert.match(html,/非人工准确率/);
});

test('comparison labels are escaped and metrics render without adding analysis controls',()=>{
  const data=structuredClone(run);data.evaluation.comparison[0].name='<script>injection</script>';
  const html=renderClassifierMetrics(data);
  assert.doesNotMatch(html,/<script>/);
  assert.match(html,/&lt;script&gt;/);
  assert.doesNotMatch(html,/<button/);
});

test('legacy evaluation is not presented as a new targeted test',()=>{
  const data=structuredClone(run);delete data.targeted;delete data.evaluation.comparison;
  const html=renderClassifierMetrics(data);
  assert.doesNotMatch(html,/新留出测试|本轮新增|classifier-comparison/);
});
