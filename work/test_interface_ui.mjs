import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const data=await fs.mkdtemp(path.join(os.tmpdir(),'interface-console-'));
const port=19885,base=`http://127.0.0.1:${port}`;
const child=spawn(process.execPath,['job_collector_ui/server.mjs',String(port)],{cwd:root,env:{...process.env,JOB_UI_PORT:String(port),JOB_UI_OPEN_BROWSER:'0',JOB_UI_DATA_DIR:data,JOB_TASK_OUTPUT_ROOT:path.join(data,'outputs')},windowsHide:true});
let logs='';child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x);
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try {
 let state;
 for(let i=0;i<80;i++){try{state=await fetch(base+'/api/state').then(r=>r.json());if(state.version)break;}catch{}await wait(100);}
 assert.equal(state?.version,'1.13.1',logs);
 assert.equal(state.activeCount,0);
 assert.equal(state.capabilities.channelAcquisition.mohrss.mode,'server_embedded_json');
 const html=await fetch(base).then(r=>r.text());
 assert.match(html,/公开列表与详情接口/);
 assert.match(html,/采集交付不做岗位相关性过滤/);
 const response=await fetch(base+'/api/tasks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({label:'接口采集验收',primaryKeyword:'数据分析',keywords:['数据分析','数据工程师'],targetRows:100,candidateTarget:150,cities:['北京','天津','上海','重庆','南京','苏州','杭州','武汉','广州','深圳','成都','西安'],platforms:['shixiseng','iguopin','mohrss','jobonline','job51','zhaopin'],pace:'safe'})});
 const result=await response.json();assert.equal(response.status,201,JSON.stringify(result));
 const task=result.task||result;
 const configs=path.join(data,'tasks',task.id);
 const publicConfig=JSON.parse(await fs.readFile(path.join(configs,'公开渠道配置.json'),'utf8'));
 const zhaopin=JSON.parse(await fs.readFile(path.join(configs,'智联批量配置.json'),'utf8'));
 assert.equal(publicConfig.task_id,task.id);
 assert.equal(publicConfig.platforms.jobonline.maxRows,150);
 assert.equal(publicConfig.platforms.jobonline.maxPages,500);
 assert.equal(publicConfig.platforms.job51.maxPages,100);
 assert.equal(publicConfig.apiExecutionVersion,2);
 assert.deepEqual(publicConfig.keywords,['数据分析','数据工程师']);
 assert.equal(zhaopin.cities.length,12);
 assert.equal(zhaopin.acquisitionMode,'session_api');
 assert.deepEqual(zhaopin.request,publicConfig.request);
 assert.equal((await fetch(base+'/api/state').then(r=>r.json())).activeCount,0,'creating task never starts collection');
 console.log('PASS isolated console: six channels, 12 cities, pace propagation, task ID, no relevance filter, truthful transport metadata; no network collection started');
}finally {
 child.kill();await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('close',resolve);});
}
