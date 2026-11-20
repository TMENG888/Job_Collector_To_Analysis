import fs from 'node:fs/promises';
import path from 'node:path';
import {withAccountLock} from './collection_concurrency.mjs';
import {writeJsonAtomic} from './collector_storage.mjs';

// Manual recovery and collectors share a manifest, but never replace another
// platform's newer state with a snapshot taken before the operation began.
export async function updateChannelManifest(task,change){
  return withAccountLock(path.join(task.outputDir,'.channel-manifest.lock'),task.id,async()=>{
    const file=path.join(task.outputDir,'采集清单.json');
    const value=await fs.readFile(file,'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return {task_id:task.id,created_at:new Date().toISOString(),platforms:{}};throw error;});
    if(!value||Array.isArray(value)||value.task_id!==task.id||Object.hasOwn(value,'platforms')&&(!value.platforms||typeof value.platforms!=='object'||Array.isArray(value.platforms)))throw Error('采集清单归属或结构无效');
    value.platforms??={};
    if(await change(value)!==false)await writeJsonAtomic(file,value);
    return value;
  },{interval:20});
}
