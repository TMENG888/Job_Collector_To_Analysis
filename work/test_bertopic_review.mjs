import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {digest} from './prepare_unsupervised_jobs.mjs';
import {validateReview} from './finalize_discovery_audit.mjs';
const out=path.resolve('ui_data/insights/comparisons/bertopic-codex-20261017-zh-v2');
const read=async n=>JSON.parse(await fs.readFile(path.join(out,n),'utf8'));
async function inputs(){const [corpus,clusters,heldout,labels,decisions,seal]=await Promise.all(['corpus.json','clusters.json','heldout-audit.json','codex-cluster-labels.json','codex-audit-decisions.json','naming-seal.json'].map(read));return {corpus,clusters,heldout,labels,decisions,seal,labelsHash:digest(await fs.readFile(path.join(out,'codex-cluster-labels.json')))};}
test('all 20 names use real source evidence, sealed names unchanged',async()=>{
 const {corpus,clusters,labels,seal,labelsHash}=await inputs();assert.equal(seal.labels_sha256,labelsHash);
 assert.equal(labels.clustering_sha256,digest(await fs.readFile(path.join(out,'clusters.json'))));
 const source=new Map(corpus.docs.map(d=>[d.key,d]));assert.equal(labels.labels.length,20);
 for(const c of clusters.cards){const l=labels.labels.find(l=>l.cluster===c.cluster);assert.ok(l);assert.equal(l.sample_roles.length,6);assert.ok(l.evidence.length>=2);assert.ok(new Set(l.evidence.map(e=>e.sample_index)).size>=2);for(const e of l.evidence)assert.ok(source.get(c.samples[e.sample_index].key).body.includes(e.quote));}
});
test('40 heldout decisions validated; no invented metrics or confirmed labels',async()=>{
 const i=await inputs(),report=await read('codex-audit-review.json');assert.deepEqual(validateReview(i),report.rows);
 assert.equal(report.reviewed,40);assert.equal(report.confirmed_job_labels,0);assert.equal(report.production_changed,false);
 assert.equal(report.precision,null);assert.equal(report.recall,null);assert.equal(report.F1,null);
 assert.equal(report.decision_sha256,digest(await fs.readFile(path.join(out,'codex-audit-decisions.json'))));
 assert.equal(report.noise_decision_sha256,digest(await fs.readFile(path.join(out,'codex-noise-decisions.json'))));
 assert.equal(report.per_cluster.length,20);for(const c of report.per_cluster){assert.equal(c.precision,null);assert.equal(c.recall,null);assert.equal(Object.values(c.audit).reduce((a,b)=>a+b,0),2);}
});
test('all 5000 candidates retain mixed and noise states; zero confirmed membership',async()=>{
 const rows=await read('candidate-memberships.json'),{labels}=await inputs();assert.equal(rows.length,5000);
 assert.equal(new Set(rows.map(r=>r.key)).size,5000);assert.equal(rows.filter(r=>r.cluster<0).length,822);
 for(const r of rows){const l=labels.labels.find(l=>l.cluster===r.cluster);assert.equal(r.label_status,r.cluster<0?'noise_unlabelled':l.status==='candidate'?'candidate_not_individually_verified':'mixed_or_uncertain_do_not_propagate');if(r.cluster<0)assert.equal(r.candidate_cluster_name,null);}
});
test('10 noise reviews have source-grounded evidence and still remain noise',async()=>{
 const {corpus}=await inputs(),source=new Map(corpus.docs.map(d=>[d.key,d])),assign=new Map((await read('assignments.json')).map(r=>[r.key,r])),report=await read('codex-audit-review.json');assert.equal(report.noise_review.length,10);
 for(const r of report.noise_review){assert.equal(assign.get(r.key).cluster,-1);assert.equal(r.content_hash,source.get(r.key).content_hash);assert.ok(source.get(r.key).body.includes(r.quote));assert.equal(r.individually_confirmed,false);}
});
test('audit validator rejects postseal edits, duplicate rows and fabricated evidence',async()=>{
 const i=await inputs();assert.throws(()=>validateReview({...i,labelsHash:'changed'}),/Sealed names changed/);
 const duplicate=structuredClone(i);duplicate.decisions.decisions[1].audit_index=0;assert.throws(()=>validateReview(duplicate));
 const fabricated=structuredClone(i);fabricated.decisions.decisions[0].quote='不在原文中的证据999999';assert.throws(()=>validateReview(fabricated),/Audit quote mismatch/);
});
