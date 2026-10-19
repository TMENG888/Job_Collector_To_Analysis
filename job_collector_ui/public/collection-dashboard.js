import {collectionProgress} from './collection-progress.js';

export function renderCollectionDashboard(task, {number, escapeHtml}) {
  const metrics = task.metrics;
  const info = collectionProgress(task);
  const details = metrics.liveCollection?.details || [];
  const platformNames = {shixiseng:'实习僧',iguopin:'国聘',mohrss:'公共招聘网',jobonline:'就业在线',job51:'前程无忧',zhaopin:'智联招聘',liepin:'猎聘',yupao:'鱼泡直聘',boss:'BOSS直聘'};
  const platformRows = task.platforms.map(key=>{
    const records = details.filter(row=>row.platform===key);
    const sum = field=>records.reduce((value,row)=>value+(Number(row[field])||0),0);
    const total = sum('discovered'), processed = sum('processed');
    const count = metrics.liveCollection?.platformCounts?.[key] ?? ({zhaopin:metrics.zhaopinRows,yupao:metrics.yupaoRows,boss:metrics.bossRows})[key];
    return `<tr><td>${escapeHtml(platformNames[key]||key)}</td><td>${count==null?'—':`${number(count)} 条`}</td><td>${records.length?`${number(processed)} / ${number(total)} 次${total?` · ${Math.min(100,Math.round(processed/total*100))}%`:''}`:'暂未提供'}</td><td>${records.length?`成功 <b>${number(sum('successful'))}</b> · <span class="${sum('failed')?'has-errors':''}">待续采 ${number(sum('failed'))}</span>`:'以实时日志为准'}</td></tr>`;
  }).join('');
  const native=Number.isFinite(metrics.knowledgeRows);
  const stages = native?[['collection','多平台采集']]:[['collection','多平台采集'], ['delivery','导出交付']];
  const collectionStages = ['collection','public','zhaopin','yupao','boss'];
  const index = collectionStages.includes(task.currentStage) ? 0 : ['finalize','workbook'].includes(task.currentStage) ? 1 : -1;
  const running = ['running','stopping'].includes(task.status);
  const steps = stages.map(([key,label],i)=>{
    const completed = task.status==='completed' && (native?metrics.knowledgeRows>0:metrics.hasFinalResult) && !task.currentStage;
    const partial=task.status==='partial'&&!task.currentStage;
    const state = completed?'done':partial?'attention':i===index?(running?'active':'attention'):i<index?'done':'pending';
    const issue = task.collectionIssues?.some(issue=>key==='collection' ? collectionStages.includes(issue.stage) : ['finalize','workbook'].includes(issue.stage));
    return `<li class="collection-step ${state}"><span>${state==='done'?'✓':i+1}</span><div>${label}<small>${partial?(task.collectUntilExhausted?'本轮结束 · 受阻或预算暂停':'本轮已结束 · 目标未达到'):issue?'部分受阻':state==='done'?(completed?(task.collectUntilExhausted?'本轮条件已处理':'已完成'):'已处理'):state==='active'?'正在处理':state==='attention'?'已停止':'待处理'}</small></div></li>`;
  }).join('');
  const channels = [['公开渠道',metrics.publicRows], ...(task.platforms.includes('zhaopin')?[['智联招聘',metrics.zhaopinRows]]:[]),
    ...(task.platforms.includes('yupao')?[['鱼泡直聘',metrics.yupaoRows]]:[]), ...(task.platforms.includes('boss')?[['BOSS直聘',metrics.bossRows]]:[])];
  return `<section class="collection-dashboard" aria-label="采集进度仪表盘">
    <ol class="collection-steps">${steps}</ol>
    <div class="collection-overview">
      <article class="collection-main-card">
        <div class="collection-card-heading"><span>${info.label}</span><span class="collection-live ${running?'is-live':''}">${running?'实时更新':'已保存'}</span></div>
        <div class="collection-count"><strong>${number(info.count)}</strong><span>${task.collectUntilExhausted?'条':`/ ${number(task.targetRows)} 条`}</span>${info.percent==null?'':`<b>${info.percent}%</b>`}</div>
        ${info.percent==null?'':`<div class="collection-track" role="progressbar" aria-label="${info.label}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${info.percent}"><i style="width:${info.percent}%"></i></div>`}
      </article>
    </div>
    <details class="collection-channel-details" id="collection-channels-${escapeHtml(task.id||'current')}"><summary>渠道明细</summary>
      <div class="table-scroll"><table class="insight-table"><thead><tr><th>平台</th><th>候选岗位</th><th>详情处理次数</th><th>处理情况</th></tr></thead><tbody>${platformRows}</tbody></table></div>
    </details>
    <div class="collection-bottom-row">
      <div class="collection-channel-counts">${channels.map(([label,count])=>`<div><span>${label}</span><strong>${number(count||0)}</strong></div>`).join('')}</div>
      <div class="collection-delivery"><div><span>${native?'去重入库':'最终交付'}</span><strong>${native?`${number(metrics.knowledgeRows)} 条`:metrics.hasFinalResult?`${number(metrics.finalRows)} 条`:'待导出'}</strong></div><div><span>${native?'文件导出':'去除重复'}</span><strong>${native?'可选下载':metrics.hasFinalResult?`${number(metrics.duplicatesRemoved)} 条`:'—'}</strong></div></div>
    </div>
    ${metrics.unifiedDataset?.error?`<p role="alert">统一数据集更新异常：${escapeHtml(metrics.unifiedDataset.error)}</p>`:''}
  </section>`;
}
