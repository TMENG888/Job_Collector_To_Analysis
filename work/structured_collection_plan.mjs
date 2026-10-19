import fs from 'node:fs/promises';
import {writeJsonAtomic} from './collector_storage.mjs';
import {channelAcquisition,collectionPolicyFor,collectionMode,HYBRID_MODE} from './channel_acquisition.mjs';

// Only transport and pacing change: quotas, cities and checkpoints are preserved.
export async function prepareStructuredCollection(task){
  const policy=collectionPolicyFor(task);
  const config=JSON.parse(await fs.readFile(task.publicConfigPath,'utf8'));
  if(config.task_id!==task.id)throw Error('接口执行配置任务 ID 不匹配');
  const before=JSON.stringify(config),request=config.request||{},changes=[];
  config.request={...request,concurrency:1,platformConcurrency:2,minimumIntervalMs:Math.max(policy.minimumIntervalMs,Number(request.minimumIntervalMs)||0),attempts:Math.min(2,Math.max(1,Number(request.attempts)||2))};
  config.acquisitionMode=policy.mode;config.transportMode=collectionMode(task);config.collectionTransportPolicy=policy;
  config.taskTargetRows=task.collectUntilExhausted?0:task.targetRows;config.collectUntilExhausted=!!task.collectUntilExhausted;config.apiExecutionVersion=3;
  if(before!==JSON.stringify(config)){await writeJsonAtomic(task.publicConfigPath,config);changes.push(policy.mode===HYBRID_MODE?'接口优先；已适配渠道可回退可见页面 RPA；验证/拒绝访问不自动回退，浏览器串行':'无浏览器 HTTP 取数：验证 JSON 或已核验内嵌数据、共享限速与最多2次请求尝试');}
  return {changes,policy,channels:(task.platforms||[]).filter(key=>channelAcquisition[key]).map(key=>({key,...channelAcquisition[key],maxPages:config.platforms?.[key]?.maxPages??null,maxRows:config.platforms?.[key]?.maxRows??null}))};
}
