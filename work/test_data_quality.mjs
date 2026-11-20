import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {buildJobQuality} from './job_data_quality.mjs';
import {createQualityService} from './job_data_quality_service.mjs';
import {initializeIngestionAudit,beginIngestionAudit} from './knowledge_ingestion_audit.mjs';
import {renderQualityReport} from '../job_collector_ui/public/data-quality.js';

const temp='E:/Codex/temp/20261119-data-quality';await fs.mkdir(temp,{recursive:true});
const body='岗位职责：负责Python服务开发、接口设计和Docker容器部署，维护数据采集任务和数据库。';
async function fixture(){
  const folder=await fs.mkdtemp(path.join(temp,'quality-')),database=path.join(folder,'knowledge.sqlite');
  const db=new DatabaseSync(database);
  db.exec(`CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);INSERT INTO metadata VALUES('revision','1');
    CREATE TABLE jobs(job_key TEXT PRIMARY KEY,platform TEXT,job_id TEXT,content_hash TEXT,raw TEXT,observation TEXT,updated_at TEXT);
    CREATE TABLE tasks(task_id TEXT PRIMARY KEY,label TEXT,archived INTEGER);INSERT INTO tasks VALUES('task-a','数据开发',0),('task-b','其他任务',0),('archived','已归档',1);
    CREATE TABLE memberships(task_id TEXT,job_key TEXT,source TEXT,PRIMARY KEY(task_id,job_key));
    CREATE TABLE labels(label_id TEXT,job_key TEXT,content_hash TEXT,state TEXT,data TEXT);`);
  function add(id,platform,raw,observation={decision:'review',skills:[]},task='task-a'){
    db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?)').run(id,platform,id,'hash-'+id,JSON.stringify({job_name:'Python工程师',company_name:'测试公司',city:'深圳·南山区',job_description:body,education:'本科',experience:'1-3年',...raw}),JSON.stringify(observation),'2026-11-18T00:00:00Z');
    db.prepare('INSERT INTO memberships VALUES(?,?,?)').run(task,id,'fixture');
  }
  add('day','甲平台',{salary:'150-200元/天',publish_time:'2026-11-16',job_url:'javascript:alert(1)'},{decision:'include',skills:['Python'],role_evidence:{supervised:{后端开发:{version:'model-v1'}}}});
  add('wan','甲平台',{salary:'1–1.5万',company_name:'另一公司',experience:'经验不限'});
  add('empty','乙平台',{salary:'面议',job_description:'',education:'',experience:'',city:'未知星球',company_name:''});
  add('error','乙平台',{salary:'20K',job_description:'请先登录后查看岗位详情',education:'奇怪学历',experience:'资深',publish_time:'3天前'});
  add('future','乙平台',{salary:'500K/月',publish_time:'2027-01-01',job_description:body+'不同正文'});
  add('unparsed','乙平台',{salary:'5-2K',job_description:'描述过短'});
  add('duplicate','乙平台',{salary:'10K',job_url:'https://example.com/job/duplicate'});
  add('hidden','甲平台',{salary:'50K'},undefined,'archived');
  db.prepare('INSERT INTO memberships VALUES(?,?,?)').run('task-b','day','fixture');
  const label={skills:['Python'],evidence_json:[{label_type:'skill',label:'Python',quote:'Python服务开发'}]};
  db.prepare('INSERT INTO labels VALUES(?,?,?,?,?)').run('valid','day','hash-day','approved',JSON.stringify(label));
  db.prepare('INSERT INTO labels VALUES(?,?,?,?,?)').run('stale','wan','old-hash','approved',JSON.stringify(label));
  db.close();return {database,folder};
}

test('quality counts use unique active jobs and distinguish missing, unparsed and unrestricted fields',async()=>{
  const {database}=await fixture(),r=buildJobQuality(database);
  assert.equal(r.total,7);assert.equal(r.usable.body,4);assert.equal(r.usable.approvedSkills,1);
  assert.equal(r.salary.provided,7);assert.equal(r.salary.negotiable,1);assert.equal(r.salary.numericProvided,6);assert.equal(r.salary.failed,1);assert.equal(r.salary.parsed,5);assert.equal(r.salary.dailyConverted,1);assert.equal(r.salary.inferredMonthly,1);assert.equal(r.salary.usable,4);
  assert.equal(r.issues.find(i=>i.type==='same_content').count,2);
  assert.equal(r.issues.find(i=>i.type==='body_error').count,1);
  assert.equal(r.issues.find(i=>i.type==='date_unparsed').count,1);
  assert.equal(r.issues.find(i=>i.type==='date_future').count,1);
  assert.equal(r.fields.find(f=>f.key==='experience').valid,5);
  assert.equal(r.ingestion.available,false);assert.deepEqual(r.ingestion.batches,[]);
  assert.ok(r.normalizations.some(e=>e.kind==='日薪折算'&&e.result.includes('3806.25')));
  assert.equal(r.samples.find(i=>i.jobId==='day').url,'');
});

