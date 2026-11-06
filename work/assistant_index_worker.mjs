import {parentPort,workerData} from 'node:worker_threads';
import {createKnowledgeAssistantStore} from './job_decision_assistant.mjs';
import {createClassificationCache} from './assistant_classification_cache.mjs';
import {knowledgeStore} from './job_knowledge_store.mjs';
import {knowledgeDatabasePath} from './knowledge_storage.mjs';
import {readAssistantIndexSnapshot,saveAssistantIndexSnapshot} from './assistant_index_snapshot.mjs';
import {createRoleClassifierMatcher} from './data-analysis-classifier.mjs';
import {roleClassifier,supervisedRoleFamilies} from './role-classifier-registry.mjs';
let cache;
try{
  const models=workerData.models||[],classifiers=models.map(spec=>createRoleClassifierMatcher(spec.file,spec));
  parentPort.postMessage({type:'progress',progress:{phase:'index_reading',message:'正在核对岗位库版本与本机索引缓存'}});
  const state=await knowledgeStore(workerData.dataDir).status({synchronize:false});
  const scope=workerData.dataDir+'\n'+knowledgeDatabasePath(workerData.dataDir);
  const saved=workerData.force?null:await readAssistantIndexSnapshot(workerData.cacheDir,workerData.reuseLatest?null:state.revision,scope,{models});
  if(saved){
    parentPort.postMessage({type:'progress',progress:{phase:'index_ready',message:`已复用本机索引缓存 · ${saved.jobs.length.toLocaleString('zh-CN')} 条可检索岗位`}});
    parentPort.postMessage({type:'result',index:saved});
  }else{
  if(workerData.allowBuild===false)throw Object.assign(Error('暂无可复用快照，等待其他任务释放资源后生成'),{code:'ASSISTANT_SNAPSHOT_QUEUED'});
  cache=createClassificationCache(workerData.cacheDir,{models});cache.begin();
  const store=createKnowledgeAssistantStore(workerData.dataDir,{readOnly:true,background:false,classificationCache:cache,classifiers});
  const index=await store.load({onProgress:progress=>parentPort.postMessage({type:'progress',progress})});
  cache.close();cache=null;
  const available=new Map(supervisedRoleFamilies().map(role=>[role,roleClassifier(role).metadata]));
  for(const classifier of classifiers)available.set(classifier.metadata.family,classifier.metadata);
  index.roleSnapshots=Object.fromEntries([...available].map(([role,model])=>[role,{role,model_version:model.version,model_sha256:model.artifact_sha256,
    quality:'qualified',source_revision:index.report.revision,source_rows:index.report.candidate_rows,generated_at:new Date().toISOString(),
    jobs:index.jobs.filter(job=>job.role_families?.includes(role)).map(job=>({key:job.key,content_hash:job.content_hash}))}]));
  index.report.snapshot_generated_at=new Date().toISOString();
  index.indexCache='rebuilt';await saveAssistantIndexSnapshot(workerData.cacheDir,index,scope,{models});
  parentPort.postMessage({type:'result',index});
  }
}catch(error){parentPort.postMessage({type:'error',message:String(error.message||'岗位索引构建失败'),code:error.code});}
finally{cache?.close();parentPort.close();}
