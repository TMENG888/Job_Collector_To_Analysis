import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {matchDataAnalysis,prepareClassifierInput,createDataAnalysisMatcher,dataAnalysisScreeningEnabled,DATA_ANALYSIS_CLASSIFIER_VERSION} from './data-analysis-classifier.mjs';
import {roleFamilies} from './job_knowledge_schema.mjs';
import {selectManualRole} from './insight-role-selection.mjs';
import {classifyKnowledgeRow,createKnowledgeStore} from './job_knowledge_store.mjs';
import {createKnowledgeAssistantStore,answerJobDecision} from './job_decision_assistant.mjs';
const root=path.resolve(import.meta.dirname,'..'),old=path.join(root,'ui_data/insights/comparisons/codex-classifier-20261016'),fresh=path.join(root,'ui_data/insights/comparisons/bayes-classifier-20261016');
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const corpus=await read(path.join(old,'corpus.json')),newCorpus=await read(path.join(fresh,'fresh-corpus.json'));
const docs=[...corpus.docs,...newCorpus.docs];
const predictions=(await read(path.join(fresh,'predictions.json'))).filter(p=>p.model==='char_tfidf_lr');

test('600 frozen Python scores and input texts reproduced; sealed experiments untouched',async()=>{
 const inputs=new Map((await read(path.join(fresh,'model-inputs.json'))).map(d=>[d.id,d.text]));
 const expected=new Map(predictions.map(p=>[p.id,p]));let maximum=0;
 for(const d of docs){const result=matchDataAnalysis(d),p=expected.get(d.id);maximum=Math.max(maximum,Math.abs(result.classifier_evidence.score-p.score));
   assert.equal(prepareClassifierInput(d).text,inputs.get(d.id),d.id);assert.equal(result.matched,p.accepted,d.id);assert.ok(Math.abs(result.classifier_evidence.score-p.score)<1e-10,d.id);}
 const seal=await read(path.join(fresh,'evaluation-protocol.json'));
 for(const [file,hash] of Object.entries(seal.prior_hashes))assert.equal(createHash('sha256').update(await fs.readFile(path.join(old,file))).digest('hex'),hash);
 console.log(JSON.stringify({records:600,max_score_error:maximum}));
});

test('no query/skill/salary admission; input safety, aliases, rollback and corrupt artifact',async()=>{
 const positive=docs.find(d=>predictions.find(p=>p.id===d.id)?.accepted),row={'岗位名称':positive.title,'岗位描述':positive.body};
 assert.equal(matchDataAnalysis({...row,'查询关键词':'销售','技能':'完全无关','薪资':'1K'}).classifier_evidence.score,matchDataAnalysis(row).classifier_evidence.score);
 for(const body of ['', '岗位职责：负责数据分析。','x'.repeat(9001),'🧪'.repeat(100)]){
   const p=matchDataAnalysis({'岗位名称':'数据分析师','岗位描述':body});assert.equal(p.matched,false);assert.equal(p.decision,'review');}
 for(const name of ['数据分析','数据分析师','商业分析','经营分析','统计分析','BI分析师'])assert.equal(selectManualRole(roleFamilies,name).name,'数据分析');
 assert.notEqual(selectManualRole(roleFamilies,'数据挖掘').name,'数据分析');
 const oldSetting=process.env.JOB_DATA_ANALYSIS_SCREENING;
 try{process.env.JOB_DATA_ANALYSIS_SCREENING='legacy';assert.equal(dataAnalysisScreeningEnabled(),false);process.env.JOB_DATA_ANALYSIS_SCREENING='invalid';assert.throws(()=>dataAnalysisScreeningEnabled(),/仅支持/);}
 finally{if(oldSetting===undefined)delete process.env.JOB_DATA_ANALYSIS_SCREENING;else process.env.JOB_DATA_ANALYSIS_SCREENING=oldSetting;}
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'role-artifact-integrity-')),file=path.join(dir,'bad.json');await fs.writeFile(file,'{}');
 assert.throws(()=>createDataAnalysisMatcher(file),/校验失败/);assert.throws(()=>createDataAnalysisMatcher(path.join(dir,'missing.json')),/ENOENT/);
});

test('knowledge membership exactly follows classifier on all600; other families preserved',()=>{
 for(const [i,d] of docs.entries()){
   const r=classifyKnowledgeRow({job_name:d.title,job_description:d.body,salary:'15-25K'});
   assert.equal(r.role_families.includes('数据分析'),predictions[i].accepted,d.id);
   assert.equal(r.role_evidence.data_analysis.model_version,DATA_ANALYSIS_CLASSIFIER_VERSION);
 }
 const embedded=classifyKnowledgeRow({job_name:'嵌入式软件工程师',job_description:'岗位职责：开发STM32固件与实时驱动。任职要求：C++ Linux RTOS。'});
 // Embedded now has its own supervised model: an underspecified short JD
 // cannot retain the former title-only membership.
 assert.equal(embedded.role_families.includes('嵌入式开发'),false);
 assert.equal(embedded.role_evidence.supervised['嵌入式开发'].decision,'review');
 const engineer=classifyKnowledgeRow({job_name:'软件开发工程师',job_description:'岗位职责：负责Java后端接口开发，维护业务微服务，调试系统和部署。'.repeat(3)});
 assert.ok(engineer.role_families.includes('通用软件开发'));
});

