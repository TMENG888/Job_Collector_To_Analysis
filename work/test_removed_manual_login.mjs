import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import vm from 'node:vm';
import {spawn} from 'node:child_process';

const root=path.resolve(import.meta.dirname,'..');
const app=await fs.readFile(path.join(root,'job_collector_ui/public/app.js'),'utf8');
assert.doesNotMatch(app,/login-job51|login-jobonline|打开前程无忧登录页|打开就业在线登录页/);
const loginRenderer=app.slice(app.indexOf('function platformLoginButton('),app.indexOf('async function loadPlatforms('));
const sandbox=vm.createContext({escapeHtml:value=>String(value)});
vm.runInContext(loginRenderer,sandbox);
for(const key of ['job51','jobonline']){
  assert.equal(sandbox.platformLoginButton({key}), '','older server metadata must not restore removed buttons');
  assert.equal(sandbox.platformLoginButton({key,manualLoginAvailable:false,browserOpen:true}), '');
}
assert.match(sandbox.platformLoginButton({key:'zhaopin'}),/data-platform-login="zhaopin"/);
assert.match(sandbox.platformLoginButton({key:'deepseek',browserOpen:true}),/显示共享浏览器/);
assert.match(sandbox.platformLoginButton({key:'zhaopin',status:'opening'}),/disabled/);

const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'removed-manual-login-'));
const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const server=spawn(process.execPath,[path.join(root,'job_collector_ui/server.mjs'),String(port)],{
  cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],
  env:{...process.env,JOB_UI_DATA_DIR:dataDir,JOB_UI_PORT:String(port),JOB_UI_OPEN_BROWSER:'0',JOB_UI_START_WORKER:'0',JOB_TASK_BACKUP_ROOT:path.join(dataDir,'backups'),JOB_TASK_OUTPUT_ROOT:path.join(dataDir,'outputs')},
});
let logs='';server.stdout.on('data',value=>logs+=value);server.stderr.on('data',value=>logs+=value);
const base=`http://127.0.0.1:${port}`;
const post=(url,body)=>fetch(base+url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
try{
  let ready=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/api/state')).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
  assert.ok(ready,logs);
  const platforms=(await (await fetch(base+'/api/platforms')).json()).platforms;
  const other=platforms.find(p=>p.key==='zhaopin');assert.ok(other);assert.notEqual(other.manualLoginAvailable,false);
  for(const key of ['job51','jobonline'])assert.equal(platforms.find(p=>p.key===key)?.manualLoginAvailable,false);
  const created=await post('/api/tasks',{label:'登录入口移除验收',primaryKeyword:'测试工程师',keywords:['测试工程师'],cities:['北京'],targetRows:2,platforms:['job51','jobonline']});
  assert.equal(created.status,201,await created.clone().text());
  const {task}=await created.json();assert.deepEqual(task.platforms,['job51','jobonline']);
  for(const key of ['job51','jobonline']){
    let response=await post(`/api/platforms/${key}/login`,{});
    assert.equal(response.status,400);assert.match((await response.json()).error,/独立登录入口已移除/);
    response=await post(`/api/tasks/${encodeURIComponent(task.id)}/login`,{platform:key});
    assert.equal(response.status,400);assert.match((await response.json()).error,/不支持的登录平台/);
    const cli=spawn(process.execPath,[path.join(root,'work/login_job_platforms.mjs'),path.join(dataDir,`cli-${key}`),key],{cwd:root,windowsHide:true,stdio:['ignore','ignore','pipe']});
    let errors='';cli.stderr.on('data',value=>errors+=value);
    const code=await new Promise((resolve,reject)=>{cli.once('error',reject);cli.once('close',resolve);});
    assert.notEqual(code,0);assert.match(errors,/未知平台/);
    assert.equal(await fs.stat(path.join(dataDir,`cli-${key}`)).catch(()=>null),null,'CLI must reject before creating directories or opening browsers');
  }
  const state=await (await fetch(base+'/api/state')).json();assert.equal(state.activeCount,0);
  assert.ok(state.capabilities.job51Collection);assert.ok(state.capabilities.jobonlineCollection);
  assert.ok((await (await fetch(base+'/api/platforms')).json()).platforms.every(p=>p.status!=='opening'));
  console.log(JSON.stringify({ok:true,dataDir,checks:['task login buttons and handlers removed','platform-page buttons hidden including older servers','other login renderers retained','global and task login APIs rejected','CLI rejects before side effects','both collection channels remain enabled','no collection or login launched']}));
}catch(error){console.error(logs);throw error;}
finally{server.kill('SIGTERM');if(server.exitCode===null)await new Promise(resolve=>server.once('exit',resolve));}