test('task and platform scopes do not double count shared membership or include archived jobs',async()=>{
  const {database}=await fixture();assert.equal(buildJobQuality(database,{taskId:'task-b'}).total,1);
  const r=buildJobQuality(database,{platform:'甲平台'});assert.equal(r.total,2);assert.equal(r.platformQuality.length,1);
  assert.throws(()=>buildJobQuality(database,{taskId:'absent'}),/不存在/);
  assert.throws(()=>buildJobQuality(database,{platform:'不存在'}),/没有/);
  assert.equal(buildJobQuality(database,{taskId:'task-a'}).total,7);
});

test('problem counts cover all jobs while sample detail is explicitly bounded',async()=>{
  const {database}=await fixture(),db=new DatabaseSync(database);
  for(let i=0;i<35;i++){
    const id='missing-'+i;db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?)').run(id,'甲平台',id,'h',JSON.stringify({job_name:'岗位',job_description:'',salary:'面议',city:'北京',education:'不限',experience:'不限'}),'{}','2026-11-18');
    db.prepare('INSERT INTO memberships VALUES(?,?,?)').run('task-a',id,'fixture');
  }db.close();
  const r=buildJobQuality(database),issue=r.issues.find(i=>i.type==='body_missing');assert.equal(issue.count,36);assert.equal(issue.sampled,21);
  assert.equal(r.problemJobs,new Set(r.samples.map(s=>s.key)).size+15);
});

test('ingestion audit conserves records and does not count one repeated new job as both new and updated',async()=>{
  const {database}=await fixture(),db=new DatabaseSync(database);initializeIngestionAudit(db);
  db.exec('BEGIN');const audit=beginIngestionAudit(db,{id:'task-a'},5);
  audit.observe('new','甲平台',null,'a');audit.observe('new','甲平台','a','b');audit.observe('update','甲平台','before','after');audit.observe('same','乙平台','same','same');audit.reject({platform:'乙平台',job_name:'缺岗位ID'});audit.finish();db.exec('COMMIT');
  const stats=JSON.parse(db.prepare('SELECT stats FROM ingestion_batches').get().stats);
  assert.deepEqual(Object.fromEntries(['input','invalid','duplicates','unique','inserted','updated','unchanged'].map(k=>[k,stats[k]])),{input:5,invalid:1,duplicates:1,unique:3,inserted:1,updated:1,unchanged:1});
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ingestion_rejections').get().n,1);db.close();
  const r=buildJobQuality(database);assert.equal(r.ingestion.totals.input,5);assert.equal(r.ingestion.quarantineSamples.length,1);
  const filtered=buildJobQuality(database,{platform:'甲平台'});assert.equal(filtered.ingestion.totals.input,3);assert.equal(filtered.ingestion.totals.duplicates,1);
});

test('invalid ingestion audit rolls back without publishing a partial batch',async()=>{
  const {database}=await fixture(),db=new DatabaseSync(database);initializeIngestionAudit(db);db.exec('BEGIN');
  const audit=beginIngestionAudit(db,{id:'task-a'},2);audit.observe('a','甲平台',null,'x');assert.throws(()=>audit.finish(),/不守恒/);db.exec('ROLLBACK');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ingestion_batches').get().n,0);db.close();
});

test('reports persist, reuse unchanged versions, isolate scopes and preserve historical snapshots',async()=>{
  const {database,folder}=await fixture(),directory=path.join(folder,'reports');
  let service=createQualityService({database,directory});const first=await service.report();assert.equal(first.reused,false);
  const cached=await service.report();assert.equal(cached.reused,true);assert.equal(cached.report.id,first.report.id);
  service=createQualityService({database,directory});assert.equal((await service.report()).report.id,first.report.id);
  assert.notEqual((await service.report({platform:'甲平台'})).report.id,first.report.id);
  const db=new DatabaseSync(database);db.prepare("UPDATE metadata SET value='2' WHERE key='revision'").run();db.close();
  const next=await service.report();assert.notEqual(next.report.id,first.report.id);assert.equal(next.report.revision,2);
  assert.equal((await service.report({reportId:first.report.id})).report.revision,1);
  await assert.rejects(()=>service.report({reportId:'../../other'}),/标识无效/);
});

test('manual issue status persists separately and never changes the original report counts',async()=>{
  const {database,folder}=await fixture(),service=createQualityService({database,directory:path.join(folder,'reports')});
  const first=await service.report(),issue=first.report.samples[0];
  await service.mark({reportId:first.report.id,issueId:issue.id,state:'retained'});
  const saved=await service.report({reportId:first.report.id});assert.equal(saved.states[issue.id].state,'retained');assert.deepEqual(saved.report.issues,first.report.issues);
  await assert.rejects(()=>service.mark({reportId:first.report.id,issueId:'absent',state:'resolved'}),/没有/);
  await assert.rejects(()=>service.mark({reportId:first.report.id,issueId:issue.id,state:'unknown'}),/无效/);
});

test('UI rendering escapes source values, shows denominators and never replaces missing audit counts with zero',async()=>{
  const {database}=await fixture(),r=buildJobQuality(database);r.scope.label='<script>bad()</script>';
  const html=renderQualityReport(r);assert.ok(!html.includes('<script>'));assert.match(html,/&lt;script&gt;/);assert.match(html,/历史入库批次未留痕/);assert.match(html,/非面议薪资文本/);assert.match(html,/每平台、每类最多20条样例/);
});
