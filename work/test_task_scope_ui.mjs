import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';
import {writeJsonAtomic} from './collector_storage.mjs';
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'scope-ui-'));
const data=path.join(temp,'ui'),directory=path.join(temp,'shared');
await fs.mkdir(data);await fs.mkdir(directory);
const profilePath=path.join(data,'profile.json');await writeJsonAtomic(profilePath,{label:'智能体开发',keywords:['智能体开发']});
const old=path.join(directory,'数据质量报告.json');await writeJsonAtomic(old,{dataset_label:'ai漫剧师',output_rows:3150});
const oldBytes=await fs.readFile(old,'utf8');
await writeJsonAtomic(path.join(data,'tasks.json'),[{id:'scope-ui-task',label:'智能体开发',primaryKeyword:'智能体开发',keywords:['智能体开发'],targetRows:20000,outputDir:directory,profilePath,status:'paused',platforms:['job51'],cities:['北京']}]);
const port=18988,base=`http://127.0.0.1:${port}`;
const server=spawn(process.execPath,['job_collector_ui/server.mjs',String(port)],{windowsHide:true,env:{...process.env,JOB_UI_DATA_DIR:data,JOB_UI_PORT:String(port),JOB_UI_OPEN_BROWSER:'0'}});
let logs='';server.stdout.on('data',b=>logs+=b);server.stderr.on('data',b=>logs+=b);
let browser;
try{
 for(let i=0;i<80;i++){try{if((await fetch(base+'/api/tasks')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 const state=await (await fetch(base+'/api/tasks')).json(),task=state.tasks[0];
 assert.notEqual(task.outputDir,directory);assert.equal(task.legacyOutputDir,directory);assert.equal(task.metrics.hasFinalResult,false);assert.equal(task.metrics.finalRows,0);
 browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
 const page=await browser.newPage();await page.goto(base+'/tasks/scope-ui-task');
 await page.getByText('本任务尚未生成最终结果',{exact:true}).waitFor();
 assert.ok((await page.locator('#detail').innerText()).includes('候选总量'));
 assert.ok(!(await page.locator('#detail').innerText()).includes('3,150'));
 const create=await fetch(base+'/api/tasks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({label:'同名岗位',primaryKeyword:'同名岗位',platforms:'job51',outputDir:directory,cities:'北京'})});
 assert.equal(create.status,201);const created=await create.json();
 const newTask=created.task||created;
 assert.notEqual(newTask.outputDir,directory);assert.notEqual(newTask.outputDir,task.outputDir);
 const profile=JSON.parse(await fs.readFile(newTask.profilePath||path.join(data,'tasks',newTask.id,'岗位配置.json'),'utf8'));
 assert.equal(profile.task_id,newTask.id);assert.equal(profile.collection_relevance_filter,false);
 assert.equal(await fs.readFile(old,'utf8'),oldBytes);
 console.log(JSON.stringify({ok:true,checks:['legacy service migration','API rejects stale final count','UI shows missing result and separate candidate count','new-task independent directory and task ID','history untouched'],temp}));
}catch(error){console.error(logs);throw error;}
finally{if(browser)await browser.close();server.kill();}
