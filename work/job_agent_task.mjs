import {createHash} from 'node:crypto';
// Persist only structured intent/progress; never hidden reasoning or resume text.
export function taskProgress(previous,goal,filters,{salary=false,trace=[],questions=[]}={}){
  const scope=createHash('sha256').update(JSON.stringify({goal,filters})).digest('hex').slice(0,16);
  return {version:1,intent:salary?'salary_advice':'job_exploration',scope,
    status:questions.length?'waiting_for_user':trace.some(t=>t.status==='failed'&&!t.resolved)?'failed':trace.some(t=>t.status==='ready')?'completed':trace.length?'waiting_for_user':'planning',
    pending_questions:questions,scope_changed:!!previous&&previous.scope!==scope,
    plan:salary?['确认求职目标','检索资格候选','分城市与方向对标薪资','补查JD并回答']:['确认查询范围','调用只读工具','核对证据并回答'],
    completed_tools:trace.filter(t=>t.status==='ready').map(t=>t.tool),failed_tools:trace.filter(t=>t.status==='failed').map(t=>({tool:t.tool,code:t.failure_code,resolved:!!t.resolved})),limits:{tool_calls:10,model_rounds:6},
    notice:'展示任务步骤和工具结果，不记录或公开模型内部思考；不开放任意SQL。'};
}
export function toolError(code,message,details={},phase='validation'){
  return Object.assign(new Error(message),{code,details,phase});
}
export function publicToolFailure(error){
  const trusted=String(error.code||'').startsWith('TOOL_');
  return {status:'failed',failure_code:trusted?error.code:'TOOL_EXECUTION_FAILED',phase:trusted?error.phase:'execution',
    message:trusted?error.message:'工具执行异常，未取得有效查询结果；请查看本机服务诊断。',
    ...(trusted?{details:error.details}:{}),recovery:{retry_allowed:trusted&&error.code!=='TOOL_RETRY_BLOCKED',action:error.code==='TOOL_MODE_MISMATCH'?'use_available_tools':trusted?'use_effective_scope':'report_failure'}};
}
export function scopedFilters(base,args,index){
  if(!args||typeof args!=='object'||Array.isArray(args))throw new Error('工具参数必须是对象');
  const next={...base};
  for(const field of ['cities','roles'])if(args[field]!=null){
    const values=args[field];
    if(!Array.isArray(values)||!values.length||values.length>4||values.some(v=>typeof v!=='string'||v.length>80))throw toolError('TOOL_INVALID_SCOPE','城市/方向必须是1–4项的结构化列表',{field});
    const confirmed=field==='cities'?(base.cities?.length?base.cities:base.city?[base.city]:[]):base.roles||[];
    const available=field==='cities'?[...new Set(index.jobs.map(j=>j.city))]:index.report.roles||[index.report.role];
    if(values.some(v=>!available.includes(v)))throw toolError('TOOL_UNKNOWN_SCOPE','请求的城市/方向不在当前知识库中，请使用可用范围，不借用其他岗位数据。',{field,confirmed,available});
    if(values.some(v=>confirmed.length&&!confirmed.includes(v)))throw toolError('TOOL_SCOPE_MISMATCH','请求超出本轮已确认范围；请按本轮有效条件查询，不沿用历史方向。',{field,confirmed,available});
    next[field]=[...new Set(values)];if(field==='cities'){if(values.length===1)next.city=values[0];else delete next.city;}
  }
  return next;
}
