import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {HYBRID_MODE,channelAcquisition,browserFallbackPlatforms} from './channel_acquisition.mjs';
import {browserFallbackAllowed,assertBrowserAccess} from './browser_fallback_policy.mjs';
import {writeJsonAtomic} from './collector_storage.mjs';
import {assertTaskOutputOwnership} from './task_dataset_scope.mjs';
import {assertCollectorResources,nativeCrashMessage} from './collector_resources.mjs';
import {collectionExitCode} from './collection_policy.mjs';
import {withAccountLock} from './collection_concurrency.mjs';
import {readCollectionRound,filterCollectionCombinations} from './task_collection_config.mjs';
import {nativeTaskCounts} from './collector_native_sink.mjs';
import {withChannelHeartbeat} from './collector_channel_heartbeat.mjs';

const read=file=>fs.readFile(file,'utf8').then(JSON.parse).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
export async function runHybridCollection(settings,{runHttp,runBrowser,resourceGuard=assertCollectorResources}={}){
  const {taskId,outputDir,publicConfigPath,zhaopinConfigPath}=settings;
  await assertTaskOutputOwnership({id:taskId,outputDir});await resourceGuard();
  const config=await read(publicConfigPath);if(config?.task_id!==taskId)throw Error('混合采集配置任务归属不匹配');
  if(config.transportMode!==HYBRID_MODE)throw Error('任务未明确启用混合采集；不改变历史纯 HTTP 任务');
  const selected=settings.platforms||[],direct=selected.filter(key=>channelAcquisition[key]?.directHttpReady),stateDir=process.env.JOB_HTTP_RATE_DIR||path.resolve('ui_data/http_rate_limits');
  if(selected.some(key=>!channelAcquisition[key]||!channelAcquisition[key].directHttpReady&&!browserFallbackPlatforms.includes(key)))throw Error('包含未接入的采集渠道');
  const reportFile=path.join(outputDir,'混合采集状态.json');
  let httpCode=0;const results=[],fallbacks=[];
  const save=()=>writeJsonAtomic(reportFile,{task_id:taskId,mode:HYBRID_MODE,updatedAt:new Date().toISOString(),results,fallbacks});
  if(direct.length){
    const directConfig={...config,platforms:Object.fromEntries(Object.entries(config.platforms||{}).map(([key,value])=>[key,{...value,enabled:key!=='zhaopin'&&direct.includes(key)}]))};
    const file=path.join(path.dirname(publicConfigPath),'HTTP执行配置.json');await writeJsonAtomic(file,directConfig);
    const args={...settings,public:direct.some(k=>k!=='zhaopin'),zhaopin:direct.includes('zhaopin'),publicConfigPath:file};
    httpCode=await (runHttp||runHttpChild)(args);
    if([42,43].includes(httpCode)||nativeCrashMessage(httpCode)){results.push({platform:'http',code:httpCode,reason:'resource_or_output_pause'});await save();return httpCode;}
  }
  const manifest=await read(path.join(outputDir,'采集清单.json'))||{task_id:taskId,platforms:{}};
  if(manifest.task_id!==taskId)throw Error('混合采集清单归属不匹配');
  let logged=null;if(selected.includes('zhaopin')){logged=await read(zhaopinConfigPath);if(logged?.task_id!==taskId)throw Error('智联配置归属不匹配');}
  const zstatus=await read(path.join(outputDir,'智联招聘_采集状态.json'));
  if(zstatus&&zstatus.task_id!==taskId)throw Error('智联采集状态归属不匹配');
  for(const platform of selected){
    const httpReady=channelAcquisition[platform]?.directHttpReady===true;
    const errors=(platform==='zhaopin'?zstatus?.errors:manifest.platforms?.[platform]?.errors)||[];
    const previous=await read(path.join(outputDir,`RPA_${platform}_状态.json`));
    if(previous&&previous.task_id!==taskId)throw Error('RPA 状态归属不匹配');
    // Sticky platform failures are never silently retried by adaptive rounds.
    const priorErrors=previous?.errors?.filter(e=>e.stopChannel&&e.code!=='origin_cooldown')||[];
    if(priorErrors.length){results.push({platform,transport:'paused',code:44,reason:'previous_browser_failure',errors:priorErrors});continue;}
    if(!browserFallbackAllowed({mode:HYBRID_MODE,platform,httpReady,errors})){
      results.push({platform,transport:httpReady?'http':'paused',code:errors.length?44:0,reason:errors.length?'http_error_no_safe_fallback':'http_complete',errors});continue;
    }
    if(!browserFallbackPlatforms.includes(platform))continue;
    try{
      await assertBrowserAccess(platform,stateDir);await resourceGuard();
      const pc=platform==='zhaopin'?logged:config.platforms?.[platform];
      if(!pc||!Array.isArray(pc.cities)||!pc.cities.length)throw Object.assign(Error('缺少浏览器采集城市配置'),{code:'invalid_config'});
      const combinations=filterCollectionCombinations(readCollectionRound(taskId),platform,(config.keywords||[]).flatMap(keyword=>pc.cities.map(city=>({keyword,city}))));
      if(!combinations.length)continue;
      const browser=config.browser||{},maxPages=Number(browser.maxPages||3),maxRows=Number(browser.maxRows||200);
      console.log(`[混合采集] ${platform} 使用可见页面 RPA；最多${maxPages}页/${maxRows}条；不执行旧会话接口代码`);
      const execute=runBrowser|| (async options=>{
        // 前程无忧/就业在线：优先监听网站自身接口（签名/cookie 由本地会话生成，
        // 不重放静态签名）；失败再回退可见页面 DOM。
        if(['job51','jobonline'].includes(options.platform)){
          try{
            const {collect51Records}=await import('./job51/collector.mjs');
            const {normalize51Records}=await import('./job51/normalizer.mjs');
            const checkpointDir=path.join(options.outputDir,'断点数据','API');
            await fs.mkdir(checkpointDir,{recursive:true});
            const safe=s=>String(s).replace(/[\\/:*?"<>|]/g,'_');
            const collectedAt=new Date().toISOString();
            const htmlToText=value=>String(value??'').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<br\s*\/?\s*>/gi,'\n').replace(/<\/(p|li|tr|div|h\d)>/gi,'\n').replace(/<[^>]+>/g,' ').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&quot;/gi,'"').replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
            const rows=[],errors=[],seen=new Set();
            const {writeNativeChannelRows}=await import('./collector_native_sink.mjs');
            const {validJobRecord}=await import('./task_collection_target.mjs');
            const known=await (await import('./collector_native_sink.mjs')).readNativeTaskRows(options.outputDir,options.taskId,options.platform);
            for(const r of known)if(r.job_id)seen.add(String(r.job_id));
            for(const {keyword,city} of options.combinations){
              if(rows.length>=options.maxRows)break;
              const checkpointPath=path.join(checkpointDir,`job51_${safe(keyword)}_${safe(city.name)}.json`);
              try{
                const result=await collect51Records(keyword,city,{checkpointPath,request:options.request,maxPages:options.maxPages,maxRows:options.maxRows});
                const normalized=normalize51Records(result.records,keyword,city,result.total,{htmlToText,collectedAt});
                const fresh=normalized.filter(row=>!seen.has(String(row.job_id)));
                for(const row of fresh){seen.add(String(row.job_id));}
                if(fresh.length){await writeNativeChannelRows(options.outputDir,options.taskId,fresh);rows.push(...fresh);}
              }catch(error){errors.push({keyword,city,code:error.code||'collection_error',message:error.message,stopChannel:true});if(error.code!=='pagination_stalled')break;}
            }
            return {platform:options.platform,rows:seen.size,processed:rows.length,valid:rows.filter(validJobRecord).length,errors,transport:'browser_session_api'};
          }catch(error){
            // 浏览器/会话类错误不应回退 DOM（会再次启动浏览器冲突）；直接上抛。
            if(['DIRECT_HTTP_REQUIRED','access_blocked','verification_required','origin_cooldown','waiting_human','client_unavailable','OUTPUT_LOCKED'].includes(error.code)||/浏览器启动失败|launchPersistentContext/.test(error.message||''))throw error;
            console.log(`[混合采集] ${options.platform} 接口监听不可用，回退可见页面 DOM：${error.message}`);
          }
        }
        const {collectBrowserDom}=await import('./browser_dom_collection.mjs');return collectBrowserDom(options);
      });
      const result=await withAccountLock(path.join(stateDir,'browser-dom-global.lock'),taskId,()=>withChannelHeartbeat({outputDir,taskId,platform},()=>execute({platform,taskId,outputDir,combinations,maxPages,maxRows,taskTargetRows:Number(config.taskTargetRows||0),stateDir,request:{...config.request,minimumIntervalMs:Math.max(4000,Number(config.request?.minimumIntervalMs)||0)}})),{onWait:()=>{}});
      const status={task_id:taskId,...result,updatedAt:new Date().toISOString()};await writeJsonAtomic(path.join(outputDir,`RPA_${platform}_状态.json`),status);
      fallbacks.push(platform);results.push({platform,transport:'browser_dom',code:result.errors.length?44:0,...result});
      manifest.platforms[platform]={...manifest.platforms[platform],rows:result.rows,errors:result.errors,acquisition:{mode:'browser_dom'}};
      await writeJsonAtomic(path.join(outputDir,'采集清单.json'),manifest);await save();
      const fatal=result.errors.find(e=>[42,43].includes(collectionExitCode(e))||e.code==='TASK_OUTPUT_OWNERSHIP');if(fatal)return fatal.code==='TASK_OUTPUT_OWNERSHIP'?42:collectionExitCode(fatal);
    }catch(error){
      const status={task_id:taskId,platform,transport:'paused',code:collectionExitCode(error),reason:error.code||'collection_error',errors:[{code:error.code||'collection_error',stopChannel:true}],updatedAt:new Date().toISOString()};
      results.push(status);await writeJsonAtomic(path.join(outputDir,`RPA_${platform}_状态.json`),status);manifest.platforms[platform]={...manifest.platforms[platform],errors:status.errors};await writeJsonAtomic(path.join(outputDir,'采集清单.json'),manifest);await save();
      if([42,43].includes(status.code))return status.code;
    }
  }
  const counts=await nativeTaskCounts(outputDir,taskId);manifest.total_rows=counts.rows;await writeJsonAtomic(path.join(outputDir,'采集清单.json'),manifest);await save();
  await writeJsonAtomic(path.join(outputDir,'并发渠道状态.json'),{task_id:taskId,results,updatedAt:new Date().toISOString()});
  return results.some(r=>r.code)?44:httpCode&&results.every(r=>r.transport!=='browser_dom')?httpCode:0;
}
async function runHttpChild(settings){
  const child=spawn(process.execPath,[path.resolve(import.meta.dirname,'collect_parallel_channels.mjs'),JSON.stringify(settings)],{env:{...process.env,JOB_COLLECTION_MODE:'direct_http_validated_data'},windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.stdout.pipe(process.stdout,{end:false});child.stderr.pipe(process.stderr,{end:false});
  // The console owns the process tree and its normal pause action.
  return new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve(code??1));});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  process.env.JOB_COLLECTION_MODE=HYBRID_MODE;
  // Never import everyday browser profiles, proxy settings or historic cookies.
  process.env.JOB_BROWSER_SOURCE_CONFIG='none';
  const settings=JSON.parse(process.argv[2]);process.env.JOB_BROWSER_PROFILE_ROOT=path.resolve(settings.browserProfileRoot);
  try{process.exitCode=await runHybridCollection(settings);}catch(error){console.error(error.message);process.exitCode=collectionExitCode(error);}
}
