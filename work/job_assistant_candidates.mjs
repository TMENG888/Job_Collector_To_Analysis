import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {knowledgeDatabasePath} from './knowledge_storage.mjs';
import {roleFamilies} from './job_knowledge_schema.mjs';
import {parseOriginalSalary} from './job_salary_parser.mjs';

const norm=value=>String(value||'').normalize('NFKC').toLowerCase().replace(/\s+/g,'');
const boundedTerms=terms=>[...new Set(terms)].filter(t=>typeof t==='string'&&t.trim().length>=2&&t.length<=40&&!/[\r\n<>`]/.test(t)).slice(0,12);
export function candidateSearchTerms(roles,extra=[]){
  return boundedTerms([...roles.flatMap(role=>{
    const family=roleFamilies.find(f=>f.name===role);
    // Literal query aliases are recall hints only, never classification rules.
    const literals=(family?.query.source||'').split('|').filter(t=>/^[\p{L}\p{N} /-]+$/u.test(t));
    return [role,...role.split('/'),...literals];
  }),...extra]);
}
const like=value=>'%'+value.replace(/[\\%_]/g,'\\$&')+'%';
export function consultationSnapshot(metadata){
  return {deferred_consultation:true,cacheKey:`consultation:${metadata.revision}`,report:{knowledge:true,role:'全岗位知识库',roles:[],revision:metadata.revision,candidate_rows:metadata.rows},jobs:[],skills:[],tokenSets:new Map(),frequencies:new Map()};
}
export function createCandidateSearch(dataDir){
  return async function searchCandidates({roles=[],search_terms=[],cities=[],limit=24,signal}={}){
    signal?.throwIfAborted();
    if(!Array.isArray(roles)||roles.length>4||roles.some(r=>typeof r!=='string'||r.length>40)||!Array.isArray(search_terms)||!Array.isArray(cities)||cities.length>4||cities.some(c=>typeof c!=='string'||c.length>40))throw Error('invalid_candidate_scope');
    const terms=candidateSearchTerms(roles,search_terms);
    if(!terms.length)throw Error('candidate_scope_required');
    limit=Math.max(2,Math.min(24,Math.floor(Number(limit)||24)));
    const db=new DatabaseSync(knowledgeDatabasePath(dataDir),{readOnly:true});
    try{
      db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=2000; BEGIN');
      const params=terms.map(like);
      let where=`j.job_key IN (SELECT m.job_key FROM memberships m JOIN tasks t ON t.task_id=m.task_id WHERE t.archived=0)
        AND (${terms.map(()=>"json_extract(j.raw,'$.job_name') LIKE ? ESCAPE '\\'").join(' OR ')})`;
      if(cities.length){where+=` AND (${cities.map(()=>"json_extract(j.raw,'$.city') LIKE ? ESCAPE '\\'").join(' OR ')})`;params.push(...cities.map(like));}
      const total=Number(db.prepare(`SELECT COUNT(*) AS n FROM jobs j WHERE ${where}`).get(...params).n);
      const internship="(instr(COALESCE(json_extract(j.raw,'$.job_name'),''),'实习')>0 OR COALESCE(json_extract(j.raw,'$.employment_type'),'')='实习')";
      const pools=[true,false].map(intern=>db.prepare(`SELECT j.job_key,j.content_hash,j.raw,j.updated_at FROM jobs j WHERE ${where} AND ${intern?'':'NOT '}${internship} ORDER BY j.job_key LIMIT 80`).all(...params));
      const seen=new Set(),groups=pools.map((pool,stageIndex)=>pool.map(record=>{
        const raw=JSON.parse(record.raw);
        return {key:record.job_key,content_hash:record.content_hash,updated_at:record.updated_at,raw,
          fields:{job_name:String(raw.job_name||'').slice(0,200),job_description:String(raw.job_description||'').slice(0,1600)}};
      }).filter(c=>{
        // Memberships and cross-platform copies must not inflate the sample.
        const fingerprint=norm([c.raw.company_name,c.raw.city,c.raw.job_name,c.raw.job_description].join('|'));
        if(!c.raw.company_name||!c.fields.job_description.trim()||seen.has(fingerprint))return false;
        seen.add(fingerprint);return true;
      }).sort((a,b)=>{
        const score=c=>2*Number(parseOriginalSalary(c.raw.salary)?.period===(stageIndex===0?'day':'month'))+Number(roles.some(role=>norm(c.raw.job_name).includes(norm(role))));
        return score(b)-score(a);
      }));
      const candidates=[];
      // Balanced stage coverage; fill unused slots without extra database calls.
      while(candidates.length<limit&&groups.some(g=>g.length))for(const group of groups)if(group.length&&candidates.length<limit)candidates.push(group.shift());
      const revision=createHash('sha256').update(JSON.stringify(candidates.map(c=>[c.key,c.content_hash]))).digest('hex');
      db.exec('COMMIT');signal?.throwIfAborted();
      return {status:'ready',total_title_hits:total,returned:candidates.length,search_terms:terms,candidates,revision,
        bounded:true,notice:'标题词仅召回候选；按招聘阶段与原始报价可用性选取有限样本，非随机市场抽样，未核验项不进入统计。'};
    }finally{db.close();}
  };
}

export function decodeCandidateReview(value,candidates,roles,revision){
  if(!value||Object.keys(value).some(k=>!['revision','labels'].includes(k))||value.revision!==revision||!Array.isArray(value.labels)||value.labels.length>candidates.length*roles.length)throw Error('invalid_review_snapshot');
  const labels=value.labels.map(label=>{
    if(!label||Object.keys(label).some(k=>!['id','role','decision','evidence'].includes(k))||!/^C[1-9]\d*$/.test(label.id))return {};
    const source=candidates[Number(label.id.slice(1))-1];
    return source?{key:source.key,content_hash:source.content_hash,role:label.role??(roles.length===1?roles[0]:undefined),decision:label.decision,evidence:label.evidence}:{};
  });
  // Short IDs are scoped to this immutable call snapshot, never database IDs.
  // The existing strict validator still checks exact text and duplicate labels.
  return validateCandidateLabels({labels},candidates,roles);
}

export function validateCandidateLabels(value,candidates,roles){
  if(!value||Object.keys(value).some(k=>k!=='labels')||!Array.isArray(value.labels)||value.labels.length>candidates.length*roles.length)throw Error('invalid_candidate_labels');
  const byKey=new Map(candidates.map(c=>[c.key,c])),counts=new Map(),accepted=new Map(),invalid_reasons={};let invalid=0;
  for(const label of value.labels){const id=JSON.stringify([label?.key,label?.role]);counts.set(id,(counts.get(id)||0)+1);}
  for(const label of value.labels){
    const c=byKey.get(label?.key),e=label?.evidence;
    const reason=!c?'unknown_source':Object.keys(label).some(k=>!['key','content_hash','role','decision','evidence'].includes(k))?'unexpected_fields':counts.get(JSON.stringify([label.key,label.role]))!==1?'duplicate_label':c.content_hash!==label.content_hash?'stale_hash':!roles.includes(label.role)?'unknown_role':!['target','non_target','uncertain'].includes(label.decision)?'invalid_decision':!e||Object.keys(e).some(k=>!['field','quote'].includes(k))||!['job_name','job_description'].includes(e.field)||typeof e.quote!=='string'?'invalid_evidence':e.quote.length<8||e.quote.length>600?'quote_length':!c.fields[e.field].includes(e.quote)?'quote_not_exact':label.decision==='target'&&(e.field!=='job_description'||e.quote.length<12)?'insufficient_target_evidence':null;
    if(reason){invalid++;invalid_reasons[reason]=(invalid_reasons[reason]||0)+1;continue;}
    if(label.decision!=='target')continue;
    if(!accepted.has(c.key))accepted.set(c.key,{...c,role_families:[],verification_evidence:[]});
    accepted.get(c.key).role_families.push(label.role);accepted.get(c.key).verification_evidence.push({...e,role:label.role});
  }
  return {accepted:[...accepted.values()],invalid,invalid_reasons,reviewed:value.labels.length-invalid,missing:candidates.length*roles.length-counts.size};
}
