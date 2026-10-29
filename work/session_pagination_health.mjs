import {createHash} from 'node:crypto';

export const paginationVersion=1;
export const pageSignature=ids=>createHash('sha256').update(JSON.stringify(ids.map(String).sort())).digest('hex');
const integer=n=>Number.isSafeInteger(n)&&n>=0;
export function hasVerifiedSessionCompletion(saved,platform){
  if(saved?.completed!==true)return false;
  const rows=platform==='job51'?saved.records:saved.rows;
  if(!Array.isArray(rows)||!integer(saved.total))return false;
  const id=platform==='job51'?'jobId':'job_id';
  if(rows.some(row=>!row?.[id]))return false;
  const size=new Set(rows.map(row=>String(row[id]))).size;
  const evidence=saved.pagination;
  // Old positive checkpoints can prove total coverage by stable IDs. A short
  // page or an empty legacy checkpoint alone cannot prove source exhaustion.
  if(!evidence)return platform!=='zhaopin'&&saved.total>0&&size>=saved.total;
  if(evidence.version!==paginationVersion||evidence.platform!==platform||evidence.total!==saved.total||evidence.rows!==size||!integer(evidence.page)||evidence.page<1||!integer(evidence.received)||!evidence.consumedAll)return false;
  if(evidence.keyword!==saved.keyword||String(evidence.cityCode)!==String(saved.city?.code))return false;
  if(evidence.reason==='confirmed_empty')return saved.total===0&&evidence.received===0&&size===0;
  if(evidence.reason==='total_reached')return platform!=='zhaopin'&&saved.total>0&&size>=saved.total;
  if(platform==='job51'&&evidence.reason==='website_end')return evidence.websiteEnd===true&&evidence.received>0;
  if(platform==='zhaopin'&&evidence.reason==='server_end')return evidence.serverEnd===true;
  if(platform==='job51'&&evidence.reason==='observed_total_reached'){
    const pages=evidence.pages;
    return Array.isArray(pages)&&pages.length===evidence.page&&pages.every((p,i)=>p.page===i+1&&integer(p.received)&&p.received>0&&typeof p.signature==='string')&&pages.reduce((sum,p)=>sum+p.received,0)>=saved.total&&saved.total>0;
  }
  return false;
}
export const sessionCompletionNeedsAudit=(saved,platform)=>saved?.completed===true&&!hasVerifiedSessionCompletion(saved,platform);
// A newly persisted count-only terminal checkpoint has a reliable page cursor:
// continue with the next page instead of re-reading its entire prefix.
export function sessionAuditStartPage(saved,platform){
  const p=saved?.pagination;
  return platform==='zhaopin'&&sessionCompletionNeedsAudit(saved,platform)&&p?.platform===platform&&p.version===paginationVersion
    &&p.keyword===saved.keyword&&String(p.cityCode)===String(saved.city?.code)&&p.reason==='total_reached'
    &&integer(saved.total)&&p.total===saved.total&&Array.isArray(saved.rows)&&saved.rows.every(row=>row?.job_id)
    &&p.rows===new Set(saved.rows.map(row=>String(row.job_id))).size
    &&p.consumedAll===true&&integer(p.page)&&p.page>=1?p.page+1:1;
}
