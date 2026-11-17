import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {timingSafeEqual} from 'node:crypto';

export async function acquireBackendOwner(dataDir){
  await fs.mkdir(dataDir,{recursive:true});const file=path.join(dataDir,'backend-owner.lock');
  let previous;try{previous=JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw Error('后台归属锁不可读取，请先核对进程');}
  if(previous){
    let alive=true;try{process.kill(previous.pid,0);}catch(error){if(error.code==='ESRCH')alive=false;}
    if(alive)throw Error('同一数据目录已有后台执行进程，未重复加载任务');
    await fs.unlink(file);
  }
  const lock=await fs.open(file,'wx');await lock.writeFile(JSON.stringify({pid:process.pid,createdAt:new Date().toISOString()}));await lock.close();
  process.once('exit',()=>{try{if(JSON.parse(fsSync.readFileSync(file,'utf8')).pid===process.pid)fsSync.unlinkSync(file);}catch{}});
}

export function authorizeWorker(req,res){
  const expected=process.env.JOB_WORKER_TOKEN;if(!expected)return true;
  const provided=String(req.headers['x-job-worker-token']||'');
  if(Buffer.byteLength(provided)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(provided),Buffer.from(expected))){res.writeHead(403,{'content-type':'application/json'});res.end(JSON.stringify({error:'仅允许FastAPI调度进程访问'}));return false;}
  return true;
}
