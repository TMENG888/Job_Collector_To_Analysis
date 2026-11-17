import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createInsightSupervised} from './insight-supervised.mjs';
import {semanticLabelFields,semanticPrompt,extractionPrompt,semanticEvidence,validateExtraction} from './insight-semantic-contract.mjs';
import {jointAnnotationPrompt,validateJointSemantics,summarizeJointSemantics} from './insight-joint-annotation.mjs';
import {validateAnnotationSchema,compileAnnotationSchema,normalizeSchemaSemantics,schemaHash,annotationSchemaDraftPrompt} from './insight-annotation-schema.mjs';

const role='应用开发';
function schema(legacy=false){
  const example={title:'应用开发工程师',duties:'负责应用开发',reason:'交付应用'};
  return validateAnnotationSchema({schema_version:'job-annotation-schema-v2',role,definition:'负责应用开发',classification:{include:['主要职责是应用开发'],exclude:['主要职责是销售'],review:['职责缺失'],positive_examples:[example,{...example}],negative_examples:[{...example,title:'销售'},{...example,title:'运营'}]},semantics:Object.fromEntries((legacy?['skills','tasks','domains','industries']:['skills','tasks']).map(field=>[field,{definition:field,include:['只使用原文'],exclude:['不推测'],normalization:[]}])),retrieval:{title_keywords:['应用开发','软件工程'],duty_keywords:['应用开发','接口研发'],adjacent_keywords:[],business_keywords:['知识库']}},role);
}
test('DeepSeek, joint labeling and incremental extraction request only skill and task tags',()=>{
  assert.deepEqual(semanticLabelFields,['skills','tasks']);
  for(const prompt of [semanticPrompt,extractionPrompt,jointAnnotationPrompt,annotationSchemaDraftPrompt]){
    assert.doesNotMatch(prompt,/"domains"|"industries"|四类标签/);
    assert.match(prompt,/"skills"/);assert.match(prompt,/"tasks"/);
  }
  const options=semanticEvidence({job_description:'熟悉Python，负责应用开发。',industry:'不再发送的公司行业'});
  assert.ok(options.length>0);assert.ok(options.every(option=>option.field==='job_description'));
});
test('new two-field schemas remain strict; frozen four-field schemas retain hashes but no longer send retired labeling rules',()=>{
  const current=schema();assert.deepEqual(Object.keys(current.semantics),['skills','tasks']);
  const missing=structuredClone(current);delete missing.semantics.tasks;assert.throws(()=>validateAnnotationSchema(missing,role));
  const legacy=schema(true),before=schemaHash(legacy);
  assert.equal(schemaHash(validateAnnotationSchema(legacy,role)),before);
  const prompt=compileAnnotationSchema(jointAnnotationPrompt,legacy);
  assert.doesNotMatch(prompt,/"domains"|"industries"/);assert.equal(schemaHash(legacy),before);
  assert.deepEqual(current.retrieval.business_keywords,['知识库']);
  const normalized=normalizeSchemaSemantics([{key:'K1',skills:[],tasks:[],domains:[{name:'历史业务'}],industries:[{name:'历史行业'}]}],legacy);
  assert.deepEqual(Object.keys(normalized[0]).sort(),['key','skills','tasks']);
});
test('joint two-tag responses keep independent classification proof and discard legacy tag columns',()=>{
  const batch=[{id:'1',sourceId:'source1',semantic_key:'K1',title:'应用开发工程师',model_body:'负责应用开发',options:[{id:'D1',quote:'负责应用开发'}],semantic_options:[{id:'S1',quote:'熟悉Python',field:'job_description'}]}];
  const payload={labels:[{id:'1',label:'include',evidence_id:'D1',skills:[{name:'Python',evidence_id:'S1'}],tasks:[],domains:[{name:'旧业务'}],industries:[{name:'旧行业'}]}]};
  const classified=[{id:'source1',label:'include',evidence:'负责应用开发'}];
  const rows=validateJointSemantics(payload,batch,classified);
  assert.equal(rows[0].fit,'include');assert.equal(rows[0].skills[0].name,'Python');assert.ok(!('domains'in rows[0]));assert.ok(!('industries'in rows[0]));
  assert.deepEqual(Object.keys(summarizeJointSemantics(rows).fields),['skills','tasks']);
  const invalid=validateJointSemantics(payload,batch,[{...classified[0],evidence:'不存在的证据'}]);
  assert.equal(invalid[0].fit,'uncertain');assert.equal(invalid[0].skills.length,0);
});
test('incremental extraction accepts two-tag responses without requiring or publishing removed labels',()=>{
  const batch=[{id:'1',key:'K1',title:'应用开发',classifierId:'model1',options:[{id:'E1',quote:'熟悉Python',field:'job_description'}]}];
  const output={jobs:[{id:'1',skills:[{name:'Python',evidence_id:'E1'}],tasks:[]}]};
  const result=validateExtraction(output,batch);assert.equal(result.rows[0].skills[0].name,'Python');assert.equal(result.dropped,0);
  assert.ok(!('domains'in result.rows[0]));assert.ok(!('industries'in result.rows[0]));
  assert.throws(()=>validateExtraction({jobs:[{id:'1',skills:[]}]},batch),/结构/);
  assert.throws(()=>validateExtraction({jobs:[{...output.jobs[0],fit:'include'}]},batch),/不得重新分类/);
});

