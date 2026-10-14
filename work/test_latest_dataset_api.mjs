import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'latest-api-'));
const out=path.join(dir,'dataset');await fs.mkdir(out);
const task={id:'latest-fixture',label:'嵌入式软件开发',outputDir:out,status:'paused',platforms:['zhaopin'],cities:['深圳'],keywords:['嵌入式软件开发'],targetRows:15000,datasetScopeVersion:2};
await fs.writeFile(path.join(dir,'tasks.json'),JSON.stringify([task]));
await fs.writeFile(path.join(out,'任务归属.json'),JSON.stringify({task_id:task.id}));
const source=path.join(out,'zhaopin_标准化数据.csv');
const row=i=>`\n智联,${i},嵌入式软件工程师,示例公司,深圳,15-25K,C/C++ STM32 RTOS 嵌入式固件开发`;
await fs.writeFile(source,'platform,job_id,job_name,company_name,city,salary,job_description'+row(1)+row(2));
const base='http://127.0.0.1:8813';
const server=spawn(process.execPath,[path.join(root,'job_collector_ui/server.mjs'),'8813'],{cwd:root,env:{...process.env,JOB_UI_DATA_DIR:dir,JOB_UI_PORT:'8813'},windowsHide:true,stdio:['ignore','pipe','pipe']});
let logs='';server.stdout.on('data',chunk=>logs+=chunk);server.stderr.on('data',chunk=>logs+=chunk);
const post=url=>fetch(base+url,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
try{
  for(let i=0;i<50;i++){try{if((await fetch(base+'/api/state')).ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
  let response=await post(`/api/tasks/${task.id}/refresh-latest`);assert.equal(response.status,200,await response.clone().text());
  const selected=(await response.json()).dataset;assert.equal(selected.expectedRows,2);
  response=await post(`/api/tasks/${task.id}/export-latest`);assert.equal(response.status,202);
  for(let i=0;i<150;i++){
    const info=await (await fetch(base+`/api/tasks/${task.id}`)).json();
    assert.equal(info.task.status,'paused');
    if(info.task.latestExport?.status!=='running'){assert.ok(['completed','partial'].includes(info.task.latestExport.status),JSON.stringify(info));break;}
    await new Promise(resolve=>setTimeout(resolve,200));if(i===149)throw Error('export timeout');
  }
  await fs.appendFile(source,row(3));
  response=await fetch(base+'/api/insights/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({inputFile:selected.path,sourceTaskId:task.id,role:task.label,analysisMode:'full'})});
  assert.equal(response.status,202,await response.clone().text());
  const config=JSON.parse(await fs.readFile(path.join(dir,'insights/config.json'),'utf8'));
  assert.equal(config.expectedRows,3);assert.notEqual(config.inputFile,selected.path);assert.equal(config.displayInputFile,selected.path);
  const pinned=await fs.readFile(config.inputFile,'utf8');
  await fs.appendFile(source,row(4));await post(`/api/tasks/${task.id}/refresh-latest`);
  assert.equal(await fs.readFile(config.inputFile,'utf8'),pinned);
  const catalog=await (await fetch(base+'/api/insights/datasets')).json();assert.equal(catalog.datasets[0].expectedRows,4);assert.equal(catalog.datasets[0].resolution,'latest_snapshot');
  console.log('PASS: paused live-export API, state unchanged, latest catalog, fresh analysis row count, immutable analysis snapshot');
}catch(error){console.error(logs);throw error;}finally{server.kill('SIGTERM');}
