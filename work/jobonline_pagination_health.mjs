import {createHash} from 'node:crypto';
// Persist a bounded window across worker/recovery boundaries. Advancing page
// numbers and HTTP 200 alone cannot prove that a source has been exhausted.
export class JobonlinePaginationHealth {
  constructor(saved={},knownIds=[]){this.seen=new Set(knownIds.map(String));this.window=(saved.window||[]).slice(-5);}
  observe(page,ids){
    const values=[...new Set(ids.filter(x=>x!=null&&String(x)).map(String))];let added=0;
    for(const id of values){if(!this.seen.has(id))added++;this.seen.add(id);}
    const digest=createHash('sha256').update(JSON.stringify(values)).digest('hex');
    this.window=this.window.filter(row=>row.page!==page);this.window.push({page,count:values.length,added,digest});this.window=this.window.slice(-5);
    return {version:1,window:this.window,stalled:this.window.length===5&&this.window.reduce((sum,row)=>sum+row.count,0)>=60&&this.window.every(row=>row.added===0)};
  }
}
export function unverifiedLegacyCompletion(saved){return saved.completed===true&&!saved.completion_reason&&Number(saved.total)>=10000&&(saved.records?.length||0)<Number(saved.total);}
export const collectionStopMessages={
  no_direct_http_channels:'任务所选渠道尚无已验证直连接口；已禁用浏览器，保留数据与断点',
  pagination_stalled:'就业在线连续分页重复，已停止自动请求；不能据此认定源已采完',
  legacy_pagination_unverified:'就业在线旧断点的采完标记缺少分页完整性证据，已停止自动重试',
  reported_window_end:'已扫到接口报告的分页窗口边界，尚不能确认全部独立岗位均已获取',
  source_finished:'当前查询已结束，已返回的数据不足目标',
  page_limit:'已达到配置的分页上限',total_limit:'已达到累计候选预算',
  no_valid_growth:'本轮未新增有效岗位，已停止自动补采',
  channel_blocked:'渠道请求受阻，已停止自动补采；请查看渠道日志',
  low_yield_deferred:'连续低收益，已保留断点并停止自动补采',
  search_queue_exhausted:'已配置及相关关键词的可执行条件已处理；停滞和受阻条件保留，不代表平台岗位已全部采完',
  channels_blocked:'当前渠道均需人工处理，已保留数据和断点；不自动重试登录、验证码或访问限制',
  round_budget_finished:'已达到自动补采轮次预算；尚未处理的条件和断点保留，可查看调度状态',
};
export const collectionStopMessage=reason=>collectionStopMessages[reason]||'';
