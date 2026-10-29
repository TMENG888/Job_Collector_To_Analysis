import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {candidateRows,sampleClassifierRows,createInsightSupervised,createInsightSupervisedHandler} from './insight-supervised.mjs';
import {ANNOTATION_SCHEMA_VERSION,validateAnnotationSchema,compileAnnotationSchema,schemaHash,createAnnotationSchemas,annotationSchemaDraftPrompt} from './insight-annotation-schema.mjs';
import {assessTrainingLabels,sampleInsightCandidates} from './insight-sampling.mjs';
import {renderClassifierMetrics} from '../job_collector_ui/public/insight-classifier.js';
import {classifierAnalysisState} from '../job_collector_ui/public/insight-classifier-state.js';

const role='爬虫/数据采集',uri='kb://task/synthetic';
function schema(){
 const example={title:'网络爬虫工程师',duties:'负责开发网页抓取程序和解析入库链路',reason:'主要职责为采集程序开发'};
 const s={schema_version:ANNOTATION_SCHEMA_VERSION,role,definition:'开发维护网络数据采集系统',classification:{include:['主要交付网络采集程序'],exclude:['主要交付人工标注数据'],review:['职责不完整'],positive_examples:[example,{...example,title:'网页采集研发'}],negative_examples:[{...example,title:'数据标注员'},{...example,title:'Python后端研发'}]},semantics:{},retrieval:{title_keywords:['爬虫','网页采集'],duty_keywords:['网页抓取','解析入库','抓取调度'],adjacent_keywords:['数据标注','后端研发']}};
 for(const f of ['skills','tasks','domains','industries'])s.semantics[f]={definition:f,include:['只提取原文证据'],exclude:['不猜测'],normalization:[]};
 return s;
}
function raw(i,title='后端研发工程师',duty='负责研发业务接口和交易系统，维护软件质量与用户体验'){
 return {job_name:title,job_description:`岗位职责：${duty}，落实编号${i}项目的开发与交付，建立日志排查与质量监控流程，持续改进运行稳定性。\n任职要求：具备团队合作能力，熟悉Python与关系数据库技术，能够独立分析和解决技术问题。`,company_name:'company-'+i,knowledge_key:'row-'+i};
}
const frozen=()=>{const s=validateAnnotationSchema(schema(),role);return {id:randomUUID(),version:1,schema:s,sha256:schemaHash(s)};};
const credentials={status:async()=>({configured:true}),load:async()=>'isolated-mock-no-key'};
async function temporary(){const parent=path.resolve(os.tmpdir());if(!parent.startsWith('E:'+path.sep))throw Error('请将TEMP/TMP设置到本轮E盘测试目录');return fs.mkdtemp(path.join(parent,'insight-sampling-'));}

test('v2 requires bounded literal retrieval; v1 hash remains stable and hints stay out of teacher',()=>{
 const valid=validateAnnotationSchema(schema(),role);assert.equal(valid.retrieval.title_keywords.length,2);
 const noTerms=schema();delete noTerms.retrieval;assert.throws(()=>validateAnnotationSchema(noTerms,role),/结构无效/);
 for(const term of ['a','(a+)+$','x'.repeat(61)]){const s=schema();s.retrieval.duty_keywords[0]=term;assert.throws(()=>validateAnnotationSchema(s,role),/检索词|字段无效/);}
 const legacy=schema();legacy.schema_version='job-annotation-schema-v1';delete legacy.retrieval;
 assert.equal(schemaHash(validateAnnotationSchema(legacy,role)),schemaHash(legacy));
 const extra=schema();extra.retrieval.title_keywords.push('sampling-only-canary');
 assert.doesNotMatch(compileAnnotationSchema('base',extra),/sampling-only-canary|title_keywords/);
 assert.match(annotationSchemaDraftPrompt,/不是分类规则/);assert.match(annotationSchemaDraftPrompt,/adjacent_keywords/);
});

test('sparse target enrichment, random coverage, no compulsory background dilution, deterministic labels-free plan',()=>{
 const rows=Array.from({length:1000},(_,i)=>raw(i,i<60?'爬虫工程师':i<200?'数据标注员':'后端研发工程师',i<60?'负责网页抓取、解析入库与抓取调度':'维护业务系统，采集结果仅用于人工审核'));
 const other=Array.from({length:300},(_,i)=>raw(i+3000));
 const a=sampleClassifierRows(rows,other,400,{schema:schema(),role}),b=sampleClassifierRows(rows.toReversed(),other.toReversed(),400,{schema:schema(),role});
 assert.deepEqual(a,b);assert.equal(a.samples.length,400);assert.equal(new Set(a.samples.map(r=>r.id)).size,400);
 assert.equal(a.sampling.allocations.random_source,80);assert.equal(a.sampling.allocations.background_fallback||0,0);
 assert.equal(a.samples.filter(r=>r.title==='爬虫工程师').length,60);
 assert.ok(a.samples.some(r=>r.sampling.stratum==='random_source'&&!r.sampling.title.length&&!r.sampling.duties.length));
 assert.ok(a.samples.every(r=>!('label' in r)&&r.training_text_v2&&!r.text.includes('target_candidate')));
 assert.equal(a.sampling.classificationByKeywords,false);
});

