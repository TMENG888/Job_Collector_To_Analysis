import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {assertCollectorResources} from './collector_resources.mjs';
import {writeJsonAtomic} from './collector_storage.mjs';
import {assertTaskOutputOwnership} from './task_dataset_scope.mjs';
import {readCollectionRound,filterCollectionCombinations,isConditionScopedStop} from './task_collection_config.mjs';
import {writeNativeChannelRows,readNativeTaskRows} from './collector_native_sink.mjs';
import {otherChannelValidCount,validJobRecord} from './task_collection_target.mjs';
import {collectionExitCode} from './collection_policy.mjs';
import {createPoliteHttpClient} from './polite_http_client.mjs';
import {zhaopinJobId,mergeZhaopinRawRow,isZhaopinCheckpointExhausted} from './zhaopin_api.mjs';
import {fetchDirectZhaopinPage,normalizeDirectZhaopin} from './direct_zhaopin_adapter.mjs';

const safe=value=>String(value).replace(/[\\/:*?"<>|]/g,'_');
const fail=(message,code='invalid_config')=>Object.assign(Error(message),{code,stopChannel:true});
const readJSON=async file=>fs.readFile(file,'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
const cap=(value,fallback,max)=>{const n=Number(value??fallback);if(!Number.isSafeInteger(n)||n<1||n>max)throw fail('智联每轮分页/岗位上限无效');return n;};
const outputOperation=async action=>{try{return await action();}catch(error){throw fail(error.message,'OUTPUT_LOCKED');}};

export async function runDirectZhaopin({outputDir,targetUnique,batchConfigPath,config,taskId=process.env.JOB_COLLECTOR_TASK_ID,round,request,resourceGuard=assertCollectorResources,log=console.log}={}){
  outputDir=path.resolve(outputDir||'.');
  const batch=config||await readJSON(path.resolve(batchConfigPath||''));
  if(!batch||!batch.task_id||taskId&&taskId!==batch.task_id)throw fail('智联配置缺少任务 ID 或与当前任务不一致');
  taskId=batch.task_id;
  try{await assertTaskOutputOwnership({id:taskId,outputDir});}catch(cause){throw fail(cause.message,'OUTPUT_LOCKED');}
  const keywords=[...new Set((batch.keywords||[]).map(word=>String(word).trim()).filter(Boolean))],cities=batch.cities||[];
  if(!keywords.length||!cities.length||cities.some(city=>!city?.name||!/^\d{1,8}$/.test(String(city.code))))throw fail('智联必须配置明确关键词和城市代码，不能静默补城市');
  const maxPages=cap(batch.maxPages,3,100),maxRows=cap(batch.maxRows,Math.min(50000,Number(targetUnique)||1000),50000),pageSize=cap(batch.pageSize,20,20);
  targetUnique=cap(Number(targetUnique)||maxRows,maxRows,100000);
  const strictTarget=Number(batch.taskTargetRows||0),otherValidRows=strictTarget?await otherChannelValidCount(outputDir,'zhaopin',taskId):0;
  if(strictTarget)targetUnique=Math.max(0,strictTarget-otherValidRows);
  const combinations=filterCollectionCombinations(round===undefined?readCollectionRound(taskId):round,'zhaopin',keywords.flatMap(keyword=>cities.map(city=>({keyword,city}))));
  const checkpointDir=path.join(outputDir,'断点数据','智联招聘_HTTP'),legacyDir=path.join(outputDir,'断点数据','智联招聘');
  const entries=new Map(),checkpoints=new Map(),keyOf=(keyword,city)=>JSON.stringify([keyword,city.name]);
  // Never overwrite legacy browser checkpoints. Every imported snapshot must
  // explicitly belong to this task; malformed snapshots are not silently lost.
  for(const [dir,direct] of [[legacyDir,false],[checkpointDir,true]]){
    const files=await fs.readdir(dir).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
    for(const file of files.filter(file=>file.endsWith('.json')&&file!=='调度状态.json')){
      const saved=await outputOperation(()=>readJSON(path.join(dir,file)));
      if(!saved||saved.task_id!==taskId)throw fail('智联断点任务归属缺失或不匹配，拒绝载入','OUTPUT_LOCKED');
      if(!Array.isArray(saved.records)||!saved.keyword||!saved.city?.name)throw fail('智联断点结构无效','OUTPUT_LOCKED');
      const key=keyOf(saved.keyword,saved.city);checkpoints.set(key,{...saved,_direct:direct});
      for(const raw of saved.records){
        const id=zhaopinJobId(raw);if(!id||raw.task_id&&raw.task_id!==taskId)throw fail('智联断点记录归属或 ID 无效','OUTPUT_LOCKED');
        entries.set(id,{raw:mergeZhaopinRawRow(entries.get(id)?.raw,raw),keyword:saved.keyword,cityName:saved.city.name,total:saved.total,collectedAt:saved.collected_at,mode:direct?'public_json_api':'browser_session_api'});
      }
    }
  }
  const native=await outputOperation(()=>readNativeTaskRows(outputDir,taskId,'zhaopin')),nativeById=new Map(native.map(row=>[String(row.job_id),row]));
  const rows=()=>{const merged=new Map(nativeById);for(const [id,item]of entries){const row=normalizeDirectZhaopin(item.raw,item.keyword,item.cityName,item.total,item.collectedAt,item.mode),old=merged.get(id);if(old&&String(old.job_description||'').length>row.job_description.length){row.job_description=old.job_description;row.detail_status=old.detail_status||'complete';}merged.set(id,{...old,...row,task_id:taskId});}return [...merged.values()];};
  const initialRows=rows(),knownIds=new Set(initialRows.map(row=>String(row.job_id))),validIds=new Set(initialRows.filter(validJobRecord).map(row=>String(row.job_id)));
  const enough=()=>validIds.size>=targetUnique;
  let active=null,exitCode=0;const errors=[];
  await outputOperation(()=>fs.mkdir(checkpointDir,{recursive:true}));
  request=request||createPoliteHttpClient({stateDir:process.env.JOB_HTTP_RATE_DIR||path.resolve('ui_data/http_rate_limits'),minimumIntervalMs:Math.max(2500,Number(batch.request?.minimumIntervalMs)||3000),jitterMs:batch.request?.jitterMs,attempts:batch.request?.attempts||1});
  const persist=()=>outputOperation(async()=>{
    if(active){const {file,...snapshot}=active;await writeJsonAtomic(file,{...snapshot,task_id:taskId,acquisition_mode:'public_json_api',collected_at:new Date().toISOString()});}
    await writeNativeChannelRows(outputDir,taskId,rows());
  });
  try{
    for(const {keyword,city}of combinations){
      if(enough())break;
      const saved=checkpoints.get(keyOf(keyword,city));
      if(saved?._direct&&isZhaopinCheckpointExhausted(saved))continue;
      // The no-credential request is a new contract. Import legacy records but
      // independently verify its page one; never advance using browser cursors.
      const initialPage=saved?._direct?Number(saved.next_page_index):1;
      if(!Number.isSafeInteger(initialPage)||initialPage<1)throw fail('智联断点页码无效','OUTPUT_LOCKED');
      active={file:path.join(checkpointDir,`${safe(keyword)}_${safe(city.name)}.json`),keyword,city,records:[...(saved?.records||[])],total:Number(saved?.total||0),last_page_index:saved?._direct?Number(saved.last_page_index||0):0,next_page_index:initialPage,next_card_index:saved?._direct?Number(saved.next_card_index||0):0,page_signature:saved?._direct?saved.page_signature||'':'',previous_page_signature:saved?._direct?saved.previous_page_signature||'':'',api_first_page_verified:saved?._direct&&saved.api_first_page_verified===true,complete:false,end_page:false,completion_reason:'in_progress'};
      if(!Number.isSafeInteger(active.next_card_index)||active.next_card_index<0)throw fail('智联断点页内游标无效','OUTPUT_LOCKED');
      const current=new Map(active.records.map(raw=>[zhaopinJobId(raw),raw]));
      try{
        for(let attempt=0;attempt<maxPages&&active.next_page_index<=maxPages&&!enough();attempt++){
          await resourceGuard();
          const page=active.next_page_index,parsed=await fetchDirectZhaopinPage(request,keyword,city,page,pageSize),signature=JSON.stringify(parsed.rows.map(zhaopinJobId));
          if(parsed.rows.length&&active.previous_page_signature===signature)throw fail('智联相邻页岗位完全重复，保存断点切换条件；未认定穷尽','pagination_stalled');
          if(active.next_card_index&&active.page_signature!==signature)throw fail('智联断点页内容变化，停止当前条件以避免跳过岗位','pagination_stalled');
          active.total=parsed.total;active.api_first_page_verified=true;active.page_signature=signature;
          let index=active.next_card_index,deferredIndex=null;
          for(;index<parsed.rows.length;index++){
            const raw=parsed.rows[index],id=zhaopinJobId(raw);
            // At the row cap still enrich already-known incomplete jobs. Keep
            // the earliest skipped cursor, so increasing the cap cannot lose
            // candidates even if later known rows on this page were enriched.
            if(!knownIds.has(id)&&knownIds.size>=maxRows){deferredIndex??=index;continue;}
            const merged=mergeZhaopinRawRow(current.get(id)||entries.get(id)?.raw,raw);current.set(id,merged);
            entries.set(id,{raw:merged,keyword,cityName:city.name,total:parsed.total,collectedAt:new Date().toISOString(),mode:'public_json_api'});active.next_card_index=index+1;
            knownIds.add(id);
            const normalized=normalizeDirectZhaopin(merged,keyword,city.name,parsed.total),old=nativeById.get(id);
            if(old&&String(old.job_description||'').length>normalized.job_description.length)normalized.job_description=old.job_description;
            if(validJobRecord(normalized))validIds.add(id);else validIds.delete(id);
            if(enough()){index++;break;}
          }
          active.records=[...current.values()];active.last_page_index=page;
          if(deferredIndex!=null)active.next_card_index=deferredIndex;
          const consumed=deferredIndex==null&&index>=parsed.rows.length;
          if(consumed){active.next_page_index=page+1;active.next_card_index=0;active.previous_page_signature=signature;active.page_signature='';}
          active.end_page=consumed&&(parsed.endPage||parsed.explicitEmpty);active.complete=active.end_page||consumed&&parsed.total>0&&current.size>=parsed.total;
          active.completion_reason=active.complete?(parsed.explicitEmpty?'confirmed_empty':parsed.endPage?'end_page':'total_reached'):enough()||deferredIndex!=null?'row_or_target_limit':'page_budget';
          await persist();
          log(`zhaopin ${keyword}/${city.name}: 独立HTTP第${page}页，${rows().length}条`);
          if(active.complete||!consumed)break;
        }
      }catch(error){
        active.records=[...current.values()];active.complete=false;active.end_page=false;active.completion_reason=error.code||'collection_error';active.stop_reason=error.code||'collection_error';
        errors.push({keyword,city,code:error.code||'collection_error',message:error.message});exitCode=collectionExitCode(error);
        await persist();
        if(!isConditionScopedStop(error))throw error;
      }
      active=null;
    }
  }catch(error){
    exitCode=collectionExitCode(error);if(!errors.some(item=>item.message===error.message))errors.push({keyword:active?.keyword,city:active?.city,code:error.code||'collection_error',message:error.message});
    try{await persist();}catch(outputError){exitCode=42;errors.push({code:outputError.code||'output_error',message:outputError.message});}
  }
  try{
    await writeNativeChannelRows(outputDir,taskId,rows());
    const status={task_id:taskId,acquisition_mode:'public_json_api',target_unique:targetUnique,collected_unique:rows().length,output_rows:rows().length,valid_output_rows:rows().filter(validJobRecord).length,task_target_rows:strictTarget||null,other_channel_valid_rows:otherValidRows,completed:!exitCode&&rows().filter(validJobRecord).length>=targetUnique,paused:Boolean(exitCode),errors,max_pages_per_condition:maxPages,max_rows:maxRows,updated_at:new Date().toISOString()};
    await writeJsonAtomic(path.join(outputDir,'智联招聘_采集状态.json'),status);
    if(errors.length)await writeJsonAtomic(path.join(outputDir,'智联招聘_暂停原因.json'),{task_id:taskId,...errors.at(-1),updated_at:new Date().toISOString()});
    return {exitCode,...status,outputDir};
  }catch(error){return {exitCode:42,task_id:taskId,errors:[...errors,{code:error.code||'output_error',message:error.message}],outputDir};}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{const result=await runDirectZhaopin({outputDir:process.argv[2],targetUnique:Number(process.argv[3]),batchConfigPath:process.argv[4]});console.log(JSON.stringify(result));process.exitCode=result.exitCode;}
  catch(error){console.error(error.message);process.exitCode=collectionExitCode(error);}
}
