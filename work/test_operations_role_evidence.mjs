import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createKnowledgeStore } from './job_knowledge_store.mjs';
import { learnOperationsEvidence, matchOperationsEvidence } from './operations-role-evidence.mjs';

const cases = [
  ['Linux运维工程师', '岗位职责：负责Linux服务器巡检和故障处理。', 'include'],
  ['网络运维工程师', '岗位职责：负责网络设备维护和交换机故障排查。', 'include'],
  ['云平台工程师', '岗位职责：承担云平台监控与应急响应。', 'include'],
  ['SRE', '岗位职责：保障线上服务稳定性和可用性。', 'include'],
  ['数据库工程师', '岗位职责：负责数据库备份、容灾及恢复。', 'include'],
  ['DevOps', '岗位职责：维护Jenkins持续交付流水线。', 'include'],
  ['容器运维', '岗位职责：监控Kubernetes容器平台并处理故障。', 'include'],
  ['信息技术工程师', '负责应用系统巡检与运行维护。', 'include'],
  ['系统运维工程师', '任职要求：负责Linux服务器维护与故障处理。', 'include'],
  ['Operations engineer', 'You will maintain Linux servers and monitor production systems.', 'include'],
  ['运维工程师', '岗位职责：处理订单与客户投诉。', 'exclude'],
  ['运维工程师', '任职要求：熟悉Linux和Docker，有网络维护经验优先。', 'review'],
  ['运维工程师', '岗位职责：熟悉Linux服务器的维护流程。', 'review'],
  ['工程师', '岗位职责：开发Java业务接口。任职要求：了解Linux和Docker。', 'review'],
  ['光伏运维工程师', '岗位职责：负责光伏面板巡检及发电设备维护。', 'exclude'],
  ['风电运维工程师', '岗位职责：负责风机检修和机械设备保养。', 'exclude'],
  ['暖通运维工程师', '岗位职责：承担空调设备维修。', 'exclude'],
  ['污水运维工程师', '岗位职责：负责水处理设备巡检。', 'exclude'],
  ['运维客服', '岗位职责：负责客户咨询和电话回访。', 'exclude'],
  ['技术销售', '岗位职责：负责Linux服务器销售。', 'review'],
  ['软件开发工程师', '岗位职责：负责Linux服务器维护和开发Java接口。', 'review'],
  ['风电运维工程师', '岗位职责：负责Linux服务器维护。', 'review'],
  ['运维工程师', '公司介绍：负责Linux服务器维护。岗位职责：负责行政文书。', 'exclude'],
  ['运维工程师', '福利待遇：Linux服务器维护培训。', 'exclude'],
  ['运维工程师', '岗位职责：Linux、Docker、Kubernetes。', 'review'],
  ['运维工程师', '', 'exclude'],
  ['运维工程师', '岗位职责：负责容器业务开发。', 'review'],
  ['运维工程师', '岗位职责：负责平台维护。', 'exclude'],
  ['Linux嵌入式安全工程师', '岗位职责：负责Linux Kernel的维护和平台优化。', 'review'],
  ['工程师', '岗位职责：负责Linux内核维护及设备驱动开发。', 'review'],
  ['网络安全工程师', '岗位职责：负责网络应急响应和渗透测试。', 'review'],
  ['测试工程师', '岗位职责：负责Linux服务器维护和软件测试。', 'review'],
  ['智能运维工程师-2027校园招聘(J10266)', '岗位职责：负责Linux服务器维护和故障处理。', 'include'],
  ['IT招聘专员', '岗位职责：负责Linux服务器运维工程师的招聘。', 'review'],
];
const rows = cases.map(([title,jd], i) => ({ row_no:i+2, '岗位名称':title, '岗位描述':jd, '查询关键词':'运维工程师', '技能':'Linux Docker Kubernetes' }));
const model = learnOperationsEvidence(rows, {name:'运维/云平台'});
for (const [i, [title, , expected]] of cases.entries()) test(`${i+1}: ${title}: ${expected}`, () => {
  const result = matchOperationsEvidence(rows[i], model);
  assert.equal(result.decision, expected);
  assert.equal(result.matched, expected === 'include');
  assert.equal(result.keyword_evidence.model_version, 'operations-evidence-v1');
  assert.deepEqual(matchOperationsEvidence({...rows[i], '查询关键词':'销售顾问', '技能':'完全不相关'}, model), result, '查询和外部技能不得改变纳入');
});
test('rule metadata and family isolation', () => {
  assert.equal(model.algorithm, 'curated-context');
  assert.match(model.selection_policy, /不是TF-IDF/);
  assert.throws(() => learnOperationsEvidence(rows,{name:'数据分析'}), /不能用于其他/);
});
test('real analysis child reads isolated SQLite snapshot, without old keyword failure', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'operations-evidence-http-free-'));
  await createKnowledgeStore(dir).sync({tasks:[], refresh:false});
  const db = new DatabaseSync(path.join(dir,'knowledge/岗位知识库.sqlite'));
  const raw = rows.map((r,i) => ({platform:'测试夹具', job_id:String(i), job_name:r['岗位名称'], job_description:r['岗位描述'], salary:'10-20K', city:'广州', company_name:`测试公司${i}`, query_keyword:'运维工程师'}));
  db.prepare('INSERT INTO snapshots VALUES(?,?,?,?,?)').run('fixture',1,'operations-fixture',JSON.stringify(raw),new Date().toISOString());db.close();
  const config=path.join(dir,'config.json'),output=path.join(dir,'report.json');
  await fs.writeFile(config,JSON.stringify({inputFile:'kb://snapshot/fixture',role:'运维工程师',roleSource:'source_task',analysisMode:'full'}));
  await promisify(execFile)(process.execPath,['work/analyze_job_market_sample.mjs',config,output],{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,JOB_UI_DATA_DIR:dir},windowsHide:true,timeout:60000});
  const report=JSON.parse(await fs.readFile(output,'utf8'));
  assert.equal(report.role,'运维/云平台');assert.equal(report.selection_contract,'operations-evidence-v1');
  assert.equal(report.sample_rows,cases.filter(c=>c[2]==='include').length);
  assert.equal(report.selection_review.pending_rows,cases.filter(c=>c[2]==='review').length);
  assert.equal(report.selection_review.excluded_rows,cases.filter(c=>c[2]==='exclude').length);
  assert.equal(report.role_classifier,null);assert.equal(report.role_screening_status.mode,'contextual-rules');
  assert.equal(report.total_rows,cases.length);
  console.log(JSON.stringify({fixtureRows:cases.length,included:report.sample_rows,report:output,notRealCollection:true}));
});