test('matching is literal and short Latin words cannot match longer words',()=>{
 const s=schema();s.retrieval.title_keywords=['AI','Go'];s.retrieval.duty_keywords=['RPA','SQL'];s.retrieval.adjacent_keywords=[];
 const rows=candidateRows([raw(1,'Google工程师'),raw(2,'Chair维修员'),raw(3,'Go开发工程师'),raw(4,'AI应用工程师')]);
 const r=sampleInsightCandidates(rows,[],4,{schema:s});
 assert.equal(r.sampling.targetCandidates,2);
 const long=raw(5,'后端开发');long.job_description='岗位职责：'+('维护用户服务与业务接口，'.repeat(60))+'负责网页抓取与解析入库；'+('维护服务质量和文档。'.repeat(60));
 const full=sampleClassifierRows([long],[],1,{schema:schema(),role});assert.equal(full.sampling.targetCandidates,1,'retrieval reads original JD, not a 420-character duties truncation');
});

test('company diversity and source/background dedup preserve current-dataset scope',()=>{
 const rows=Array.from({length:900},(_,i)=>({...raw(i,'爬虫工程师'),company_name:i<700?'same-company':'unique-'+i}));
 const r=sampleClassifierRows(rows,[],400,{schema:schema(),role});
 assert.ok(new Set(r.samples.filter(s=>s.sampling.stratum==='target_candidate').map(s=>s.company)).size>=175);
 const single=raw(9000,'爬虫工程师'),sameBody={...single,job_name:'相同正文不同标题'};
 const fallback=sampleClassifierRows([single],[sameBody,raw(9001)],120,{schema:schema(),role});
 assert.equal(fallback.samples.length,2);assert.equal(fallback.sampling.allocations.background_fallback,1);
});

