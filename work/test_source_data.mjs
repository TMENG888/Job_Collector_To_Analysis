import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {querySourceRows,querySourceDetail,createSourceDataService} from './job_source_data.mjs';
import {renderSourceTable,renderSourceDetail} from '../job_collector_ui/public/source-data.js';

const directory='E:/Codex/temp/20261119-source-data';await fs.mkdir(directory,{recursive:true});
async function fixture(){
  const base=await fs.mkdtemp(path.join(directory,'source-'));const tasks=[];
  for(const [id,label] of [['a','智能体采集'],['b','数据分析采集'],['old','历史归档']]){
    const outputDir=path.join(base,id);await fs.mkdir(outputDir);const db=new DatabaseSync(path.join(outputDir,'统一采集数据.sqlite'));
    db.exec('CREATE TABLE metadata(task_id TEXT PRIMARY KEY);CREATE TABLE jobs(platform TEXT,job_id TEXT,data TEXT,PRIMARY KEY(platform,job_id));');db.prepare('INSERT INTO metadata VALUES(?)').run(id);
    const put=row=>db.prepare('INSERT INTO jobs VALUES(?,?,?)').run(row.platform,row.job_id,JSON.stringify(row));
    put({platform:'智联招聘',job_id:'shared',job_name:'智能体工程师',company_name:'公司甲',salary:'200-300元/天',city:'深圳',query_keyword:'智能体开发',query_keywords:['智能体开发','Python'],collected_at:'2026-11-19T01:00:00Z',job_description:'任职要求：Python、LangGraph，保留原始职责文本。'.repeat(15)});
    if(id==='a')put({platform:'前程无忧',job_id:'other',job_name:'分析100%_指标',company_name:'公司乙',salary:'面议',city:'广州',job_description:'负责SQL分析，薪资面议。'});
    db.close();tasks.push({id,label,outputDir,archived:id==='old'});
  }
  await fs.writeFile(path.join(base,'tasks.json'),JSON.stringify(tasks));return {base,tasks};
}
test('source rows preserve native values and task provenance; shared jobs remain separate across tasks',async()=>{
  const {tasks}=await fixture();const before=await Promise.all(tasks.map(t=>fs.readFile(path.join(t.outputDir,'统一采集数据.sqlite')).then(b=>createHash('sha256').update(b).digest('hex'))));
  const result=querySourceRows(tasks);assert.equal(result.total,3);assert.equal(result.tasks.length,2);assert.equal(result.rows.filter(r=>r.jobId==='shared').length,2);
  const row=result.rows.find(r=>r.taskId==='a'&&r.jobId==='shared');assert.equal(row.fields.salary,'200-300元/天');assert.equal(row.fields.query_keyword,'智能体开发');assert.equal(row.fields.collected_at,'2026-11-19T01:00:00Z');assert.equal(row.descriptionPreview.length,180);
  const detail=querySourceDetail(tasks,{taskId:'a',platform:'智联招聘',jobId:'shared'});assert.ok(detail.raw.job_description.length>180);assert.deepEqual(detail.raw.query_keywords,['智能体开发','Python']);
  const after=await Promise.all(tasks.map(t=>fs.readFile(path.join(t.outputDir,'统一采集数据.sqlite')).then(b=>createHash('sha256').update(b).digest('hex'))));assert.deepEqual(after,before);
});
test('pagination covers all selected task rows exactly; filters are bound and wildcard input is literal',async()=>{
  const {tasks}=await fixture();const pages=[1,2,3].map(page=>querySourceRows(tasks,{page,pageSize:1}));assert.equal(new Set(pages.flatMap(p=>p.rows.map(r=>`${r.taskId}:${r.platform}:${r.jobId}`))).size,3);
  assert.equal(querySourceRows(tasks,{taskId:'a'}).total,2);assert.equal(querySourceRows(tasks,{platform:'智联招聘'}).total,2);assert.equal(querySourceRows(tasks,{q:'LangGraph'}).total,2);
  assert.equal(querySourceRows(tasks,{q:'100%_'}).total,1);assert.equal(querySourceRows(tasks,{q:"' OR 1=1 --"}).total,0);assert.equal(querySourceRows(tasks,{page:999,pageSize:1}).scope.page,3);
  assert.equal(querySourceRows(tasks,{q:'无此岗位'}).total,0);assert.throws(()=>querySourceRows(tasks,{pageSize:101}),/分页/);assert.throws(()=>querySourceRows(tasks,{taskId:'old'}),/归档/);
});
test('missing or foreign-owned stores are not replaced or read under another task',async()=>{
  const {base,tasks}=await fixture();const foreign={...tasks[0],id:'foreign'},missing={id:'missing',label:'尚未入库',outputDir:path.join(base,'missing')};
  const result=querySourceRows([foreign,missing]);assert.equal(result.total,0);assert.equal(result.warnings.length,2);assert.ok(result.tasks.every(t=>!t.available));
  assert.throws(()=>querySourceDetail([foreign],{taskId:'foreign',platform:'智联招聘',jobId:'shared'}),/归属/);assert.throws(()=>querySourceDetail(tasks,{taskId:'old',platform:'智联招聘',jobId:'shared'}),/参数/);
  assert.equal(await fs.stat(missing.outputDir).catch(()=>null),null);
});
test('worker-backed service reads only registered task stores and returns complete detail',async()=>{
  const {base}=await fixture(),service=createSourceDataService(base);const result=await service.list({taskId:'b',pageSize:'20'});assert.equal(result.total,1);
  const detail=await service.detail({taskId:'b',platform:'智联招聘',jobId:'shared'});assert.equal(detail.raw.salary,'200-300元/天');
});
test('raw content is escaped and original job links are restricted to HTTP(S)',()=>{
  const raw={job_name:'<script>alert(1)</script>',job_id:'1',job_description:'<img src=x onerror=alert(1)>',job_url:'javascript:alert(1)',salary:'面议'};
  const html=renderSourceDetail(raw);assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<img '));assert.ok(!html.includes('href="javascript:'));assert.ok(html.includes('&lt;img'));
  const table=renderSourceTable([{fields:raw,platform:'测试',jobId:'1',taskLabel:'<b>任务</b>',descriptionPreview:raw.job_description}]);assert.ok(!table.includes('<b>任务'));assert.ok(!table.includes('<script>'));
});
