import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {discoveryInput,digest} from './prepare_unsupervised_jobs.mjs';
import {validateReview} from './finalize_discovery_audit.mjs';
const out=path.resolve('ui_data/insights/comparisons/unsupervised-codex-20261017');
const read=async name=>JSON.parse(await fs.readFile(path.join(out,name),'utf8'));
test('discovery uses only original title/duty text; no old labels or query features',()=>{
 const row={job_name:'工程师',job_description:'公司介绍：福利与招聘宣传。岗位职责：负责Linux服务器日常运行维护与监控，并对网络故障进行排查和恢复。承担业务系统备份和容量规划工作，编制监控告警和应急处理方案。参与服务上线和发布管理，保障服务器运行的稳定性与业务连续性。定期汇总服务故障记录，编制巡检报告并跟进整改，协同技术团队开展应急演练。任职要求：熟悉Python。福利待遇：销售推广。'};
 const a=discoveryInput(row);assert.ok(a);assert.equal(a.section_mode,'explicit_duties');
 assert.ok(!/销售推广|招聘宣传|熟悉Python/.test(a.text));
 assert.deepEqual(discoveryInput({...row,query_keyword:'销售',city:'深圳',salary:'1K',skills:'光伏',role_families:['其他'],company_name:'某公司'}),a);
 assert.equal(discoveryInput({job_name:'Linux运维工程师',job_description:'任职要求：熟悉Linux。'}),null);
});
test('prepared corpus is unique, company-capped and sealed',async()=>{
 const {docs,protocol}=await read('corpus.json');assert.equal(docs.length,5000);assert.ok(protocol.source_rows>5000);
 assert.equal(new Set(docs.map(d=>d.key)).size,docs.length);assert.equal(new Set(docs.map(d=>d.body_hash)).size,docs.length);
 const counts=new Map();for(const d of docs){counts.set(d.company_hash,(counts.get(d.company_hash)||0)+1);assert.ok(!Object.hasOwn(d,'label'));assert.equal(d.body_hash,digest(d.body.normalize('NFKC').replace(/\s/g,'').toLowerCase()));}
 assert.ok([...counts.values()].every(n=>n<=5));
});
test('cluster coverage; representative/audit disjointness; no missing members',async()=>{
 const {docs}=await read('corpus.json'),data=await read('clusters.json'),assignments=await read('assignments.json'),audit=await read('heldout-audit.json'),summary=await read('summary.json');
 assert.equal(summary.corpus_sha256,digest(await fs.readFile(path.join(out,'corpus.json'))));
 assert.equal(assignments.length,docs.length);assert.equal(new Set(assignments.map(a=>a.key)).size,docs.length);
 const members=new Map(assignments.map(a=>[a.key,a]));const reps=new Set();
 for(const c of data.cards){assert.equal(c.rows,assignments.filter(a=>a.cluster===c.cluster).length);assert.equal(c.samples.length,6);for(const s of c.samples){assert.equal(members.get(s.key).cluster,c.cluster);assert.ok(!reps.has(s.key));reps.add(s.key);}}
 for(const a of audit){assert.ok(!reps.has(a.key));assert.equal(members.get(a.key).cluster,a.cluster);}
 assert.equal(audit.length,data.cards.length*2);assert.ok(summary.max_input_tokens<=512);
});

test('sealed names and all quoted evidence remain source-grounded; no confirmed propagation',async()=>{
 const corpus=await read('corpus.json'),clusters=await read('clusters.json'),labels=await read('codex-cluster-labels.json'),seal=await read('naming-seal.json'),members=await read('candidate-memberships.json');
 assert.equal(labels.clustering_sha256,digest(await fs.readFile(path.join(out,'clusters.json'))));
 assert.equal(seal.labels_sha256,digest(await fs.readFile(path.join(out,'codex-cluster-labels.json'))));
 assert.equal(seal.individual_labels_confirmed,false);assert.equal(seal.production_published,false);
 const byKey=new Map(corpus.docs.map(d=>[d.key,d]));assert.equal(labels.labels.length,24);
 for(const l of labels.labels){const c=clusters.cards.find(c=>c.cluster===l.cluster);assert.ok(c);assert.equal(l.sample_roles.length,6);assert.ok(l.evidence.length>=2);for(const e of l.evidence)assert.ok(byKey.get(c.samples[e.sample_index].key).body.includes(e.quote));}
 assert.equal(members.length,5000);
 for(const m of members){const l=labels.labels.find(l=>l.cluster===m.cluster);assert.equal(m.label_status,l.status==='candidate'?'candidate_not_individually_verified':'mixed_or_uncertain_do_not_propagate');}
});

async function reviewInputs(){
 const [corpus,clusters,heldout,labels,decisions,seal]=await Promise.all(['corpus.json','clusters.json','heldout-audit.json','codex-cluster-labels.json','codex-audit-decisions.json','naming-seal.json'].map(read));
 return {corpus,clusters,heldout,labels,decisions,seal,labelsHash:digest(await fs.readFile(path.join(out,'codex-cluster-labels.json')))};
}
test('all 48 heldout decisions quote actual disjoint source records',async()=>{
 const inputs=await reviewInputs(),rows=validateReview(inputs),report=await read('codex-audit-review.json');
 assert.equal(rows.length,48);assert.deepEqual(rows,report.rows);
 assert.equal(report.production_changed,false);assert.equal(report.confirmed_job_labels,0);
 assert.equal(report.audit_decisions_sha256,digest(await fs.readFile(path.join(out,'codex-audit-decisions.json'))));
 assert.equal(Object.values(report.relation_to_center).reduce((a,b)=>a+b,0),48);
});
test('review rejects changed names, duplicate audit references, invented quotes and source mismatch',async()=>{
 const inputs=await reviewInputs();
 assert.throws(()=>validateReview({...inputs,labelsHash:'changed'}),/Sealed names changed/);
 const duplicate=structuredClone(inputs);duplicate.decisions.decisions[1].audit_index=0;assert.throws(()=>validateReview(duplicate));
 const quote=structuredClone(inputs);quote.decisions.decisions[0].quote='不存在于岗位原文的测试引用123456';assert.throws(()=>validateReview(quote),/Audit quote mismatch/);
 const source=structuredClone(inputs);source.heldout[0].content_hash='changed';assert.throws(()=>validateReview(source));
});