test('sample readiness does not fabricate positives or relax split gates',()=>{
 const rows=Array.from({length:400},(_,i)=>({label:i<6?'include':i<388?'exclude':'review'}));
 const r=assessTrainingLabels(rows,400);assert.equal(r.ready,false);assert.equal(r.positive,6);assert.equal(r.deficits.positive,18);assert.equal(r.recommendedPositive,100);
 assert.equal(assessTrainingLabels(Array.from({length:60},(_,i)=>({label:i<30?'include':'exclude'}))).ready,true);
 const html=renderClassifierMetrics({status:'needs_samples',message:'标签已保留',sampling:{targetCandidates:50,allocations:{target_candidate:40,random_source:80},warnings:['<script>']},trainingReadiness:r});
 assert.match(html,/候选不等于正例/);assert.match(html,/正例 18/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);
 const legacy=renderClassifierMetrics({status:'failed',positive:6,negative:382,message:'训练未完成：{"error":"按公司与近重复隔离后正负样本不足"}'});assert.match(legacy,/正例 6/);assert.doesNotMatch(legacy,/\{&quot;error/);
 assert.match(classifierAnalysisState({run:{status:'needs_samples'},screening:{role,ready:false}}).title,/待补样/);
 assert.equal(classifierAnalysisState({run:{status:'needs_samples'},screening:{role,ready:true}}).kind,'ready');
});

test('draft produces and freezes retrieval, old approval can still be resolved without charging',async()=>{
 const dir=await temporary();let calls=0;
 const model={status:async()=>({configured:true}),request:async prompt=>{calls++;assert.match(prompt,/job-annotation-schema-v2/);return schema();}};
 const service=createAnnotationSchemas(dir,{directory:path.join(dir,'schemas'),model});
 const draft=await service.draft({inputFile:uri,role,budget:.1,shareConfirmed:true});
 const approved=await service.approve({inputFile:uri,role,id:draft.id,confirmed:true});assert.equal(approved.schema.retrieval.title_keywords[0],'爬虫');assert.equal(calls,1);
 assert.equal((await service.resolve(uri,role)).sha256,approved.sha256);assert.equal(calls,1);
});

test('preview is read-only/no model call; HTTP validates scope and bounds',async()=>{
 const dir=await temporary(),doc=frozen();let paid=0;
 const s=createInsightSupervised(dir,{directory:path.join(dir,'classifier'),schemas:{resolve:async()=>doc},credentials,readRows:async()=>({rows:Array.from({length:180},(_,i)=>raw(i)),total:180}),fetcher:async()=>paid++});
 const preview=await s.previewSampling(uri,role,120);assert.equal(preview.readOnly,true);assert.equal(preview.paidRequests,0);assert.equal(preview.canStart,true);assert.equal(paid,0);
 assert.deepEqual(await fs.readdir(dir),[]);
 const handler=createInsightSupervisedHandler(s,async input=>({inputFile:input,role}));
 const server=http.createServer((req,res)=>void handler(req,res,new URL(req.url,'http://localhost').pathname));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const base='http://127.0.0.1:'+server.address().port+'/api/insights/classifier/sampling-preview?inputFile='+encodeURIComponent(uri);
  const response=await fetch(base+'&sampleCount=120');assert.equal(response.status,200);assert.equal((await response.json()).sampled,120);
  assert.equal((await fetch(base+'&sampleCount=20')).status,400);assert.equal((await fetch(base,{headers:{origin:'https://evil.example'}})).status,403);assert.equal(paid,0);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});

async function runMock(labelsForTitle,{groupShortage=false}={}){
 const dir=await temporary(),doc=frozen();doc.schema.retrieval.title_keywords.push('sampling-only-canary');doc.sha256=schemaHash(doc.schema);
 let requests=0,trained=0;const rows=Array.from({length:120},(_,i)=>raw(i,i<60?'爬虫工程师':'数据标注员'));
 const schemas={resolve:async()=>doc,status:async()=>({approved:doc})};
 const service=createInsightSupervised(dir,{directory:path.join(dir,'classifier'),schemas,credentials,experiment:true,readRows:async()=>({rows,total:120}),
  fetcher:async(_url,options)=>{requests++;const req=JSON.parse(options.body);assert.doesNotMatch(JSON.stringify(req.messages),/sampling-only-canary|sampling|target_candidate/);
   const jobs=JSON.parse(req.messages[1].content).jobs,labels=jobs.map(j=>({id:j.id,label:labelsForTitle(j.title),evidence_id:j.evidence_options[0].id}));
   return {ok:true,json:async()=>({usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120},choices:[{finish_reason:'stop',message:{content:JSON.stringify({labels})}}]})};},
  trainRunner:async output=>{trained++;const data=JSON.parse(await fs.readFile(path.join(output,'samples.json'),'utf8'));assert.equal(data.sampling.version,'schema-stratified-v1');assert.ok(data.samples.every(s=>s.training_text_v2));
   if(groupShortage){await fs.writeFile(path.join(output,'training-readiness.json'),JSON.stringify({ready:false,message:'公司与近重复隔离后正负样本不足；标签已保留',counts:{train:{positive:0,negative:60}}}));throw Error('训练退出2');}
   await fs.writeFile(path.join(output,'evaluation.json'),JSON.stringify({eligible:false,predictions:[]}));}});
 const run=await service.start({inputFile:uri,role,sampleCount:120,budget:2});
 let state;for(let i=0;i<800;i++){state=await service.status(uri,role);if(!state.busy)break;await new Promise(r=>setTimeout(r,30));}
 assert.equal(state.busy,false);assert.equal(requests,24);assert.equal(state.run.requestsCompleted,24);assert.equal(state.activeModel,null);
 const saved=JSON.parse(await fs.readFile(path.join(dir,'classifier',run.id,'samples.json'),'utf8'));assert.equal(saved.samples.length,120);
 return {state,trained};
}

test('all-negative pseudo-labels are kept without fitting a fake classifier',async()=>{
 const {state,trained}=await runMock(()=> 'exclude');assert.equal(trained,0);assert.equal(state.run.status,'needs_samples');assert.equal(state.run.positive,0);assert.match(state.run.message,/不会自动追加费用/);
});
test('balanced original-text labels reach training with sampling provenance',async()=>{
 const {state,trained}=await runMock(title=>title.includes('爬虫')?'include':'exclude');assert.equal(trained,1);assert.equal(state.run.status,'completed');assert.equal(state.run.positive,60);assert.equal(state.run.eligible,false);
});
test('company split shortage returns a readable recoverable state, not a stack trace',async()=>{
 const {state,trained}=await runMock(title=>title.includes('爬虫')?'include':'exclude',{groupShortage:true});assert.equal(trained,1);assert.equal(state.run.status,'needs_samples');assert.match(state.run.message,/公司与近重复/);assert.doesNotMatch(state.run.message,/error|\\n/);
});
