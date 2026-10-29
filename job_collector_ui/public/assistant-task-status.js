export function assistantTaskStatus(turn){
  const task=turn?.task;
  if(task?.intent==='career_consultation'){
    return {complete:'本轮回答完成',partial:'部分问题已回答，证据不足项已说明',unavailable:'本轮未取得足够回答依据'}[task.completion]||'本轮回答待完成';
  }
  return {waiting_for_user:'等待补充，已保留条件',waiting_for_confirmation:'方案待确认，尚未执行',failed:'本轮操作未成功',completed:'本轮工具执行完成',planning:'待继续'}[task?.status]||task?.status||'';
}
export function assistantExecutionLabel(turn){
  if(turn?.task?.intent==='career_consultation'){
    const method=turn.execution==='model'?'文本模型':turn.execution==='local-fallback'?'模型降级':'本地模式';
    return `${method} · ${turn.trace?.length?'只读证据查询':'通用咨询'}`;
  }
  return turn.execution==='model'?'文本模型 · 系统工具Agent':turn.execution==='local-fallback'?'本地工具结果 · 模型降级':'本地多轮规则模式';
}
