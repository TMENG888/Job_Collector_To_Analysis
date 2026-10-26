const states=new Set(['healthy','delayed','lost','blocked','paused','completed','waiting','pending','unknown']);
export function renderChannelHeartbeat(heartbeat,{escapeHtml}){
  const sample=heartbeat||{state:'unknown',label:'待监测',reason:'后台尚未提供按平台的实际入库心跳；请加载新版后台，不使用页面刷新时间代替入库时间'};
  const state=states.has(sample.state)?sample.state:'unknown';
  const threshold=sample.staleAfterMs&&sample.lostAfterMs?`仅确认渠道运行中时，${Math.round(sample.staleAfterMs/60000)} 分钟无入库提示暂未入库，${Math.round(sample.lostAfterMs/60000)} 分钟提示长时无入库；不据此判断连接断开。`:'';
  const title=[sample.reason,threshold,sample.lastIngestedAt?`最近入库：${sample.lastIngestedAt}`:''].filter(Boolean).join(' ');
  return `<span class="channel-heartbeat is-${state}" title="${escapeHtml(title)}"><span class="channel-heartbeat-label"><i aria-hidden="true"></i>${escapeHtml(sample.label||'待监测')}</span>${sample.detail?`<small>${escapeHtml(sample.detail)}</small>`:''}</span>`;
}
