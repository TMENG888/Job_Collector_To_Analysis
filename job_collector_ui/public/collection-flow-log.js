// Display-only projection. Raw logs and collection counters remain unchanged.
const names = {shixiseng:'实习僧',iguopin:'国聘',mohrss:'公共招聘网',jobonline:'就业在线',job51:'前程无忧',zhaopin:'智联招聘',liepin:'猎聘',boss:'BOSS直聘',yupao:'鱼泡直聘'};
const progressPatterns = [
  /^(shixiseng) (list|details) (.+)[:：]\s*\d+\/\d+$/,
  /^(iguopin) (.+)[:：]\s*\d+\/\d+$/,
  /^(mohrss) (.+)[:：]\s*\d+\/\d+, page \d+\/\d+$/,
  /^(zhaopin)\(session\) (.+)[:：]\s*p\d+ \+\d+ 累计\d+\/[\d?]+$/,
  /^(jobonline|job51) (.+)[:：]\s*接口第\d+页，\d+条$/,
  /^(jobonline) (.+)[:：]\s*\d+条$/,
  /^(liepin) (.+)[:：]\s*第\d+页 \+\d+ 累计\d+$/,
  /^(zhaopin) (.+)[:：]\s*独立HTTP第\d+页，\d+条$/,
  /^(智联) (.+)[:：]\s*\d+\/[\d?]+，页 \d+$/,
  /^(鱼泡) (.+)[:：]\s*(列表|详情) \d+\/[\d?]+(?:，交互轮次 \d+)?$/,
  /^\[RPA页面\] (\w+) (.+)[:：]\s*第\d+页，累计\d+条；字段缺失不虚构$/,
];

function progressEvent(line) {
  for (let i = 0; i < progressPatterns.length; i++) {
    const match = line.match(progressPatterns[i]);
    if (!match) continue;
    const platform = names[match[1]] || ({智联:'智联招聘',鱼泡:'鱼泡直聘'})[match[1]] || match[1];
    const scope = i === 0 ? match[3] : match[2];
    const phase = (i === 0 && match[2] === 'details') || (i === 9 && match[3] === '详情') ? '读取详情' : '读取列表';
    return `${platform} · ${scope}：${phase}`;
  }
  // Older workers used global progress messages without a search scope.
  if (/^智联分页：已采集 \d+\/[\d?]+，最近页 \d+$/.test(line)) return '智联招聘：读取列表';
  if (/^智联合并进度：\d+\/[\d?]+（本组合 \d+ 条）$/.test(line)) return '智联招聘：合并渠道数据';
  if (/^鱼泡合并进度：\d+ 条唯一岗位$/.test(line)) return '鱼泡直聘：合并渠道数据';
  return null;
}

export function formatCollectionFlowLog(content) {
  const events = [], phases = new Set(), repeatedErrors = new Map();
  let jsonDepth=0,jsonString=false,jsonEscape=false,inJson=false,tailSummary=false;
  const consumeJson=text=>{
    for(const char of text){
      if(jsonEscape){jsonEscape=false;continue;}
      if(jsonString){if(char==='\\')jsonEscape=true;else if(char==='"')jsonString=false;continue;}
      if(char==='"')jsonString=true;
      else if(char==='{'||char==='[')jsonDepth++;
      else if(char==='}'||char===']')jsonDepth--;
    }
  };
  for (const raw of String(content || '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const timestamp = line.match(/^(\[\d{4}\/\d{1,2}\/\d{1,2} [\d:]+\])\s*/)?.[0] || '';
    const body = line.slice(timestamp.length);
    // Worker summaries are machine data, not execution events. Logs are read
    // as a bounded tail, so the first line may start inside a JSON string.
    const embeddedTail=/"(?:platforms|acquisition|continuation|scheduling|stopChannel|conditionScoped|resolved_at|raw_row_count)"\s*:/.test(body);
    const startsSummary=!inJson&&(body.startsWith('{')||embeddedTail);
    if(startsSummary){
      events.push(timestamp+'渠道执行摘要已保存，结果与异常请查看渠道明细');tailSummary=!body.startsWith('{');inJson=true;
    }
    if(inJson){
      if(!startsSummary&&(timestamp||/^\[(?:面经流程|来源冷却|错误|采集)/.test(body)||/^(?:\w+ failed |\w+ complete: |(?:Type|Syntax|Range)?Error:|▶|启动阶段|开始采集|断点续采)/.test(body)||progressEvent(body))){
        inJson=false;jsonDepth=0;jsonString=false;jsonEscape=false;tailSummary=false;
      }else{if(!tailSummary){consumeJson(body);if(jsonDepth<=0&&!jsonString)inJson=false;}continue;}
    }
    // A manual resume is a new execution, so show its phases again.
    if (/^(?:▶|启动阶段|开始采集|断点续采)/.test(body)) { phases.clear(); repeatedErrors.clear(); }
    const phase = progressEvent(body);
    if (phase) {
      if (!phases.has(phase)) { events.push(timestamp + phase); phases.add(phase); }
      continue;
    }
    // The output path is already displayed below the log.
    if (/^输出目录[：:]/.test(body)) continue;
    // End-of-round totals are historical snapshots, not current database
    // counts. Keep the execution outcome without presenting stale statistics.
    const ended = body.match(/^\[目标执行结束\]\s*([^；;]+)[；;]\s*有效去重\d+条[，,]\s*候选入库\d+条[。.]?$/);
    if (ended) { events.push(timestamp + `本轮执行结束：${ended[1]}；当前统计请查看岗位数据`); continue; }
    if (/^\[目标续轮\]/.test(body)) {
      events.push(timestamp + body.replace(/有效去重\d+条[；;]\s*/, ''));
      continue;
    }
    if (/^\[接口执行计划\]/.test(body)) { events.push(timestamp + '已加载各渠道取数方式与分页预算'); continue; }
    const complete = body.match(/^(shixiseng|iguopin|mohrss|jobonline|job51|zhaopin|liepin) complete: \d+$/);
    if (complete) { events.push(timestamp + names[complete[1]] + '：本轮渠道处理结束'); continue; }
    const failure = body.match(/^(?:\[错误\]\s*)?(shixiseng|iguopin|mohrss|jobonline|job51|zhaopin|liepin) failed (.+?)[:：]\s*(.+)$/);
    if (failure) {
      // A missing dependency can repeat for every city. Keep the first full
      // diagnostic and aggregate only the exact same platform + error reason.
      const key = `${failure[1]}\0${failure[3]}`;
      const prior = repeatedErrors.get(key);
      if (prior) {
        prior.count++; prior.scopes.add(failure[2]);
        events[prior.index] = `${prior.first}\n  ↳ 相同异常共 ${prior.count} 次，涉及 ${prior.scopes.size} 个检索条件（完整输出保留在原始日志）`;
      } else {
        repeatedErrors.set(key, {index:events.length,first:raw.trimEnd(),count:1,scopes:new Set([failure[2]])});
        events.push(raw.trimEnd());
      }
      continue;
    }
    // Unknown messages, warnings, verification stops and stack traces are kept.
    // Only exact known progress formats are collapsed; failures are never guessed away.
    events.push(raw.trimEnd());
  }
  const recent = events.slice(-120);
  if (events.length > recent.length) recent.unshift('…仅显示最近 120 条流程事件，完整输出保留在原始日志文件中');
  return recent.join('\n') || '暂无新的流程事件，采集进度请查看渠道明细。';
}
