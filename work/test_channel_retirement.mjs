import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {collectionChannelAvailable,retiredCollectionChannels} from './channel_availability.mjs';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'channel-retirement-'));
for(const key of ['yupao','boss'])assert.equal(collectionChannelAvailable(key),false);
// 公开/会话直连可用（job51 为会话代理，任何模式可用；liepin 需会话模板）。
for(const key of ['shixiseng','iguopin','mohrss','zhaopin','jobonline','liepin','job51'])assert.equal(collectionChannelAvailable(key),true);
async function run(file,args=[]){
 const child=spawn(process.execPath,[file,...args],{windowsHide:true});let stdout='',stderr='';
 child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
 assert.equal(code,0,stderr);return stdout;
}
for(const [key,file] of [['yupao','work/collect_logged_yupao.mjs'],['boss','work/collect_logged_boss.mjs']]){
 const sentinel=path.join(dir,key+'_标准化数据.csv');await fs.writeFile(sentinel,'historical-data');
 const output=await run(file,[dir,path.join(dir,'nonexistent-config.json')]);
 assert.match(output,/跳过网站请求/);assert.equal(await fs.readFile(sentinel,'utf8'),'historical-data');
}
assert.deepEqual([...retiredCollectionChannels],['yupao','boss']);
assert.ok(!(await fs.readdir(dir)).includes('断点数据'));
const source=await fs.readFile('work/collect_public_job_platforms.mjs','utf8');
assert.ok(source.indexOf('if(!collectionChannelAvailable(platform))')<source.indexOf('const result = await collectors[platform]'));
const serverSource=await fs.readFile('job_collector_ui/server.mjs','utf8');
assert.match(serverSource,/task\.platforms\.some\(key=>\['shixiseng','iguopin','mohrss','job51','jobonline','liepin'\]\.includes\(key\)\)/);
console.log(JSON.stringify({ok:true,checks:['retired policies','job51 restored','retired workers stop before config/browser','public gate precedes requests','job51 starts public collection stage'],testDir:dir}));
