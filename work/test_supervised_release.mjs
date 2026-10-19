// Source-only synthetic checks. No production DB, external requests or paid labels.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {roleClassifier,supervisedRoleFamilies} from './role-classifier-registry.mjs';
import {createInsightSupervised,classificationMetrics,classifierRoot} from './insight-supervised.mjs';

assert.deepEqual([...supervisedRoleFamilies()].sort(),['数据分析','嵌入式开发','测试工程','智能体/大模型应用'].sort());
for(const family of supervisedRoleFamilies()){
  const model=roleClassifier(family);
  assert.equal(model.match({job_name:'工程师',job_description:'过短职责'}).decision,'review');
  const row={job_name:'软件测试工程师',job_description:'岗位职责：'+('负责软件测试方案设计、执行自动化接口测试、跟踪缺陷和回归验证，输出测试报告并保障交付质量。'.repeat(4))};
  const first=model.match(row),second=model.match({...row,salary:'999K',query_keyword:family,skills:['title-bypass-forbidden']});
  assert.equal(first.decision,second.decision);
  assert.equal(first.classifier_evidence.score,second.classifier_evidence.score);
  assert.ok(Number.isFinite(first.classifier_evidence.score));
}
assert.equal(roleClassifier('没有训练的岗位'),null);
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'supervised-release-test-'));
assert.equal(classifierRoot(dir),process.env.JOB_INSIGHT_CLASSIFIER_DIR||path.join(dir,'insight_classification'));
const service=createInsightSupervised(dir,{fetcher:()=>{throw Error('network is forbidden in this test');}});
const unknown=await service.status('kb://task/synthetic','没有训练的岗位');
assert.equal(unknown.screening.mode,'supervised-only');assert.equal(unknown.screening.ready,false);assert.match(unknown.screening.error,/不会使用规则筛选/);
const known=await service.status('kb://task/synthetic','数据分析');
assert.equal(known.screening.source,'released-supervised');assert.equal(known.screening.ready,true);
assert.equal(await service.resolve('kb://task/synthetic','没有训练的岗位'),null);
assert.equal(unknown.totals.costEstimate,0);
const metric=classificationMetrics([{gold:'include',prediction:'include'},{gold:'exclude',prediction:'exclude'}]);
assert.equal(metric.n,2);assert.equal(metric.accuracy,1);assert.equal(metric.precision,1);assert.equal(metric.recall,1);assert.equal(metric.f1,1);
console.log('PASS: 4 hash-validated supervised heads; deterministic inference; review gate; no title/query bypass; unknown role fails closed; isolated status without network or fees');
