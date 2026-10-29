import path from 'node:path';
import {hasVerifiedSessionCompletion,sessionAuditStartPage} from './session_pagination_health.mjs';
const safe=value=>String(value).replace(/[\\/:*?"<>|]/g,'_');
// One contract shared by the worker and its scheduler. Never adopt a cursor
// belonging to another task, query, or transport merely because its name fits.
export const zhaopinSessionCheckpointPath=(outputDir,keyword,city)=>path.join(outputDir,'断点数据',`zhaopin_session_${safe(keyword)}_${safe(city.name)}.json`);
export function validateZhaopinSessionCheckpoint(saved,{taskId,keyword,city}){
  if(!saved)return;
  if(saved.task_id!==taskId||saved.keyword!==keyword||saved.city?.name!==city.name||String(saved.city?.code)!==String(city.code))throw Error('智联会话断点任务 ID 或查询条件不匹配');
  if(saved.acquisition_mode!=='session_json_api'||!Array.isArray(saved.rows)||saved.rows.some(row=>!row?.job_id))throw Error('智联会话断点结构或采集方式不匹配');
  if(saved.nextPage!=null&&(!Number.isSafeInteger(saved.nextPage)||saved.nextPage<1))throw Error('智联会话断点页码无效');
  if(saved.completed===true&&saved.nextPage!=null)throw Error('智联会话断点完成标记与页码矛盾');
}
export function zhaopinSessionCheckpointState(saved,settings={}){
  if(hasVerifiedSessionCompletion(saved,'zhaopin'))return 'query_finished';
  if(saved.completed===true)return sessionAuditStartPage(saved,'zhaopin')>Number(settings.maxPages||Infinity)?'page_limit':'pending';
  if(Number(settings.maxRows)>0&&saved.rows.length>=Number(settings.maxRows))return 'row_limit';
  if(Number(saved.nextPage||1)>Number(settings.maxPages||Infinity))return 'page_limit';
  return 'pending';
}
