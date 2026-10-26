import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {writeJsonAtomic} from './collector_storage.mjs';
import {isZhaopinCheckpointExhausted} from './zhaopin_api.mjs';
import {isConditionScopedStop,retainedChannelErrors} from './task_collection_config.mjs';
import {collectionChannelAvailable} from './channel_availability.mjs';
import {unverifiedLegacyCompletion} from './jobonline_pagination_health.mjs';
import {untilExhausted} from './collection_goal.mjs';
import {mohrssCheckpointNeedsContinuation,mohrssConsumedPages} from './mohrss_related_search.mjs';
import {zhaopinSessionCheckpointPath,validateZhaopinSessionCheckpoint,zhaopinSessionCheckpointState} from './zhaopin_session_checkpoint.mjs';

const unique=values=>[...new Set(values.map(x=>String(x||'').trim()).filter(Boolean))];
const safeName=value=>String(value).replace(/[\\/:*?"<>|]/g,'_');
const read=async file=>fs.readFile(file,'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
export const searchCombinationKey=combo=>JSON.stringify([combo.platform,combo.keyword,combo.city.name]);

// A conservative, explicit family dictionary, not unrestricted model-generated
// queries. Unknown/narrower roles keep only their user-configured terms.
export function relatedCollectionKeywords(task){
  if(task.adaptiveSearch===false)return [];
  if(!['测试工程师','软件测试','软件测试工程师'].includes(String(task.primaryKeyword||'').trim()))return [];
  return ['软件测试','自动化测试工程师','测试开发工程师','接口测试工程师','性能测试工程师'];
}

export function checkpointSearchState(platform,saved,settings={}){
  if(!saved)return 'pending';
  if(saved.acquisition_mode==='browser_dom')return saved.completed?(saved.records?.length?'query_finished':'empty_unverified'):saved.budget_finished?'browser_budget_limit':saved.stop_reason||'pending';
  if(isConditionScopedStop({code:saved.stop_reason}))return saved.stop_reason;
  if(platform==='jobonline'&&unverifiedLegacyCompletion(saved))return 'legacy_pagination_unverified';
  if(platform==='mohrss'&&mohrssCheckpointNeedsContinuation(saved,{keyword:saved.keyword,city:saved.city,settings,taskId:saved.task_id??null}))return 'pending';
  if(saved.low_yield)return 'low_yield_deferred';
  if(platform==='zhaopin'){
    if(saved.acquisition_mode==='session_json_api')return zhaopinSessionCheckpointState(saved,settings);
    if(isZhaopinCheckpointExhausted(saved))return 'query_finished';
    if(Number(settings.maxRows)>0&&(saved.records||[]).length>=Number(settings.maxRows))return 'row_limit';
    if(Number(saved.next_card_index||0)===0&&Number(saved.last_page_index||0)>=Number(settings.maxPages||Infinity))return 'page_limit';
    return 'pending';
  }
  if(saved.completed)return saved.completion_reason||'query_finished';
  const rows=(saved.records||saved.list||saved.rows||[]).length;
  if(platform!=='jobonline'&&Number(settings.maxRows)>0&&rows>=Number(settings.maxRows))return 'row_limit';
  if(platform==='shixiseng'){
    if(saved.listComplete){
      const selected=(saved.list||[]).slice(0,Number(settings.maxRows)||Infinity);
      return selected.some(row=>!saved.details?.[row.uuid]?.ok)?'pending':'query_finished';
    }
    if(Number(saved.lastListPage||1)>=Number(settings.maxPages||Infinity))return 'page_limit';
  }else if(platform==='iguopin'||platform==='mohrss'){
    if((platform==='mohrss'?mohrssConsumedPages(saved):Number(saved.lastPage||0))>=Number(settings.maxPages||Infinity))return 'page_limit';
  }else if(platform==='liepin'){
    if(Number(saved.nextPageNo??saved.lastPage??0)>=Number(settings.maxPages||100))return 'page_limit';
  }else if(Number(saved.nextPageNo||saved.pageNo||1)>Number(settings.maxPages||500))return 'page_limit';
  return 'pending';
}

export async function readCollectionSearchQueue(task,{channelAvailable=key=>collectionChannelAvailable(key,task),rateStateDir=process.env.JOB_HTTP_RATE_DIR||path.resolve(import.meta.dirname,'../ui_data/http_rate_limits'),now=Date.now}={}){
  const config=await read(task.publicConfigPath);
  if(config?.task_id!==task.id)throw Error('采集调度配置任务 ID 不匹配');
  const manifest=await read(path.join(task.outputDir,'采集清单.json'));
  if(manifest&&manifest.task_id!==task.id)throw Error('采集调度清单任务 ID 不匹配');
  const parallel=await read(path.join(task.outputDir,'并发渠道状态.json'));
  if(parallel&&parallel.task_id!==task.id)throw Error('采集调度并发状态任务 ID 不匹配');
  const sessionMode=config.platforms?.zhaopin?.enabled===true;
  const logged=task.platforms.includes('zhaopin')&&channelAvailable('zhaopin')&&task.zhaopinConfigPath?await read(task.zhaopinConfigPath):null;
  if(logged&&logged.task_id!==task.id)throw Error('采集调度智联配置任务 ID 不匹配');
  if(task.platforms.includes('zhaopin')&&channelAvailable('zhaopin')&&!logged&&!sessionMode)throw Error('缺少智联采集调度配置');
  const rateKey=createHash('sha256').update('https://fe-api.zhaopin.com').digest('hex').slice(0,24);
  const rate=rateStateDir&&task.platforms.includes('zhaopin')?await read(path.join(rateStateDir,rateKey+'.json')):null;
  const combos=[];
  for(const platform of task.platforms){
    if(!channelAvailable(platform))continue;
    const settings=platform==='zhaopin'&&!sessionMode?logged:config.platforms?.[platform];
    if(!settings||(platform!=='zhaopin'&&!settings.enabled))continue;
    const blocked=platform==='zhaopin'&&!sessionMode
      ? parallel?.results?.some(row=>row.platform==='zhaopin'&&row.code!==0&&!(row.errors?.length&&row.errors.every(isConditionScopedStop)))
      : retainedChannelErrors(manifest,task.id,platform,'skip').length>0;
    const totalLimited=platform==='jobonline'&&Number(settings.totalMaxRows||settings.maxRows)>0
      && Number(manifest?.platforms?.jobonline?.rows||0)>=Number(settings.totalMaxRows||settings.maxRows);
    for(const keyword of unique([task.primaryKeyword,...(task.keywords||[])]))for(const city of settings.cities||[]){
      const file=platform==='zhaopin'?path.join(task.outputDir,'断点数据','智联招聘',`${safeName(keyword)}_${safeName(city.name)}.json`)
        :path.join(task.outputDir,'断点数据',`${platform}_${safeName(keyword)}_${safeName(city.name)}.json`);
      const legacy=await read(file);
      let saved=legacy;
      if(platform==='zhaopin'){
        if(legacy&&legacy.task_id!==task.id)throw Error('采集调度断点任务 ID 不匹配');
        const direct=await read(path.join(task.outputDir,'断点数据','智联招聘_HTTP',`${safeName(keyword)}_${safeName(city.name)}.json`));
        // A legacy browser cursor cannot certify that the new no-credential
        // contract was verified. Its rows remain available to the worker.
        const session=await read(zhaopinSessionCheckpointPath(task.outputDir,keyword,city));
        validateZhaopinSessionCheckpoint(session,{taskId:task.id,keyword,city});
        saved=session||(sessionMode?null:direct||(legacy?{...legacy,api_first_page_verified:false,low_yield:null,stop_reason:null,last_page_index:0}:null));
      }
      if(task.transportMode==='http_preferred_browser_fallback'){
        const browser=await read(path.join(task.outputDir,'断点数据','RPA',platform,`${safeName(keyword)}_${safeName(city.name)}.json`));
        if(browser)saved=browser;
      }
      if(saved&&saved.task_id!==task.id)throw Error('采集调度断点任务 ID 不匹配');
      if(platform==='mohrss'&&saved&&(saved.keyword!=null&&saved.keyword!==keyword||saved.city?.name&&saved.city.name!==city.name))throw Error('公共招聘网采集调度断点查询条件不匹配');
      // Some legacy checkpoints have no task id. Never silently adopt one here.
      const conditionError=manifest?.platforms?.[platform]?.errors?.some(error=>!error.resolved_at&&error.keyword===keyword&&error.city?.name===city.name&&!isConditionScopedStop(error));
      let state=blocked?'channel_blocked':totalLimited?'total_limit':conditionError?'condition_error':checkpointSearchState(platform,saved,settings);
      // A finished query is finished even while the origin is cooling. Every
      // unfinished condition waits on the same source instead of being retired.
      if(platform==='zhaopin'&&state==='pending'&&Number(rate?.cooldownUntil)>now())state='origin_cooldown';
      // Cursor/count metadata only: no credential, job text or record id is
      // exposed in the scheduling journal. Detect a stuck condition even when
      // a different channel in the same batch is still making progress.
      const progress=JSON.stringify(saved?[saved.records?.length??saved.list?.length??saved.rows?.length??0,saved.nextPageNo,saved.pageNo,saved.lastPage,saved.lastListPage,saved.last_page_index,saved.nextPage,Object.values(saved.details||{}).filter(value=>value.ok).length]:null);
      combos.push({platform,keyword,city,state,progress,...(state==='origin_cooldown'?{retryAfter:new Date(rate.cooldownUntil).toISOString()}: {})});
    }
  }
  return combos;
}

export function collectionQueueStopReason(queue){
  if(queue.some(c=>c.state==='origin_cooldown'))return 'waiting_cooldown';
  if(queue.length&&queue.every(c=>c.state==='channel_blocked'))return 'channels_blocked';
  if(queue.some(c=>c.state==='channel_blocked'))return 'partially_blocked';
  if(queue.some(c=>!['query_finished','source_finished','public_search_window_end','confirmed_empty'].includes(c.state)))return 'conditions_deferred';
  return 'search_queue_exhausted';
}

// Each condition is attempted independently. A no-growth batch retires only its
// own conditions, never another keyword/city/channel. Pauses remain task-wide.
export async function runAdaptiveCollection({task,count,run,activateKeyword,onRound=async()=>{},isCancelled=()=>false,maxRounds=151,readQueue=readCollectionSearchQueue}){
  const openEnded=untilExhausted(task),target=openEnded?null:Number(task.targetRows);
  if(!openEnded&&(!Number.isSafeInteger(target)||target<1))throw Error('目标执行数量无效');
  let valid=await count(),rounds=0,lastQueue=[];
  const retired=new Set(),blockedPlatforms=new Set(),history=[];
  const persist=async(reason,queue=lastQueue)=>{
    const state={version:1,task_id:task.id,updated_at:new Date().toISOString(),reason,rounds,valid,target,
      keywords:unique([task.primaryKeyword,...(task.keywords||[])]),cities:task.cities||[],queue,history};
    await writeJsonAtomic(path.join(task.outputDir,'采集调度状态.json'),state);
    return state;
  };
  while((openEnded||valid<target)&&rounds<maxRounds){
    if(isCancelled())return {rounds,valid,reason:'paused',paused:true};
    lastQueue=await readQueue(task);
    for(const combo of lastQueue)if(combo.state==='channel_blocked')blockedPlatforms.add(combo.platform);
    lastQueue=lastQueue.map(combo=>blockedPlatforms.has(combo.platform)?{...combo,state:'channel_blocked'}:retired.has(searchCombinationKey(combo))&&combo.state==='pending'?{...combo,state:'no_valid_growth'}:combo);
    // Bound each environment payload and give large condition sets turns.
    const pending=lastQueue.filter(combo=>combo.state==='pending'&&!retired.has(searchCombinationKey(combo))).slice(0,48);
    if(!pending.length){
      // Preserve city scope and all platform request limits. Expansion adds a
      // related title only, and is durable before any corresponding request.
      const keyword=relatedCollectionKeywords(task).find(value=>!task.keywords?.includes(value)&&value!==task.primaryKeyword);
      if(keyword&&activateKeyword&&lastQueue.some(combo=>!['channel_blocked','total_limit'].includes(combo.state))){
        if(isCancelled())return {rounds,valid,reason:'paused',paused:true};
        await activateKeyword(keyword);
        if(isCancelled())return {rounds,valid,reason:'paused',paused:true};
        task.keywords=unique([task.primaryKeyword,...(task.keywords||[]),keyword]);
        history.push({type:'keyword_added',keyword,cities:task.cities||[],at:new Date().toISOString()});
        await persist('keyword_added');
        continue;
      }
      const reason=!lastQueue.length&&!task.platforms.some(key=>collectionChannelAvailable(key,task))?'no_direct_http_channels':collectionQueueStopReason(lastQueue);
      await persist(reason);return {rounds,valid,reason,targetReached:false};
    }
    rounds++;
    await persist('running');
    await onRound({round:rounds,valid,target,combinations:pending});
    if(isCancelled()){rounds--;await persist('paused');return {rounds,valid,reason:'paused',paused:true};}
    const before=valid;
    const result=await run({combinations:pending,platforms:unique(pending.map(combo=>combo.platform))});
    if(result?.paused){valid=await count();await persist('paused');return {rounds,valid,reason:'paused',paused:true};}
    if(isCancelled())return {rounds,valid:await count(),reason:'paused',paused:true};
    valid=await count();
    const after=await readQueue(task);
    const beforeProgress=new Map(pending.map(combo=>[searchCombinationKey(combo),combo.progress]));
    for(const combo of after){
      if(combo.state==='channel_blocked')blockedPlatforms.add(combo.platform);
      if(combo.state==='pending'&&beforeProgress.has(searchCombinationKey(combo))&&beforeProgress.get(searchCombinationKey(combo))===combo.progress)retired.add(searchCombinationKey(combo));
    }
    history.push({type:'round',round:rounds,before,valid,combinations:pending.map(({platform,keyword,city})=>({platform,keyword,city:city.name})),at:new Date().toISOString()});
    // A page may advance without adding a valid job (duplicates or incomplete
    // descriptions). Cursor progress must not be discarded by a batch counter.
  }
  const reached=!openEnded&&valid>=target,reason=reached?'target_reached':'round_budget_finished';
  if(!isCancelled())lastQueue=(await readQueue(task)).map(combo=>blockedPlatforms.has(combo.platform)?{...combo,state:'channel_blocked'}:retired.has(searchCombinationKey(combo))&&combo.state==='pending'?{...combo,state:'no_valid_growth'}:combo);
  await persist(reason);return {rounds,valid,reason,targetReached:reached};
}