test('joint service compiles a frozen legacy schema and saves only two-tag responses without paid retry',async()=>{
  const dir=await fs.mkdtemp('E:/Codex/temp/20261111-remove-clouds/joint-'),frozen=schema(true);
  const document={id:'legacy-schema',schema:frozen,sha256:schemaHash(frozen)},inputFile='kb://task/two-tag-test';
  const rows=Array.from({length:120},(_,i)=>({job_name:'应用开发工程师',company_name:'独立公司'+i,job_description:`岗位职责：负责应用开发、接口研发与质量保障，完成编号${i}项目的上线交付与维护，建立开发规范和日志排查流程。任职要求：熟悉Python，理解数据库技术与接口设计，具备独立解决复杂问题的能力。`,knowledge_key:'K'+i}));
  let calls=0;
  const service=createInsightSupervised(dir,{directory:path.join(dir,'classifier'),requestConcurrency:1,experiment:true,publishJoint:async()=>{},schemas:{resolve:async()=>document,status:async()=>({approved:document})},credentials:{load:async()=>'fake-local-key',status:async()=>({configured:true})},readRows:async()=>({rows,total:rows.length}),fetcher:async(_url,options)=>{
    calls++;const request=JSON.parse(options.body);assert.equal(request.model,'qwen3.8-flash');assert.doesNotMatch(request.messages[0].content,/"domains"|"industries"/);
    if(calls>1)return {ok:false,status:401};
    const jobs=JSON.parse(request.messages[1].content).jobs;
    const labels=jobs.map(job=>({id:job.id,label:'include',evidence_id:job.classification_evidence_options[0].id,skills:[],tasks:[]}));
    return {ok:true,json:async()=>({usage:{prompt_tokens:100,completion_tokens:30},choices:[{finish_reason:'stop',message:{content:JSON.stringify({labels})}}]})};
  }});
  const run=await service.start({inputFile,role,sampleCount:120,budget:1,jointAnnotations:true});
  let state;
  for(let attempt=0;attempt<200;attempt++){state=await service.status(inputFile,role);if(!state.busy)break;await new Promise(resolve=>setTimeout(resolve,20));}
  assert.equal(state.busy,false);assert.equal(state.run.status,'failed');assert.equal(calls,2);assert.equal(state.run.labeled,1);
  const partial=JSON.parse(await fs.readFile(path.join(dir,'classifier',run.id,'semantic-partial.json'),'utf8'));
  assert.equal(partial.rows.length,1);assert.ok(!('domains'in partial.rows[0]));assert.ok(!('industries'in partial.rows[0]));
  assert.deepEqual(state.run.semanticFields,['skills','tasks']);assert.equal(schemaHash(document.schema),document.sha256);
});
