import {collectionProgress} from './collection-progress.js?v=20261026-statistics';
import {renderChannelHeartbeat} from './collection-heartbeat.js';

export function renderCollectionDashboard(task, {number, escapeHtml}) {
  const metrics = task.metrics;
  const stats=metrics.jobStats?.scope==='jobs'?metrics.jobStats:null;
  const modern=Number.isFinite(metrics.knowledgeRows);
  const info = collectionProgress(task);
  const details = metrics.liveCollection?.details || [];
  const platformNames = {shixiseng:'实习僧',iguopin:'国聘',mohrss:'公共招聘网',jobonline:'就业在线',job51:'前程无忧',zhaopin:'智联招聘',liepin:'猎聘',nowcoder:'牛客岗位',yupao:'鱼泡直聘',boss:'BOSS直聘'};
  const platforms=[...new Set([...(task.platforms||[]),...(stats?.channels||[]).map(row=>row.key),...(!stats?Object.keys(metrics.liveCollection?.platformCounts||{}).filter(key=>metrics.liveCollection.platformCounts[key]>0):[])])];
  const platformRows = platforms.map(key=>{
    const records = details.filter(row=>row.platform===key);
    const sum = field=>records.reduce((value,row)=>value+(Number(row[field])||0),0);
    const bucket=stats?.channels.find(row=>row.key===key);
    const count = stats?(bucket?.rows||0):metrics.liveCollection?.platformCounts?.[key] ?? ({zhaopin:metrics.zhaopinRows,yupao:metrics.yupaoRows,boss:metrics.bossRows})[key];
    const diagnostic=metrics.channelDiagnostics?.[key];
    const heartbeat=metrics.channelHeartbeats?.[key];
    const verification=metrics.channelVerification?.[key];
    const manualPlatform=['job51','liepin','zhaopin'].includes(key);
    const canVerify=manualPlatform&&(metrics.channelVerification!==undefined||heartbeat?.requiresManual===true||diagnostic?.status==='manual');
    const managedVerification=verification&&verification.mode!=='ordinary';
    const checking=verification?.state==='checking';
    const checked=['manual_checked','checking','recheck_failed'].includes(verification?.state);
    const verifyLabel='打开登录/验证窗口';
    const disabled=checking?' disabled aria-disabled="true"':'';
    const sessionAction='';
    const zhaopinStatus=`<span class="channel-verification-actions" aria-busy="${checking}"><button type="button" class="channel-verify-trigger${checked?'':' has-errors'}" data-action="session-open-zhaopin" title="用智联专用 Chrome 配置打开；人工完成登录/验证后点“已处理”"${disabled}>打开处理窗口 <span aria-hidden="true">↗</span></button><button type="button" class="channel-verify-control" data-action="session-process-zhaopin" title="保存当前智联会话、清理本地冷却并标记已验证；不自动启动采集"${disabled}>已处理</button>${verification?`<button type="button" class="channel-verify-control" data-action="session-close-zhaopin" title="断开登录连接；窗口和登录资料保留"${disabled}>收起</button>`:''}${verification?.state==='verified'?`<button type="button" class="channel-verify-control" data-action="session-resume-zhaopin" title="只续采智联，保留其他渠道断点"${disabled}>继续采集</button>`:''}</span>${verification?.reason?`<small class="channel-verification-reason">${escapeHtml(verification.reason)}</small>`:''}`;
    const status=canVerify?(key==='zhaopin'?zhaopinStatus:`<span class="channel-verification-actions" aria-busy="${checking}"><button type="button" class="channel-verify-trigger${checked?'':' has-errors'}" data-action="verify-open-${key}" title="打开该渠道的采集会话浏览器；人工完成后点“已处理”" aria-label="打开${escapeHtml(platformNames[key])}处理窗口"${disabled}>打开处理窗口 <span aria-hidden="true">↗</span></button>${key==='job51'||key==='liepin'?`<button type="button" class="channel-verify-control" data-action="manual-open-${key}" title="用不带调试端口的普通 Chrome 打开；人工完成登录/验证后关闭窗口，再点复检采集会话"${disabled}>普通浏览器登录</button>`:''}<button type="button" class="channel-verify-control" data-action="session-process-${key}" title="核验官网真实搜索并标记已验证；不自动启动采集"${disabled}>已处理</button><button type="button" class="channel-verify-control" data-action="verify-recheck-${key}" title="重新检查该渠道的采集会话；不启动整项采集，遇验证即停"${disabled}>${checking?'复检中…':'复检采集会话'}</button>${verification?`<button type="button" class="channel-verify-control" data-action="verify-close-${key}" title="断开该渠道的采集会话验证连接"${disabled}>断开</button>`:''}${verification?.state==='verified'?`<button type="button" class="channel-verify-control" data-action="session-resume-${key}" title="只续采该渠道，保留其他渠道断点"${disabled}>继续采集</button>`:''}</span>${verification?.state==='recheck_failed'?`<small class="channel-verification-reason">${escapeHtml(verification.reason||'请核对采集会话')}</small>`:''}`):diagnostic&&diagnostic.status!=='unknown'?`<span class="${['failed','manual'].includes(diagnostic.status)?'has-errors':''}"${diagnostic.reason?` title="${escapeHtml(diagnostic.reason)}"`:''}>${escapeHtml(diagnostic.label)}${diagnostic.reason?` · ${escapeHtml(diagnostic.reason)}`:''}</span>`:'';
    const detailSummary=!modern&&records.length?`成功 <b>${number(sum('successful'))}</b> · <span class="${sum('failed')?'has-errors':''}">待续采 ${number(sum('failed'))}</span>`:'';
    const channelStatus=heartbeat&&!canVerify?'':status+sessionAction;
    const processing=channelStatus&&detailSummary?`${channelStatus}<br><small>${detailSummary}</small>`:channelStatus||detailSummary||(heartbeat?'—':escapeHtml(diagnostic?.label||'状态暂未提供'));
    return `<tr><td>${escapeHtml(platformNames[key]||key)}</td><td>${count==null?'—':`${number(count)} 条`}</td>${modern?`<td>${stats?number(bucket?.completeRows||0):'—'}</td>`:''}<td>${renderChannelHeartbeat(heartbeat,{escapeHtml})}</td><td>${processing}</td></tr>`;
  }).join('');
  if(modern){
    const total=stats?.rows??metrics.knowledgeRows;
    const complete=stats?.completeRows,missing=stats?.incompleteRows;
    const stamp=stats?.updatedAt&&Number.isFinite(Date.parse(stats.updatedAt))?new Date(stats.updatedAt).toLocaleTimeString('zh-CN'):null;
    const goal=!task.collectUntilExhausted&&task.targetRows>0?`<p class="job-goal">资料完整目标 ${number(task.targetRows)} 条${info.percent==null?'':` · ${info.percent}%`}</p>`:'';
    return `<section class="collection-dashboard job-statistics" aria-label="岗位数据统计" data-statistics-scope="jobs">
      <header class="job-statistics-head"><h3>岗位数据</h3><span>${stamp?`统计更新 ${escapeHtml(stamp)}`:'等待岗位数据同步'}</span></header>
      <dl class="job-statistics-strip">
        <div class="job-statistic-primary"><dt>已入库</dt><dd>${number(total)}<small>条</small></dd></div>
        <div><dt>资料完整</dt><dd>${complete==null?'—':number(complete)}<small>条</small></dd></div>
        <div><dt>待补全</dt><dd class="${missing?'is-incomplete':''}">${missing==null?'—':number(missing)}<small>条</small></dd></div>
      </dl>${goal}
      <p class="job-statistics-note">按平台岗位 ID 去重，不含面经；资料完整不等于岗位匹配。</p>
      ${metrics.jobStatsError?'<p class="job-statistics-error" role="alert">资料完整统计暂不可用，请刷新重试。</p>':''}
      <details class="collection-channel-details" id="collection-channels-${escapeHtml(task.id||'current')}"><summary>岗位渠道明细<span>${platforms.length} 个渠道</span></summary>
        <div class="table-scroll"><table class="insight-table job-channel-table"><thead><tr><th scope="col">平台</th><th scope="col">已入库</th><th scope="col">资料完整</th><th scope="col">采集状态</th><th scope="col">处理操作</th></tr></thead><tbody>${platformRows}</tbody>${stats?`<tfoot><tr><th scope="row">合计</th><td>${number(stats.rows)} 条</td><td>${number(stats.completeRows)}</td><td colspan="2"></td></tr></tfoot>`:''}</table></div>
      </details>
    </section>`;
  }
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
