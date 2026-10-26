import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'public-api-workflow-'));
const preload=path.join(root,'fetch-fixture.mjs');
await fs.writeFile(preload,`
globalThis.fetch=async(url,options)=>{
 const u=new URL(url),json=body=>new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
 if(u.pathname==='/app/interns/search/v2') {
  if(u.searchParams.get('page')==='2'&&process.env.API_FIXTURE==='blocked')return new Response('{}',{status:429});
  return json({code:100,msg:{total:process.env.API_FIXTURE==='blocked'?40:1,pageNumber:20,data:[{uuid:'inn_demo1',name:'销售岗位',city:'北京',cname:'测试公司'}]}});
 }
 if(u.pathname.endsWith('/api/interns/v3.0/interns/info/wxz'))return json({code:100,msg:{iname:'销售岗位',info:'与查询不相关但有效的岗位，必须保留',cname:'测试公司'}});
 throw Error('Unexpected endpoint: '+u.origin+u.pathname);
};
`);
async function run(mode,output,extra={}) {
 await fs.mkdir(output,{recursive:true});
 await fs.writeFile(path.join(output,'任务归属.json'),JSON.stringify({task_id:'test-task'}));
 const config=path.join(root,'config-'+mode+'.json');
 await fs.writeFile(config,JSON.stringify({task_id:'test-task',keywords:['数据分析'],request:{attempts:1,minimumIntervalMs:1,concurrency:1},platforms:{shixiseng:{enabled:true,cities:[{name:'全国'}],maxPages:2,maxRows:2}}}));
 const child=spawn(process.execPath,['--import',pathToFileURL(preload).href,fileURLToPath(new URL('./collect_public_job_platforms.mjs',import.meta.url)),config,output],{env:{...process.env,API_FIXTURE:mode,JOB_HTTP_RATE_DIR:path.join(root,'rate-'+mode),...extra},windowsHide:true});
 let logs='';child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x);
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
 assert.ok(await fs.stat(path.join(output,'采集清单.json')).catch(()=>false),logs);
 return {code,logs,manifest:JSON.parse(await fs.readFile(path.join(output,'采集清单.json'),'utf8')),csv:await fs.readFile(path.join(output,'shixiseng_标准化数据.csv'),'utf8')};
}
const blockedDir=path.join(root,'blocked');
const blocked=await run('blocked',blockedDir);
assert.equal(blocked.code,44,blocked.logs);
assert.equal(blocked.manifest.platforms.shixiseng.rows,1);
assert.equal(blocked.manifest.platforms.shixiseng.errors[0].stopChannel,true);
assert.match(blocked.csv,/销售岗位/,'unrelated valid candidate survives a later blocked page');
const retained=await run('blocked',blockedDir,{JOB_COLLECTOR_BLOCKED_POLICY:'skip'});
assert.equal(retained.code,44,retained.logs);
assert.equal(retained.manifest.platforms.shixiseng.rows,1);
assert.match(retained.logs,/本轮跳过/);
const success=await run('success',path.join(root,'success'));
assert.equal(success.code,0,success.logs);
assert.equal(success.manifest.total_rows,1);
assert.equal(success.manifest.platforms.shixiseng.acquisition.mode,'public_json_api');
assert.match(success.csv,/公开接口完整详情/);
assert.match(success.csv,/与查询不相关但有效的岗位/);
console.log('PASS public collector: JSON endpoints only, partial rows on limit block, retained retry, full details, unrelated candidates kept');
