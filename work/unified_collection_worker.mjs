import path from 'node:path';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {updateUnifiedDataset} from './unified_collection_store.mjs';
import {writeJsonAtomic} from './collector_storage.mjs';
import {knowledgeStore} from './job_knowledge_store.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const workerDataDir=process.env.JOB_UI_DATA_DIR?path.resolve(process.env.JOB_UI_DATA_DIR):path.join(root,'ui_data');
const base=process.argv[2]||'http://127.0.0.1:8788';
const snapshotPath=process.env.JOB_UI_DATA_DIR?path.join(workerDataDir,'unified-progress.json'):path.join(root,'job_collector_ui/public/unified-progress.json');
const lockPath=path.join(workerDataDir,`unified-worker-${new URL(base).port}.lock`);
try {const lock=await fs.open(lockPath,'wx');await lock.writeFile(String(process.pid));await lock.close();}
catch(error) {
  if(error.code!=='EEXIST')throw error;
  const pid=Number(await fs.readFile(lockPath,'utf8'));
  let alive=true;try{process.kill(pid,0);}catch(error){if(error.code==='ESRCH')alive=false;else throw error;}
  if(alive)process.exit(0);
  await fs.unlink(lockPath);
  const lock=await fs.open(lockPath,'wx');await lock.writeFile(String(process.pid));await lock.close();
}
const reports={};let failures=0;
while(true) {
  let serverReached=false;
  try {
    const response=await fetch(`${base}/api/tasks`,{signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error(`HTTP ${response.status}`);
    serverReached=true;
    const {tasks}=await response.json();
    for(const task of tasks) {
      if(!['running','stopping'].includes(task.status) && !reports[task.id])continue;
      try {reports[task.id]=await updateUnifiedDataset(task);}
      catch(error){reports[task.id]={...reports[task.id],task_id:task.id,error:error.message};console.error(task.id,error.message);}
    }
    const sync=await knowledgeStore().sync({tasks,refresh:false});
    await writeJsonAtomic(snapshotPath,{updatedAt:new Date().toISOString(),knowledgeRevision:sync.revision,syncErrors:sync.sync_errors,tasks:reports});failures=0;
  }catch(error){console.error(error.message);failures++;if(!serverReached&&failures>=3)break;}
  // A transient ingestion/disk failure must not permanently disable live data.
  // Still exit when the owning console is no longer reachable.
  await new Promise(resolve=>setTimeout(resolve,Math.min(60000,15000*Math.max(1,failures))));
}
