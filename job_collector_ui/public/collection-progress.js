export function mergeLiveProgress(tasks, snapshot, now = Date.now()) {
  if (!snapshot || now - Date.parse(snapshot.updatedAt) > 15000 || !Number.isFinite(Date.parse(snapshot.updatedAt))) return tasks;
  return tasks.map(task => {
    const live = snapshot.tasks?.[task.id];
    if (task.metrics.liveCollection || live?.task_id !== task.id) return task;
    const publicRows = Math.max(task.metrics.publicRows || 0, live.publicRows || 0);
    return {...task, metrics:{...task.metrics, publicRows,
      candidates:publicRows+(task.metrics.zhaopinRows||0)+(task.metrics.yupaoRows||0)+(task.metrics.bossRows||0), liveCollection:live}};
  });
}

export function collectionProgress(task) {
  const stats=task.metrics.jobStats;
  if(stats?.scope==='jobs')return {label:task.collectUntilExhausted?'岗位已入库':'资料完整进度',count:task.collectUntilExhausted?stats.rows:stats.completeRows,
    percent:task.collectUntilExhausted?null:Math.min(100,Math.round(stats.completeRows/Math.max(1,task.targetRows)*100)),note:'资料完整仅表示字段达标，不代表岗位匹配'};
  if(task.collectUntilExhausted)return {label:'已入库岗位',count:task.metrics.validRows??task.metrics.knowledgeRows??task.metrics.candidates??0,percent:null,note:''};
  if(Number.isSafeInteger(task.metrics.validRows))return {label:'有效去重进度',count:task.metrics.validRows,percent:Math.min(100,Math.round(task.metrics.validRows/Math.max(1,task.targetRows)*100)),note:`已入库 ${task.metrics.knowledgeRows} 条候选；其中 ${task.metrics.validRows} 条满足完整字段要求，岗位相关性仍需筛选`};
  if(Number.isFinite(task.metrics.knowledgeRows))return {label:'知识库入库进度',count:task.metrics.knowledgeRows,percent:Math.min(100,Math.round(task.metrics.knowledgeRows/Math.max(1,task.targetRows)*100)),note:'按平台岗位ID去重入库；无需导出即可分析，岗位相关性仍需筛选'};
  const final = Boolean(task.metrics.hasFinalResult);
  const count = final ? task.metrics.finalRows : task.metrics.candidates;
  return {label:final?'交付完成度':'候选采集进度', count,
    percent:Math.min(100, Math.round(count/Math.max(1,task.targetRows)*100)),
    note:final?'': '候选含列表岗位；后台自动归集去重，详情仍可能补全中，不等于最终导出数量'};
}

export function collectionStatusLabel(task){
  if(task.status==='partial')return task.collectUntilExhausted?'本轮已结束':'未达目标';
  return {ready:'待启动',running:'运行中',stopping:'停止中',paused:'已暂停',completed:'本轮已完成',failed:'需处理'}[task.status]||task.status;
}
export function collectionTaskSummary(task){
  if(task.status==='running')return '岗位采集中，已入库数据可直接使用';
  if(task.status==='stopping')return '正在安全停止，保留已采数据与断点';
  if(task.status==='ready')return '任务已创建，等待启动';
  if(task.status==='paused')return '已暂停，可从断点继续';
  if(task.status==='failed')return task.message||'执行异常，请查看流程日志';
  if(task.status==='partial')return task.collectUntilExhausted?'本轮已结束；受阻渠道可处理后续采':'本轮已结束，尚未达到目标';
  return '本轮采集已完成，数据可用于岗位洞察';
}
