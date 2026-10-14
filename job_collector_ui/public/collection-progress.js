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
  if(Number.isFinite(task.metrics.knowledgeRows))return {label:'知识库入库进度',count:task.metrics.knowledgeRows,percent:Math.min(100,Math.round(task.metrics.knowledgeRows/Math.max(1,task.targetRows)*100)),note:'按平台岗位ID去重入库；无需导出即可分析，岗位相关性仍需筛选'};
  const final = Boolean(task.metrics.hasFinalResult);
  const count = final ? task.metrics.finalRows : task.metrics.candidates;
  return {label:final?'交付完成度':'候选采集进度', count,
    percent:Math.min(100, Math.round(count/Math.max(1,task.targetRows)*100)),
    note:final?'': '候选含列表岗位；后台自动归集去重，详情仍可能补全中，不等于最终导出数量'};
}
