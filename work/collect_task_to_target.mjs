// One-shot coordinator for a specific authorized task, not a recurring monitor.
import fs from 'node:fs/promises';
import path from 'node:path';
import {otherChannelValidCount} from './task_collection_target.mjs';
import {writeJsonAtomic} from './collector_storage.mjs';
import {isCollectionStage,shouldStopAtTarget} from './coordinator_policy.mjs';
import {collectionChannelAvailable} from './channel_availability.mjs';
const taskId=process.argv[2];
if(!taskId)throw Error('必须指定 task_id');
const origin='http://127.0.0.1:8788',route='/api/tasks/'+encodeURIComponent(taskId);
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function api(url,body) {
  const response=await fetch(origin+url,{...(body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
  const data=await response.json();if(!response.ok)throw Error(data.error||'API HTTP '+response.status);return data;
}
let task=(await api(route)).task;
const target=Number(task.targetRows),output=task.outputDir;
if(target!==20000)throw Error('该协调程序只接受已授权的 20000 条任务');
const journalFile=path.join(output,'目标采集协调状态.json');
let journal={task_id:taskId,target,status:'running',attempted:[],started_at:new Date().toISOString()};
async function save(patch={}) {Object.assign(journal,patch,{updated_at:new Date().toISOString()});await writeJsonAtomic(journalFile,journal);}
const count=()=>otherChannelValidCount(output,'',taskId);
let lastProgress=-1;
async function observe(stage) {
  let untrackedSince=0;
  const collectionStage=isCollectionStage(stage);
  for(;;) {
    const state=await api('/api/state');task=state.tasks.find(item=>item.id===taskId);if(!task)throw Error('当前任务消失');
    const valid=await count();
    if(valid!==lastProgress){console.log(JSON.stringify({at:new Date().toISOString(),stage:task.currentStage,valid,target,status:task.status}));lastProgress=valid;await save({valid_rows:valid,current_stage:task.currentStage});}
    if(task.browserSession?.verification_status==='waiting_human')throw Error('当前 '+stage+' 搜索页需要人工登录/验证，保留当前实例和断点；协调程序不处理验证');
    if(['running','stopping'].includes(task.status)) {
      // A saved status without a live service handle must not trigger a restart.
      if(state.activeCount===0&&task.runningSeconds===0){untrackedSince ||= Date.now();if(Date.now()-untrackedSince>30000)throw Error('任务显示运行，但服务没有活动进程句柄；请检查，不自动重启');}else untrackedSince=0;
      if(shouldStopAtTarget({stage,status:task.status,valid,target})){
        console.log('已达到有效总量，停止当前采集阶段并保留落盘数据');
        await api(route+'/pause',{});await save({target_stop_requested:true});
      }
      await wait(5000);continue;
    }
    if(task.status==='paused'&&!(collectionStage&&valid>=target&&journal.target_stop_requested))throw Error(task.message||'任务暂停，需要人工检查');
    if(task.status==='failed'&&(!collectionStage||!/代码 44$/.test(task.message||'')))throw Error(task.message||'未知采集失败，不自动重试');
    if(valid>=target)return;
    if(task.status==='failed')console.log('该渠道部分受阻，保留数据；不重试，继续其他选定渠道');
    return;
  }
}
async function run(stage) {
  await save({current_stage:stage});console.log('启动阶段 '+stage);
  const before=(await api(route)).task.updatedAt;
  await api(route+'/run',{stage});
  // Allow the service's asynchronous resource check to establish its handle.
  let established=false;
  for(let attempt=0;attempt<30;attempt++) {
    await wait(1000);
    const fresh=(await api(route)).task;
    if(fresh.updatedAt!==before&&fresh.currentStage===stage){established=true;break;}
  }
  if(!established)throw Error('阶段启动后没有确认新的任务状态，不重复提交启动请求');
  await observe(stage);
}
try {
  await save();
  const stages=['zhaopin','public','boss','yupao'].filter(collectionChannelAvailable).filter(stage=>stage==='public'?task.platforms.some(key=>['shixiseng','iguopin','mohrss','job51','jobonline','liepin'].includes(key)):task.platforms.includes(stage));
  if(['running','stopping'].includes(task.status)) {
    journal.attempted.push(task.currentStage);await save();await observe(task.currentStage);
  }
  for(const stage of stages) {
    if(await count()>=target)break;
    if(journal.attempted.includes(stage))continue;
    journal.attempted.push(stage);await save();await run(stage);
  }
  const valid=await count();
  if(valid<target){await save({status:'needs_more_sources',valid_rows:valid,remaining:target-valid});console.log('本轮选定范围不足：'+valid+'/'+target+'；目标未完成，不宣称成功');process.exitCode=3;}
  else {
    await save({status:'exporting',valid_rows:valid});
    await run('finalize');await run('workbook');
    const quality=JSON.parse(await fs.readFile(path.join(output,'数据质量报告.json'),'utf8'));
    const delivery=JSON.parse(await fs.readFile(path.join(output,'最终交付清单.json'),'utf8'));
    if(quality.task_id!==taskId||delivery.task_id!==taskId||quality.output_rows!==target||quality.target_reached!==true||delivery.rows!==target||!delivery.target_reached||!quality.strict_valid_rows)throw Error('交付与有效总量门槛不一致，不能标记完成');
    const workbook=path.resolve(output,delivery.workbook);
    if(path.dirname(workbook)!==path.resolve(output)||(await fs.stat(workbook)).size===0)throw Error('交付 Excel 无效');
    await save({status:'delivery_ready_for_audit',output_rows:quality.output_rows,workbook});console.log(JSON.stringify({delivery_ready_for_audit:true,rows:quality.output_rows,workbook}));
  }
}catch(error){await save({status:'needs_attention',reason:error.message}).catch(()=>{});console.error(error.message);process.exitCode=2;}
