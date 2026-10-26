// Read-only production inputs; write only to a new offline experiment directory.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {readJobDataset} from './job_dataset.mjs';
import {roleSections,matchRoleEvidence} from './role-evidence-v2.mjs';
const root=process.cwd();
const out=path.resolve('ui_data/insights/comparisons/agent-unsupervised-20261010');
const frozenReport=path.resolve('ui_data/insights/comparisons/evidence-v2/production-test.report.json');
const report=JSON.parse(await fs.readFile(frozenReport,'utf8'));
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const norm=s=>String(s).normalize('NFKC').toLowerCase().replace(/\s+/g,'');
const protectedFiles=[report.input_file,frozenReport,'work/role-evidence-v2.mjs','work/keyword-cloud-display.mjs','work/analyze_job_market_sample.mjs','ui_data/insights/岗位市场洞察.json'];
const hashes=Object.fromEntries(await Promise.all(protectedFiles.map(async f=>[path.resolve(f),hash(await fs.readFile(f))])));
const {rows}=await readJobDataset(report.input_file);
assert.equal(rows.length,16720);
// The public report keeps profile/threshold under selection_review, not keyword_selection.
const model={...report.keyword_selection,profile:report.selection_review.profile,threshold:report.selection_review.threshold};
const included=rows.filter(r=>matchRoleEvidence(r,model).matched);
assert.equal(included.length,report.relevant_sample_rows,'Must reproduce frozen v2 selection');
const seen=new Set(),docs=[];
for(const r of included){
 const sections=roleSections(r),body=sections.map(s=>s.quote).join('\n'),key=norm(body);
 if(!key||seen.has(key))continue;
 seen.add(key);docs.push({row_no:r.row_no,job_id:r['岗位ID'],platform:r['平台'],title:r['岗位名称'],company:r['公司名称'],sections,text:body,body_sha256:hash(key)});
}
// Company-group holdout: stable hashing prevents company-template leakage.
for(const d of docs){const group=norm(d.company)||d.body_sha256;d.split=parseInt(hash(group).slice(0,8),16)%5===0?'holdout':'train';}
await fs.mkdir(out,{recursive:true});
const manifest={created_at:new Date().toISOString(),root,input_file:report.input_file,source_task_id:'1791299055805-智能体开发',input_rows:rows.length,v2_included_rows:included.length,independent_docs:docs.length,train_docs:docs.filter(d=>d.split==='train').length,holdout_docs:docs.filter(d=>d.split==='holdout').length,selection:'Frozen production v2 report; no retraining or threshold changes',split:'company SHA256 modulo 5, 20% holdout; exact full body dedup',protected_hashes:hashes,baseline:report.topic_model.discovered_terms};
await fs.writeFile(path.join(out,'corpus.json'),JSON.stringify({manifest,docs},null,2));
console.log(JSON.stringify({...manifest,baseline:manifest.baseline.length,out},null,2));
