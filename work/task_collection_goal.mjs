import fs from 'node:fs/promises';
import path from 'node:path';
import {collectionGoal,goalText,untilExhausted} from './collection_goal.mjs';
import {assertTaskOutputOwnership} from './task_dataset_scope.mjs';
import {writeJsonAtomic} from './collector_storage.mjs';
import {otherChannelValidCount} from './task_collection_target.mjs';

async function goalDocuments(task,goal){
  await assertTaskOutputOwnership(task);
  const paths=new Map([
    [task.publicConfigPath,'channel'],[task.zhaopinConfigPath,'channel'],
    [task.profilePath,'profile'],[path.join(task.outputDir,'岗位配置.json'),'profile'],
  ].filter(([file])=>file));
  const documents=[];
  for(const [file,kind]of paths){
    const before=JSON.parse(await fs.readFile(file,'utf8'));
    if(before.task_id!==task.id)throw Error('采集目标配置任务归属不一致');
    const patch=kind==='profile'
      ?{target_rows:goal.targetRows,collect_until_exhausted:goal.collectUntilExhausted}
      :{taskTargetRows:goal.targetRows||0,collectUntilExhausted:goal.collectUntilExhausted};
    const after={...before,...patch};
    if(JSON.stringify(before)!==JSON.stringify(after))documents.push({file,before,after});
  }
  return documents;
}

// The task record is authoritative. Reconcile before every launch so a service
// exit halfway through a multi-file goal change cannot launch mixed targets.
// Only goal fields change: no query scope, safety limit, session or cursor does.
export async function synchronizeCollectionGoal(task){
  const goal=collectionGoal({...task,collectUntilExhausted:untilExhausted(task)});
  const documents=await goalDocuments(task,goal);
  for(const {file,after}of documents)await writeJsonAtomic(file,after);
  return documents.length;
}

export async function updateTaskCollectionGoal(task,body,{
  persistTask,countValid=()=>otherChannelValidCount(task.outputDir,'',task.id),
  write=writeJsonAtomic,now=()=>new Date().toISOString(),
}={}){
  if(['running','stopping'].includes(task.status))throw Error('请先暂停任务再修改采集目标');
  const allowed=['targetRows','candidateTarget','collectUntilExhausted','collectionGoal'];
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!allowed.includes(key))||
    !['targetRows','collectUntilExhausted','collectionGoal'].some(key=>Object.hasOwn(body,key)))throw Error('采集目标参数无效');
  if(Object.hasOwn(body,'collectUntilExhausted')&&typeof body.collectUntilExhausted!=='boolean')throw Error('采集模式须为布尔值');
  for(const key of ['targetRows','candidateTarget'])if(body[key]!=null&&body[key]!==''&&
    !['number','string'].includes(typeof body[key]))throw Error('采集数量须为整数');
  if(body.collectionGoal!=null&&!['row_target','available_scope'].includes(body.collectionGoal))throw Error('采集目标模式无效');
  const open=body.collectUntilExhausted===true||body.collectionGoal==='available_scope';
  if(body.collectUntilExhausted===true&&body.collectionGoal==='row_target'||body.collectUntilExhausted===false&&body.collectionGoal==='available_scope')throw Error('采集目标模式冲突');
  if(open&&body.targetRows!=null&&body.targetRows!=='')throw Error('目标条数与无目标模式不能同时指定');
  if(!open&&(body.targetRows==null||body.targetRows===''))throw Error('请明确指定目标条数，或选择无目标模式');
  const goal=collectionGoal(body);
  const documents=await goalDocuments(task,goal);
  const valid=await countValid();
  if(!Number.isSafeInteger(valid)||valid<0)throw Error('当前有效岗位计数无效，目标未修改');
  const reached=!goal.collectUntilExhausted&&valid>=goal.targetRows;
  const next={...task,...goal,validRows:valid,updatedAt:now(),
    goalRevision:{version:1,at:now(),previousTargetRows:task.targetRows??null},
    status:reached?'completed':task.status==='completed'?'partial':task.status,
    message:`采集目标已更新：${goalText(goal)}；当前有效去重 ${valid} 条${goal.collectUntilExhausted?'，无数量目标':reached?'，数量目标已达到':'，尚未达标'}；数据与断点保留，未自动启动；受阻渠道仍需人工核验`,
  };
  if(typeof persistTask!=='function')throw Error('缺少目标持久化操作');
  const attempted=[];
  try{
    for(const doc of documents){attempted.push(doc);await write(doc.file,doc.after);}
    await persistTask(next);
  }catch(cause){
    const failures=[];
    for(const doc of attempted.reverse())try{await writeJsonAtomic(doc.file,doc.before);}catch(error){failures.push(error.message);}
    throw new Error(`采集目标更新失败，未提交新任务目标；${failures.length?'配置回滚未完成，下次启动会按原任务目标校正':'原配置已恢复'}：${cause.message}`);
  }
  return next;
}
