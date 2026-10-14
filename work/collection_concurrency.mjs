import fs from 'node:fs/promises';
import path from 'node:path';

// Independent channels fail independently; resource/output pauses stop new work.
export async function runChannels(items, limit, run, shouldStop=()=>false) {
  const results=[]; let cursor=0;
  await Promise.all(Array.from({length:Math.min(Math.max(1,limit),items.length)},async()=>{
    while(cursor<items.length && !shouldStop()) {
      const item=items[cursor++];
      try { results.push({item,value:await run(item)}); }
      catch(error) { results.push({item,error}); }
    }
  }));
  return results;
}

export async function withAccountLock(file, taskId, action, {interval=2000,onWait=()=>{},shouldStop=()=>false}={}) {
  await fs.mkdir(path.dirname(file),{recursive:true});
  let handle;
  while(!handle) {
    if(shouldStop())return {platform:'zhaopin',code:43};
    try {
      handle=await fs.open(file,'wx');
      await handle.writeFile(JSON.stringify({pid:process.pid,task_id:taskId}));
    } catch(error) {
      if(error.code!=='EEXIST')throw error;
      let raw;
      try {
        raw=await fs.readFile(file,'utf8');
        const owner=JSON.parse(raw);
        try { process.kill(owner.pid,0); }
        catch(probe) {
          if(probe.code==='ESRCH' && await fs.readFile(file,'utf8')===raw) await fs.unlink(file);
        }
      } catch(readError) { if(readError.code!=='ENOENT' && !(readError instanceof SyntaxError))throw readError; }
      onWait();
      await new Promise(resolve=>setTimeout(resolve,interval));
    }
  }
  try { return await action(); }
  finally { await handle.close(); await fs.unlink(file).catch(error=>{if(error.code!=='ENOENT')throw error;}); }
}

export function reuseShixiDetails(records, details, cache) {
  let reused=0;
  for(const record of records) {
    const current=details[record.uuid];
    if(current?.ok && Object.keys(current.data||{}).length)continue;
    if(cache.has(record.uuid)){details[record.uuid]=cache.get(record.uuid);reused++;}
  }
  return reused;
}

// Only successful, nonempty details are reusable, scoped to this task directory.
export async function loadShixiDetailCache(checkpointDir, taskId) {
  const cache=new Map();
  for(const name of await fs.readdir(checkpointDir).catch(()=>[])) {
    if(!/^shixiseng_.*\.json$/.test(name))continue;
    const saved=JSON.parse(await fs.readFile(path.join(checkpointDir,name),'utf8'));
    if(saved.task_id!==taskId)continue;
    for(const [id,detail] of Object.entries(saved.details||{}))
      if(detail.ok && detail.data && Object.keys(detail.data).length)cache.set(id,detail);
  }
  return cache;
}
