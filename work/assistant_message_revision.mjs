const fields=['goal','task','discussion','queryScope','salaryFocus','interviewFocus','filters','roleQuestion','history','recent','compared','cacheKey','collectionFocused','collectionRecent','collectionClarification','matchingFocus'];
export const turnIdentity=(row,index)=>row.turn.turnId||`legacy:${index}:${row.at}`;
export const conversationSnapshot=state=>structuredClone(Object.fromEntries(fields.filter(key=>state[key]!==undefined).map(key=>[key,state[key]])));
export function reviseConversation(record,{editTurnId,expectedSessionUpdated},now=Date.now){
  if(!record||typeof editTurnId!=='string'||!Number.isFinite(expectedSessionUpdated)||expectedSessionUpdated!==record.updated)throw Error('会话已更新，请重新打开会话后再编辑；未发起模型请求');
  const index=record.turns.findIndex((row,i)=>turnIdentity(row,i)===editTurnId);
  if(index<0||['确认执行采集方案','取消采集方案'].includes(record.turns[index].message))throw Error('原提问不存在或为操作回执，请重新打开会话后再编辑');
  const kept=record.turns.slice(0,index),removed=record.turns.slice(index),previous=kept.at(-1);
  const context=previous?.context||{filters:previous?.turn.filters||{},goal:previous?.turn.goal,task:previous?.turn.task,history:kept.flatMap(row=>[{role:'user',text:row.message.slice(0,1500)},{role:'assistant',text:row.turn.answer.slice(0,1800)}]).slice(-12),recent:previous?.turn.result?.sources?.slice(0,8)||[],compared:[],cacheKey:record.state.cacheKey};
  const removedActions=new Set(removed.map(row=>row.turn.result?.action?.id).filter(Boolean));
  const actions=(record.state.actions||[]).map(plan=>plan.status==='pending'&&removedActions.has(plan.id)?{...plan,status:'cancelled',receipt:{message:'原提问已修改，未执行的旧方案已取消。'}}:plan);
  return {...record,turns:kept,state:{filters:{},history:[],recent:[],compared:[],...conversationSnapshot(context),actions},revisions:[...(record.revisions||[]),{at:now(),from:editTurnId,turns:removed}].slice(-20)};
}
