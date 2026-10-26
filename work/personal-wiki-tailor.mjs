import {desktopMatchPrompt,validateDesktopJobMatch} from './job-desktop-match-policy.mjs';
import {redactMatchText} from './job-browser-match.mjs';

export const sufficientResume=(value,coverage=.6)=>value.matches?.length>=3&&value.coverage>=coverage&&value.droppedEvidence===0&&!value.truncatedJD&&!!value.greeting?.trim();
export async function tailorFromWiki({wiki,job,request,options={},coverage=.6}){
  if(!job||typeof job.title!=='string'||!job.title.trim()||typeof job.description!=='string'||job.description.length<30||job.description.length>16000)throw Error('请提供完整JD（30–16000字），不能对截断JD自动定制');
  const facts=await wiki.factsForJob(job);if(!facts.length)return {state:'insufficient-wiki',message:'Wiki尚无人工核实的能力证据'};
  const text=facts.map(f=>redactMatchText(f.quote)).join('\n');
  const safeJob={title:redactMatchText(job.title),company:redactMatchText(job.company||''),description:redactMatchText(job.description)};
  const parsed=await request(desktopMatchPrompt+'\n本轮简历字段来自已人工确认的Wiki原文证据，不推断其他能力或身份。',{resume:text,job:safeJob},options);
  const match={...validateDesktopJobMatch(parsed,text,safeJob),truncatedJD:false};
  if(!sufficientResume(match,coverage))return {state:'insufficient-wiki',message:'Wiki证据仍不足或硬性资格待核实，不编造简历',coverage:match.coverage};
  if(match.matches.some(m=>!facts.some(f=>redactMatchText(f.quote).includes(m.resume_evidence))))throw Error('Wiki匹配包含跨条目或不可溯源证据，请核实后再生成');
  const factIds=[...new Set(match.matches.flatMap(m=>facts.filter(f=>redactMatchText(f.quote).includes(m.resume_evidence)).map(f=>f.id)))];
  if(!factIds.length)throw Error('Wiki匹配证据无法回溯到单条已确认事实');
  options.signal?.throwIfAborted();
  const draft=await wiki.createDraft({job,factIds});
  return {state:'awaiting-review',draft,message:'已根据Wiki证据生成定制PDF，请到个人资料逐页批准；本岗位未发送',coverage:match.coverage};
}
