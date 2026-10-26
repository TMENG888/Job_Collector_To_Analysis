import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {fetchMohrssList,parseMohrssDataPage} from './public_api_adapters.mjs';
const here=path.dirname(fileURLToPath(import.meta.url)),evidence=path.resolve(here,'../../public-evidence');
const source=await fs.readFile(path.join(here,'collect_public_job_platforms.mjs'),'utf8');
const start=source.indexOf('async function collectMohrss('),end=source.indexOf('\nasync function collect51job(',start);
assert.ok(start>=0&&end>start,'Actual production function is located');
const functionSource=source.slice(start,end);
const first=parseMohrssDataPage(await fs.readFile(path.join(evidence,'mohr-list.html'),'utf8')).records;
const second=parseMohrssDataPage(await fs.readFile(path.join(evidence,'mohr-page2.html'),'utf8')).records;
const pages={1:[first[0],first[1]],2:[first[1],second[0]],3:[second[1]]};
const html=(page,rows=pages[page])=>`<input id="findjoblist" value="${JSON.stringify(rows).replaceAll('&','&amp;').replaceAll('"','&quot;')}"><input id="pageNo" value="${page}"><input id="totalpages" value="3"><input id="totalcount" value="4">`;
const root=await fs.mkdtemp(path.join(os.tmpdir(),'mohrss-checkpoint-api-'));
async function harness(name,{maxPages=3,maxRows=100,taskId='fixture-task',failPage=0,city={name:'全国'},customPages=pages}={}){
  const dir=path.join(root,name),checkpointDir=path.join(dir,'断点数据'),rawDir=path.join(dir,'原始数据');
  await fs.mkdir(checkpointDir,{recursive:true});await fs.mkdir(rawDir,{recursive:true});
  const config={task_id:taskId,platforms:{mohrss:{maxPages,maxRows}}},calls=[];
  const safeName=value=>String(value).replace(/[\\/:*?"<>|]/g,'_');
  const comboFile=(platform,keyword,city)=>path.join(rawDir,`${platform}_${safeName(keyword)}_${safeName(city)}.json`);
  const request=async url=>{const page=Number(new URL(url).searchParams.get('pageNo'));calls.push(page);if(page===failPage)return new Response('verification',{status:403});return new Response(html(page,customPages[page]));};
  const context=vm.createContext({fs,path,URL,config,checkpointDir,process:{env:{}},request,safeName,comboFile,fetchMohrssList,collectedAt:'fixture',htmlToText:value=>String(value||''),writeJsonAtomic:async(file,data)=>{const pending=file+'.tmp';await fs.writeFile(pending,JSON.stringify(data));await fs.rename(pending,file);},console:{log(){}}});
  vm.runInContext(functionSource,context);
  return {run:()=>context.collectMohrss('数据分析',city),calls,config,checkpoint:path.join(checkpointDir,`mohrss_数据分析_${city.name}.json`),raw:comboFile('中国公共招聘网','数据分析',city.name)};
}
try{
  let a=await harness('resume',{maxPages:1});let rows=await a.run();assert.equal(rows.length,2);assert.deepEqual(a.calls,[1]);
  let saved=JSON.parse(await fs.readFile(a.checkpoint));assert.equal(saved.lastPage,1);assert.equal(saved.completed,false);assert.equal(saved.limit_reason,'max_pages');assert.equal(rows[0].source_total,4);assert.equal(rows[0].acquisition_mode,'server_embedded_json');
  a=await harness('resume',{failPage:2});let failure;try{await a.run();}catch(error){failure=error;}
  assert.equal(failure.code,'verification_required');assert.equal(failure.partialRows.length,2);assert.deepEqual(a.calls,[2]);assert.equal(JSON.parse(await fs.readFile(a.checkpoint)).lastPage,1);
  a=await harness('resume');rows=await a.run();assert.equal(rows.length,4);assert.deepEqual(a.calls,[2,3]);assert.equal(new Set(rows.map(row=>row.job_id)).size,4);assert.equal(JSON.parse(await fs.readFile(a.checkpoint)).completed,true);
  a=await harness('resume');assert.equal((await a.run()).length,4);assert.deepEqual(a.calls,[],'Completed checkpoint does not repeat requests');

  a=await harness('drift',{maxPages:1});await a.run();
  a=await harness('drift',{customPages:{...pages,2:[]}});failure=null;try{await a.run();}catch(error){failure=error;}
  assert.equal(failure.code,'api_schema_changed');assert.equal(failure.partialRows.length,2);assert.equal(JSON.parse(await fs.readFile(a.checkpoint)).lastPage,1);assert.deepEqual(a.calls,[2]);

  a=await harness('rows',{maxRows:1});assert.equal((await a.run()).length,1);saved=JSON.parse(await fs.readFile(a.checkpoint));assert.equal(saved.lastPage,0,'A truncated page stays pending');assert.equal(saved.completed,false);assert.equal(saved.records.length,1);
  a=await harness('rows',{maxRows:4});assert.equal((await a.run()).length,4);assert.deepEqual(a.calls,[1,2,3],'Increasing cap recovers the pending tail');

  a=await harness('foreign',{taskId:'other-task'});await fs.writeFile(a.checkpoint,JSON.stringify({task_id:'fixture-task',records:[first[0]],lastPage:1,total:4,totalPages:3}));await assert.rejects(a.run(),error=>error.code==='TASK_OUTPUT_OWNERSHIP');assert.deepEqual(a.calls,[]);
  a=await harness('legacy');await fs.writeFile(a.raw,JSON.stringify({task_id:'fixture-task',records:[first[0]],total:1}));rows=await a.run();assert.equal(rows.length,4);assert.deepEqual(a.calls,[1,2,3]);assert.equal(rows[0].source_total,4,'Legacy exported row count is replaced by true upstream total');
  a=await harness('foreign-legacy');await fs.writeFile(a.raw,JSON.stringify({task_id:'other-task',records:[first[0]]}));await assert.rejects(a.run(),error=>error.code==='TASK_OUTPUT_OWNERSHIP');assert.deepEqual(a.calls,[]);

  const cityPages={1:[{...first[0],aab302:'上海',area_:'上海',acb202:'上海'},{...first[1],aab302:'北京',area_:'北京',acb202:'北京'}],2:pages[2],3:pages[3]};
  a=await harness('city',{maxRows:1,city:{name:'北京'},customPages:cityPages});rows=await a.run();assert.equal(rows.length,1);assert.equal(rows[0].job_id,String(first[1].acb200));assert.equal(rows[0].city,'北京');assert.deepEqual(a.calls,[1]);
  console.log('Mohrss checkpoint integration passed: page/row caps, resume, verification/schema stops, partial rows, dedup, true total, city filter and strict task ownership.');
}finally{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^mohrss-checkpoint-api-/);await fs.rm(root,{recursive:true,force:true});}
