// Source identity selects the analysis target; never accepts a mismatched hint.
export function resolveInsightSourceRole({inputFile,sourceTaskId,role},tasks,catalog=[]){
 const input=String(inputFile||'').trim();
 const url=input.startsWith('kb://')?new URL(input):null;
 const uriTask=url?.hostname==='task'?decodeURIComponent(url.pathname.slice(1)):'';
 if(sourceTaskId&&uriTask&&String(sourceTaskId)!==uriTask)throw new Error('分析数据源与来源任务不一致');
 const taskId=String(sourceTaskId||uriTask||'');
 if(taskId){const task=tasks.find(t=>t.id===taskId&&!t.archived);if(!task)throw new Error('来源采集任务不存在');return {role:task.primaryKeyword||task.label,taskId,mode:'source_task'};}
 const found=catalog.find(d=>String(d.path).toLowerCase()===input.toLowerCase());
 if(found?.role&&!/^(自动识别|auto)$/i.test(found.role))return {role:found.role,mode:'source_catalog'};
 // Keep trusted programmatic callers compatible. The browser sends no role.
 return {role:String(role||'自动识别').trim()||'自动识别',mode:role?'api_hint':'automatic'};
}
