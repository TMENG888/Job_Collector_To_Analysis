import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {createRoleClassifierMatcher,prepareClassifierInput} from './data-analysis-classifier.mjs';
import {roleClassifier,roleInsightModel,supervisedRoleFamilies,roleScreeningStatus} from './role-classifier-registry.mjs';
import {classifyKnowledgeRow} from './job_knowledge_store.mjs';
import {resolveInsightSourceRole} from './insight-source-role.mjs';
const root=path.resolve(import.meta.dirname,'..'),out=path.join(root,'ui_data/insights/comparisons/multirole-lr-20261016');
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const corpus=await read(path.join(out,'training-corpus.json')),predictions=await read(path.join(out,'predictions.json')),results=await read(path.join(out,'results.json'));
test('registered family heads reproduce every sealed sklearn score; no corpus fitting',()=>{
 let n=0,maximum=0;
 const byId=new Map(corpus.samples.map(d=>[d.id,d]));
 for(const p of predictions){if(!supervisedRoleFamilies().includes(p.family))continue;
  const row=byId.get(p.id);assert.equal(prepareClassifierInput(row).text,row.text,p.id);
  const r=roleClassifier(p.family).match(row);
  maximum=Math.max(maximum,Math.abs(r.classifier_evidence.score-p.score));
  assert.ok(Math.abs(r.classifier_evidence.score-p.score)<1e-10,p.family+':'+p.id);
  assert.equal(r.matched,p.accepted);n++;
 }
 assert.ok(n>2000);console.log(JSON.stringify({compared:n,max_score_error:maximum}));
});
test('release gate; pending families never borrow a model',()=>{
 for(const [family,r]of Object.entries(results.families))assert.equal(Boolean(roleClassifier(family)),r.released);
 assert.equal(roleClassifier('不存在的岗位'),null);
 for(const r of Object.values(results.families).filter(r=>r.released))assert.ok(r.test.precision>=.8&&r.test.recall>=.6&&r.test.tp>=3);
 assert.ok(roleScreeningStatus().pending.some(r=>r.family==='新媒体运营'));
 for(const family of supervisedRoleFamilies()){
  const m=roleInsightModel(family);assert.equal(m.family,family);assert.equal(m.keywords.length,0);assert.equal(m.minimum_hits,null);
 }
});
test('family admission matches inference, not title; external fields cannot change it',()=>{
 for(const d of corpus.samples.slice(0,160)){
  const row={job_name:d.title,job_description:d.body},classification=classifyKnowledgeRow(row);
  for(const family of supervisedRoleFamilies()){
   const m=roleClassifier(family),r=m.match(row);
   assert.equal(classification.role_families.includes(family),r.matched,d.id+family);
   assert.equal(m.match({...row,skills:'RAG 嵌入式 测试 自动化',query_keyword:family,salary:'1000000'}).classifier_evidence.score,r.classifier_evidence.score);
   assert.equal(m.match({job_name:d.title,job_description:'不足正文'}).decision,'review');
  }
 }
});
test('company and near-JD group split is immutable, no split overlap',async()=>{
 const split=await read(path.join(out,'split.json'));
 assert.equal(createHash('sha256').update(await fs.readFile(path.join(out,'training-corpus.json'))).digest('hex'),split.corpus_sha256);
 const groups=new Map(),companies=new Map();
 for(const [i,r]of split.rows.entries()){
  for(const [map,key]of [[groups,r.group],[companies,corpus.samples[i].company]]){if(map.has(key))assert.equal(map.get(key),r.split);else map.set(key,r.split);}
 }
});
test('removed manual role UI; source-task precedence and mismatch validation',async()=>{
 const html=await fs.readFile(path.join(root,'job_collector_ui/public/index.html'),'utf8'),app=await fs.readFile(path.join(root,'job_collector_ui/public/app.js'),'utf8');
 assert.ok(!html.includes('name="role"'));assert.ok(!app.includes('input[name="role"]'));
 assert.ok(html.includes('id="insightRoleSource"'));assert.ok(app.includes('insightSourceRole'));
 const tasks=[{id:'task-1',label:'测试工程师-北京-8000',primaryKeyword:'测试工程师'}];
 assert.deepEqual(resolveInsightSourceRole({inputFile:'kb://task/task-1'},tasks),{role:'测试工程师',taskId:'task-1',mode:'source_task'});
 assert.equal(resolveInsightSourceRole({inputFile:'kb://task/task-1',role:'销售'},tasks).role,'测试工程师');
 assert.throws(()=>resolveInsightSourceRole({inputFile:'kb://task/task-1',sourceTaskId:'other'},tasks),/不一致/);
 assert.throws(()=>resolveInsightSourceRole({inputFile:'kb://task/missing'},tasks),/不存在/);
 assert.equal(resolveInsightSourceRole({inputFile:'kb://all'},tasks).role,'自动识别');
 assert.equal(resolveInsightSourceRole({inputFile:'C:/data/新媒体.csv'},tasks,[{path:'C:/data/新媒体.csv',role:'新媒体运营'}]).role,'新媒体运营');
});
test('model integrity and global rollback cannot silently change default screening',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'multirole-integrity-')),file=path.join(dir,'broken.json');await fs.writeFile(file,'{}');
 assert.throws(()=>createRoleClassifierMatcher(file,{sha256:'wrong',version:'x',family:'测试工程',threshold:.6}),/校验失败/);
 const old=process.env.JOB_ROLE_SCREENING;
 try{process.env.JOB_ROLE_SCREENING='legacy';assert.deepEqual(supervisedRoleFamilies(),[]);process.env.JOB_ROLE_SCREENING='invalid';assert.throws(()=>supervisedRoleFamilies(),/仅支持/);}
 finally{if(old===undefined)delete process.env.JOB_ROLE_SCREENING;else process.env.JOB_ROLE_SCREENING=old;}
});
