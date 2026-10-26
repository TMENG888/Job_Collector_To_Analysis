import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {writeJsonAtomic} from './collector_storage.mjs';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'zero-list-live-'));
const results=[];
for(const platform of ['zhaopin','yupao']){
 const dir=path.join(root,platform);await fs.mkdir(dir);
 const config=path.join(dir,'config.json');
 await writeJsonAtomic(config,{keywords:[platform==='zhaopin'?'agent开发':'智能体开发'],cities:[{name:platform==='zhaopin'?'广州':'北京',code:'763'}],maxPagesPerCombo:1,detailLimitPerCombo:1});
 const args=platform==='zhaopin'?['work/collect_logged_zhaopin_batch.mjs',dir,'30000',config]:['work/collect_logged_yupao.mjs',dir,config];
 const result=await new Promise(resolve=>{
  const child=spawn(process.execPath,args,{windowsHide:true});let output='';
  child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  const timeout=setTimeout(()=>child.kill(),90000);
  child.once('exit',(code,signal)=>{clearTimeout(timeout);resolve({platform,code,signal,output,dir});});
 });
 results.push(result);console.log(JSON.stringify(result));
}
await writeJsonAtomic(path.join(root,'result.json'),results);
console.log('Evidence directory: '+root);
if(results.some(r=>r.code!==42))process.exitCode=1;
