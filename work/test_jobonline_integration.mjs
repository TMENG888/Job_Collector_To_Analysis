import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {parseChannelCsv} from './public_channel_csv.mjs';
const root=path.resolve(import.meta.dirname,'..'),dir=await fs.mkdtemp(path.join(os.tmpdir(),'jobonline-integration-'));
const origin='http://127.0.0.1:8789';
const server=spawn(process.execPath,['job_collector_ui/server.mjs','8789'],{cwd:root,env:{...process.env,JOB_UI_DATA_DIR:dir,JOB_UI_PORT:'8789',JOB_UI_OPEN_BROWSER:'0'},windowsHide:true,stdio:'ignore'});
async function wait(fn){for(let i=0;i<100;i++){if(await fn().catch(()=>false))return;await new Promise(r=>setTimeout(r,100));}throw Error('test timeout');}
async function api(url,body){const response=await fetch(origin+url,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});const data=await response.json();assert.ok(response.ok,JSON.stringify(data));return data;}
try{
 await wait(async()=> (await fetch(origin+'/api/state')).ok);
 assert.ok((await api('/api/state')).capabilities.jobonlineCollection);
 const platforms=(await api('/api/platforms')).platforms;
 assert.ok(platforms.some(p=>p.key==='jobonline'));assert.ok(platforms.some(p=>p.key==='job51'));
 assert.match(await (await fetch(origin+'/')).text(), /value="jobonline"/);
 const {task}=await api('/api/tasks',{label:'工程师测试',primaryKeyword:'工程师',platforms:['jobonline'],cities:['北京'],targetRows:2,outputDir:path.join(dir,'output')});
 assert.deepEqual(task.platforms,['jobonline']);
 const saved=JSON.parse(await fs.readFile(path.join(dir,'tasks.json'),'utf8')).find(t=>t.id===task.id);
 const cfg=JSON.parse(await fs.readFile(saved.publicConfigPath,'utf8'));
 assert.ok(cfg.platforms.jobonline.enabled);assert.equal(cfg.platforms.jobonline.cities[0].name,'全国');assert.equal(cfg.platforms.job51.enabled,false);
 const csv='\uFEFFplatform,query_keyword,query_city,job_id,job_name,company_name,salary,city,job_description,job_url\r\n就业在线,工程师,全国,real-id,工程师,测试公司,4000-6000元/月,威海市,"负责产品工艺设计\n包含逗号,以及""引号""",https://www.jobonline.cn/positionDetail?id=real-id';
 assert.match(parseChannelCsv(csv)[0].job_description,/逗号,以及"引号"/);
 assert.throws(()=>parseChannelCsv('a\n"unterminated'),/引号未闭合/);
 await fs.writeFile(path.join(task.outputDir,'jobonline_标准化数据.csv'),csv);
 await api('/api/tasks/'+encodeURIComponent(task.id)+'/run',{stage:'finalize'});
 await wait(async()=> (await api('/api/tasks/'+encodeURIComponent(task.id))).task.status==='ready');
 const source=await api('/api/tasks/'+encodeURIComponent(task.id)+'/insight-source');assert.equal(source.dataset.expectedRows,1);
 const rows=JSON.parse(await fs.readFile(path.join(task.outputDir,'最终合并数据.json'),'utf8'));assert.equal(rows[0].platform,'就业在线');assert.equal(rows[0].salary,'4000-6000元/月');
 console.log(JSON.stringify({ok:true,checks:['channel catalog','task config','CSV multiline parsing','native merge','insight source transfer'],testDir:dir}));
}finally{server.kill();}
