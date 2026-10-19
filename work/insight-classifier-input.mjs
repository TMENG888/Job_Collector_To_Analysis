// Frozen v1 preprocessing, shared by API sampling and candidate inference.
export const redactClassifierText=text=>String(text||'').replace(/https?:\/\/\S+/gi,'[链接已移除]').replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi,'[邮箱已移除]').replace(/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g,'[电话已移除]');
export function scopedClassifierRow(row){return {...row,'岗位名称':redactClassifierText(row['岗位名称']??row.job_name??row.title),'岗位描述':redactClassifierText(row['岗位描述']??row.job_description??row.body)};}
