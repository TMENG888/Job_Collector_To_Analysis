import fs from 'node:fs/promises';
import {writeJsonAtomic} from './collector_storage.mjs';
import {channelAcquisition,collectionPolicyFor,collectionMode,HYBRID_MODE} from './channel_acquisition.mjs';
import {jobonlineCities} from './collection_cities.mjs';
import {taskInterviewSettings} from './nowcoder_interviews.mjs';

// Only transport and pacing change: quotas, cities and checkpoints are preserved.
export async function prepareStructuredCollection(task){
  const policy=collectionPolicyFor(task);
  const config=JSON.parse(await fs.readFile(task.publicConfigPath,'utf8'));
  if(config.task_id!==task.id)throw Error('接口执行配置任务 ID 不匹配');
  const before=JSON.stringify(config),request=config.request||{},changes=[];
  if(task.label||task.primaryKeyword||task.keywords?.length||config.keywords?.length||config.interviews?.roleKey){
    config.interviews=taskInterviewSettings({...task,keywords:task.keywords?.length?task.keywords:config.keywords,interviews:{...task.interviews,...config.interviews}});
    task.interviews=config.interviews;
  }
  // Repair the legacy all-cities Jobonline expansion at explicit launch only.
  // The task's confirmed city scope is authoritative; keep limits/checkpoints.
  if(config.platforms?.jobonline?.enabled&&Array.isArray(task.cities)&&task.cities.length){
    const selected=task.cities.map(name=>({name,code:jobonlineCities[name]}));
    if(selected.some(city=>!city.code))throw Error('就业在线任务城市未配置，拒绝静默改为全国或其他城市');
    config.platforms.jobonline.cities=selected;
  }
  config.request={...request,concurrency:1,platformConcurrency:2,minimumIntervalMs:Math.max(policy.minimumIntervalMs,Number(request.minimumIntervalMs)||0),attempts:Math.min(2,Math.max(1,Number(request.attempts)||2))};
  config.acquisitionMode=policy.mode;config.transportMode=collectionMode(task);config.collectionTransportPolicy=policy;
  config.taskTargetRows=task.collectUntilExhausted?0:task.targetRows;config.collectUntilExhausted=!!task.collectUntilExhausted;config.apiExecutionVersion=3;
  if(before!==JSON.stringify(config)){await writeJsonAtomic(task.publicConfigPath,config);changes.push(policy.mode===HYBRID_MODE?'接口优先；已适配渠道可回退可见页面 RPA；验证/拒绝访问不自动回退，浏览器串行':'HTTP 核验数据为主；猎聘仅走显式官网页面会话，共享限速、验证即停，不进行失败后浏览器回退');}
  return {changes,policy,channels:(task.platforms||[]).filter(key=>channelAcquisition[key]).map(key=>({key,...channelAcquisition[key],maxPages:config.platforms?.[key]?.maxPages??null,maxRows:config.platforms?.[key]?.maxRows??null}))};
}
