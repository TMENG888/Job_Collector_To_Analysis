// Validate source-grounded Codex cluster names; emit candidates ONLY in pilot dir.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {digest} from './prepare_unsupervised_jobs.mjs';
const out=path.resolve(process.argv[2]||'ui_data/insights/comparisons/unsupervised-codex-20261017');
const read=async name=>JSON.parse(await fs.readFile(path.join(out,name),'utf8'));
const clusters=await read('clusters.json'),labels=await read('codex-cluster-labels.json'),corpus=await read('corpus.json'),assignments=await read('assignments.json');
assert.equal(labels.clustering_sha256,digest(await fs.readFile(path.join(out,'clusters.json'))));
assert.equal(labels.labels.length,clusters.cards.length);
assert.equal(new Set(labels.labels.map(l=>l.cluster)).size,clusters.cards.length);
const byId=new Map(corpus.docs.map(d=>[d.key,d]));
for(const card of clusters.cards){
 const label=labels.labels.find(l=>l.cluster===card.cluster);assert.ok(label);
 assert.ok(['candidate','mixed','uncertain'].includes(label.status));assert.ok(label.proposed_name&&label.reason);
 assert.equal(label.sample_roles.length,card.samples.length);
 assert.ok(label.evidence.length>=2);
 for(const e of label.evidence){assert.ok(Number.isInteger(e.sample_index)&&card.samples[e.sample_index]);const doc=byId.get(card.samples[e.sample_index].key);assert.ok(e.quote.length>=6&&doc.body.includes(e.quote),'Source evidence mismatch: cluster '+card.cluster);}
}
const names=new Map(labels.labels.map(l=>[l.cluster,l]));
const candidates=assignments.map(a=>({...a,candidate_cluster_name:names.get(a.cluster)?.proposed_name||null,label_status:a.cluster<0?'noise_unlabelled':names.get(a.cluster).status==='candidate'?'candidate_not_individually_verified':'mixed_or_uncertain_do_not_propagate',source:'Codex cluster-sample naming, not per-job gold'}));
await fs.writeFile(path.join(out,'candidate-memberships.json'),JSON.stringify(candidates,null,2),{flag:'wx'});
await fs.writeFile(path.join(out,'naming-seal.json'),JSON.stringify({labels_sha256:digest(await fs.readFile(path.join(out,'codex-cluster-labels.json'))),sealed_at:new Date().toISOString(),production_published:false,individual_labels_confirmed:false},null,2),{flag:'wx'});
console.log(JSON.stringify({named_clusters:names.size,candidate_clusters:labels.labels.filter(l=>l.status==='candidate').length,mixed_clusters:labels.labels.filter(l=>l.status==='mixed').length,uncertain_clusters:labels.labels.filter(l=>l.status==='uncertain').length,individual_rows_confirmed:0}));
