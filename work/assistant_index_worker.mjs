import {parentPort,workerData} from 'node:worker_threads';
import {createKnowledgeAssistantStore} from './job_decision_assistant.mjs';
import {createClassificationCache} from './assistant_classification_cache.mjs';
import {knowledgeStore} from './job_knowledge_store.mjs';
import {knowledgeDatabasePath} from './knowledge_storage.mjs';
import {readAssistantIndexSnapshot,saveAssistantIndexSnapshot} from './assistant_index_snapshot.mjs';
let cache;
try{
  parentPort.postMessage({type:'progress',progress:{phase:'index_reading',message:'正在核对岗位库版本与本机索引缓存'}});
  const state=await knowledgeStore(workerData.dataDir).status({synchronize:false});
  const scope=workerData.dataDir+'\n'+knowledgeDatabasePath(workerData.dataDir);
  const saved=await readAssistantIndexSnapshot(workerData.cacheDir,state.revision,scope);
  if(saved){
    parentPort.postMessage({type:'progress',progress:{phase:'index_ready',message:`已复用本机索引缓存 · ${saved.jobs.length.toLocaleString('zh-CN')} 条可检索岗位`}});
    parentPort.postMessage({type:'result',index:saved});
  }else{
  cache=createClassificationCache(workerData.cacheDir);cache.begin();
  const store=createKnowledgeAssistantStore(workerData.dataDir,{readOnly:true,background:false,classificationCache:cache});
  const index=await store.load({onProgress:progress=>parentPort.postMessage({type:'progress',progress})});
  cache.close();cache=null;
  index.indexCache='rebuilt';await saveAssistantIndexSnapshot(workerData.cacheDir,index,scope);
  parentPort.postMessage({type:'result',index});
  }
}catch(error){parentPort.postMessage({type:'error',message:String(error.message||'岗位索引构建失败'),code:error.code});}
finally{cache?.close();parentPort.close();}
