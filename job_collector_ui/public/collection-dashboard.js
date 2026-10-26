import {collectionProgress} from './collection-progress.js';
import {renderChannelHeartbeat} from './collection-heartbeat.js';

export function renderCollectionDashboard(task, {number, escapeHtml}) {
  const metrics = task.metrics;
  const info = collectionProgress(task);
  const details = metrics.liveCollection?.details || [];
  const platformNames = {shixiseng:'实习僧',iguopin:'国聘',mohrss:'公共招聘网',jobonline:'就业在线',job51:'前程无忧',zhaopin:'智联招聘',liepin:'猎聘',yupao:'鱼泡直聘',boss:'BOSS直聘'};
  const platformRows = task.platforms.map(key=>{
    const records = details.filter(row=>row.platform===key);
    const sum = field=>records.reduce((value,row)=>value+(Number(row[field])||0),0);
    const count = metrics.liveCollection?.platformCounts?.[key] ?? ({zhaopin:metrics.zhaopinRows,yupao:metrics.yupaoRows,boss:metrics.bossRows})[key];
    const diagnostic=metrics.channelDiagnostics?.[key];
    const heartbeat=metrics.channelHeartbeats?.[key];
    const verification=metrics.channelVerification?.[key];
    const canVerify=metrics.channelVerification!==undefined&&['job51','liepin'].includes(key)&&((heartbeat?heartbeat.requiresManual===true:diagnostic?.status==='manual')||verification&&verification.state!=='verified');
    const managedVerification=verification&&verification.mode!=='ordinary';
    const checking=verification?.state==='checking';
    const checked=['manual_checked','checking','recheck_failed'].includes(verification?.state);
    const verifyLabel='官网核对 · 普通 Edge';
    const disabled=checking?' disabled aria-disabled="true"':'';
    const sessionAction=verification?.state==='recheck_failed'&&['session_required','verification_required','auth_required','login_required'].includes(verification.failureCode)?`<button type="button" class="channel-verify-control" data-action="verify-session-${key}" title="打开采集器自己的会话，请在该窗口手动登录或验证；不会复制普通 Edge 的登录资料">打开采集会话</button>`:'';
    const status=canVerify?`<span class="channel-verification-actions" aria-busy="${checking}"><button type="button" class="channel-verify-trigger${checked?'':' has-errors'}" data-action="verify-open-${key}" title="打开普通 Edge；登录不自动同步到采集会话" aria-label="打开${escapeHtml(platformNames[key])}普通 Edge 官网窗口"${disabled}>${escapeHtml(verifyLabel)} <span aria-hidden="true">↗</span></button>${managedVerification||!checked?`<button type="button" class="channel-verify-control" data-action="verify-finish-${key}" title="${managedVerification?'核验官网真实成功搜索；不自动续采':'保存人工核对状态，不代表采集接口已恢复'}"${disabled}>${managedVerification?'完成验证':'已核对'}</button>`:''}${!managedVerification?`<button type="button" class="channel-verify-control" data-action="verify-recheck-${key}" title="检查采集器使用的会话，可能打开该会话窗口；不启动整项采集，遇验证即停"${disabled}>${checking?'复检中…':'复检采集会话'}</button>`:''}${managedVerification||verification?.state==='manual_check'?`<button type="button" class="channel-verify-control" data-action="verify-close-${key}" title="${managedVerification?'断开采集会话验证连接':'收起状态，不关闭普通浏览器'}"${disabled}>${managedVerification?'断开':'收起'}</button>`:''}</span>${verification?.state==='recheck_failed'?`<small class="channel-verification-reason">${escapeHtml(verification.reason||'请核对采集会话')}</small>`:''}`:diagnostic&&diagnostic.status!=='unknown'?`<span class="${['failed','manual'].includes(diagnostic.status)?'has-errors':''}"${diagnostic.reason?` title="${escapeHtml(diagnostic.reason)}"`:''}>${escapeHtml(diagnostic.label)}${diagnostic.reason?` · ${escapeHtml(diagnostic.reason)}`:''}</span>`:'';
    const detailSummary=records.length?`成功 <b>${number(sum('successful'))}</b> · <span class="${sum('failed')?'has-errors':''}">待续采 ${number(sum('failed'))}</span>`:'';
    const channelStatus=heartbeat&&!canVerify?'':status+sessionAction;
    const processing=channelStatus&&detailSummary?`${channelStatus}<br><small>${detailSummary}</small>`:channelStatus||detailSummary||(heartbeat?'—':escapeHtml(diagnostic?.label||'状态暂未提供'));
    return `<tr><td>${escapeHtml(platformNames[key]||key)}</td><td>${count==null?'—':`${number(count)} 条`}</td><td>${renderChannelHeartbeat(heartbeat,{escapeHtml})}</td><td>${processing}</td></tr>`;
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
      <div class="table-scroll"><table class="insight-table"><thead><tr><th>平台</th><th>候选岗位</th><th title="依据各平台实际入库及明确异常；确认运行中无入库 2 分钟提示暂未入库、10 分钟提示长时无入库，不等于连接断开">爬虫心跳</th><th>处理情况</th></tr></thead><tbody>${platformRows}</tbody></table></div>
    </details>
    <div class="collection-bottom-row">
      <div class="collection-channel-counts">${channels.map(([label,count])=>`<div><span>${label}</span><strong>${number(count||0)}</strong></div>`).join('')}</div>
      <div class="collection-delivery"><div><span>${native?'去重入库':'最终交付'}</span><strong>${native?`${number(metrics.knowledgeRows)} 条`:metrics.hasFinalResult?`${number(metrics.finalRows)} 条`:'待导出'}</strong></div><div><span>${native?'文件导出':'去除重复'}</span><strong>${native?'可选下载':metrics.hasFinalResult?`${number(metrics.duplicatesRemoved)} 条`:'—'}</strong></div></div>
    </div>
    ${metrics.unifiedDataset?.error?`<p role="alert">统一数据集更新异常：${escapeHtml(metrics.unifiedDataset.error)}</p>`:''}
  </section>`;
}