test('isolated SQLite → real full insight CLI → assistant; old reports cannot revive rejected rows',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'data-analysis-production-')),taskDir=path.join(dir,'task');await fs.mkdir(taskDir);
 const task={id:'data-analysis-production-test',label:'数据分析',outputDir:taskDir};
 await fs.writeFile(path.join(taskDir,'任务归属.json'),JSON.stringify({task_id:task.id}));await fs.writeFile(path.join(dir,'tasks.json'),JSON.stringify([task]));
 const rows=newCorpus.docs.map(d=>({platform:d.platform,job_id:d.id,job_name:d.title,job_description:d.body,company_name:'隔离验收'+d.id,city:'广州',education:'本科',experience:'应届生',employment_type:'全职',salary:'10-20K'}));
 rows.push({platform:'国聘',job_id:'short',job_name:'数据分析师',job_description:'岗位职责：统计数据，制作图表，输出分析报告。',salary:'10-20K'});
 const db=new DatabaseSync(path.join(taskDir,'统一采集数据.sqlite'));
 db.exec('CREATE TABLE metadata(task_id TEXT PRIMARY KEY);CREATE TABLE jobs(platform TEXT,job_id TEXT,data TEXT,PRIMARY KEY(platform,job_id));');db.prepare('INSERT INTO metadata VALUES(?)').run(task.id);
 for(const r of rows)db.prepare('INSERT INTO jobs VALUES(?,?,?)').run(r.platform,r.job_id,JSON.stringify(r));db.close();
 const store=createKnowledgeStore(dir);await store.sync({refresh:false});const source=await store.read('kb://task/'+task.id),snapshot=await store.snapshot('kb://task/'+task.id);
 const expected=rows.filter(r=>matchDataAnalysis(r).matched).map(r=>r.job_id).sort();
 const config=path.join(dir,'config.json'),reportFile=path.join(dir,'report.json');await fs.writeFile(config,JSON.stringify({inputFile:snapshot.uri,role:'数据分析师',analysisMode:'full'}));
 await promisify(execFile)(process.execPath,[path.join(root,'work/analyze_job_market_sample.mjs'),config,reportFile],{
   cwd:root,env:{...process.env,JOB_UI_DATA_DIR:dir,JOB_DATA_ANALYSIS_SCREENING:'tfidf-lr'},timeout:60000,maxBuffer:1e6,windowsHide:true});
 const report=await read(reportFile);
 assert.equal(report.role,'数据分析');assert.equal(report.selection_contract,DATA_ANALYSIS_CLASSIFIER_VERSION);assert.equal(report.role_classifier.threshold,.55);
 assert.equal(report.total_rows,121);assert.equal(report.sample_rows,expected.length);assert.equal(report.selection_review.pending_rows,1);
 assert.deepEqual(report.cohort_observations.map(j=>j.job_id).sort(),expected);
 assert.ok(report.cohort_observations.every(j=>j.role_classifier.model_version===DATA_ANALYSIS_CLASSIFIER_VERSION));
 assert.ok(!report.sampling_method.includes('至少null'));assert.equal(report.keyword_selection.minimum_hits,null);
 assert.ok((report.topic_model.discovered_terms||[]).every(t=>!t.used_for_filter));
 // Forge a historical report and stored derived observation, never source data.
 const rejected=source.rows.find(r=>!matchDataAnalysis(r).matched&&r.job_id!=='short');assert.ok(rejected);
 const stale={role:'数据分析',generated_at:'2099-01-01T00:00:00Z',input_file:snapshot.uri,cohort_observations:[{knowledge_key:rejected.knowledge_key,knowledge_hash:rejected.knowledge_hash,skills:['SQL']}]};
 await store.publishAnalysis(stale);
 const knowledgeDb=new DatabaseSync(path.join(dir,'knowledge','岗位知识库.sqlite'));
 const rawBefore=knowledgeDb.prepare('SELECT job_key,content_hash,raw FROM jobs ORDER BY job_key').all();
 knowledgeDb.prepare('UPDATE jobs SET observation=? WHERE job_key=?').run(JSON.stringify({role_families:['数据分析'],decision:'include'}),rejected.knowledge_key);knowledgeDb.close();
 const data=await store.assistantData();assert.ok(data.cacheKey.includes(DATA_ANALYSIS_CLASSIFIER_VERSION));
 const rejectedView=data.jobs.find(j=>j.key===rejected.knowledge_key);assert.ok(!rejectedView.role_families.includes('数据分析'));
 assert.deepEqual(data.jobs.filter(j=>j.role_families.includes('数据分析')).map(j=>j.job_id).sort(),expected);
 const index=await createKnowledgeAssistantStore(dir).load(),answer=answerJobDecision(index,{question:'数据分析岗位',mode:'search',filters:{roles:['数据分析']},explicitFilters:true});
 assert.ok(answer.sources.every(s=>expected.includes(s.job_id)));assert.ok(answer.sources.length>0);
 const check=new DatabaseSync(path.join(dir,'knowledge','岗位知识库.sqlite'),{readOnly:true});
 assert.deepEqual(check.prepare('SELECT job_key,content_hash,raw FROM jobs ORDER BY job_key').all(),rawBefore);check.close();
 assert.equal((await fs.readdir(taskDir)).some(n=>n.endsWith('.csv')),false);
 console.log(JSON.stringify({integration_dir:dir,total:121,admitted:expected.length,pending:1,assistant_sources:answer.sources.length}));
});
