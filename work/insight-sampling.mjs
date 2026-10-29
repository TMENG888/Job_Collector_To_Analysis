// Retrieval is a deterministic sampling aid, NEVER a class decision. It is
// neither sent as a teacher hint nor used by TF-IDF/LR or bulk inference.
export const INSIGHT_SAMPLING_VERSION='schema-stratified-v1';
const normalized=value=>String(value??'').normalize('NFKC').toLowerCase().replace(/\s+/g,' ');
const evenly=(rows,n)=>n>=rows.length?rows.slice():Array.from({length:n},(_,i)=>rows[Math.floor(i*rows.length/n)]);

export function trainingKeywords(value=''){
  if(typeof value!=='string'||value.length>240||/[\x00-\x1f<>`{}\\]/.test(value))throw Error('岗位检索关键词须为240字以内的普通文本');
  const words=[...new Set(value.split(/[、,，;；\n]/).map(s=>s.trim()).filter(Boolean))];
  if(words.length>12||words.some(s=>s.length<2||s.length>60))throw Error('请输入1–12个岗位检索词，每个2–60字，以逗号分隔');
  return words;
}

export function samplingRetrieval(schema,role='',keywords=''){
  const seeds=trainingKeywords(keywords);
  if(schema?.retrieval)return {source:'approved-schema',skill_keywords:[],business_keywords:[],...schema.retrieval,title_keywords:[...new Set([...seeds,...schema.retrieval.title_keywords])]};
  // Compatibility only: never alter or re-hash an existing approved schema.
  const titles=[...new Set([...String(role||schema?.role||'').split(/[\/、,，]/),...(schema?.classification?.positive_examples||[]).map(r=>r.title)].map(t=>t.trim()).filter(t=>t.length>=2))].slice(0,24);
  return {source:'legacy-role-fallback',title_keywords:[...new Set([...seeds,...titles])],duty_keywords:titles,adjacent_keywords:[],skill_keywords:[],business_keywords:[]};
}

export function retrievalHits(value,terms){
  const text=normalized(value);
  return [...new Set(terms.filter(term=>{
    const needle=normalized(term);if(!needle)return false;let start=0,index;
    while((index=text.indexOf(needle,start))!==-1){
      const before=text[index-1]||'',after=text[index+needle.length]||'';
      if((!/^[a-z0-9]/.test(needle)||!/[a-z0-9_]/.test(before))&&(!/[a-z0-9]$/.test(needle)||!/[a-z0-9_]/.test(after)))return true;
      start=index+1;
    }
    return false;
  }))];
}

export function retrievalMatch(title,body,retrieval){
  const titles=retrievalHits(title,retrieval.title_keywords),duties=retrievalHits(body,retrieval.duty_keywords),adjacent=retrievalHits(title+' '+body,retrieval.adjacent_keywords),skills=retrievalHits(body,retrieval.skill_keywords||[]),business=retrievalHits(body,retrieval.business_keywords||[]);
  const target=titles.length>0||duties.length>=2||skills.length>=2&&(duties.length>0||business.length>0);
  return {title:titles,duties,adjacent,skills,business,target,related:!target&&(duties.length>0||adjacent.length>0||skills.length>0||business.length>0),score:Math.min(4,titles.length)*4+Math.min(5,duties.length)*2+Math.min(3,skills.length)+Math.min(2,business.length)};
}

function companyDiverse(rows){
  const groups=new Map();
  for(const row of rows){const key=normalized(row.company)||row.id;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
  let buckets=[...groups.values()];const output=[];
  for(let offset=0;buckets.length;offset++){const next=[];for(const group of buckets){output.push(group[offset]);if(group.length>offset+1)next.push(group);}buckets=next;}
  return output;
}

export function sampleInsightCandidates(source,background,count,{schema,role,keywords='',randomSourceKeys}={}){
  if(!Number.isInteger(count)||count<1)throw Error('抽样数量须为正整数');
  const retrieval=samplingRetrieval(schema,role,keywords),hints=new Map();
  const ranked=source.map(row=>{
    const match=retrievalMatch(row.title,row.body||row.model_body,retrieval);
    hints.set(row.id,{title:match.title,duties:match.duties,adjacent:match.adjacent,skills:match.skills,business:match.business});
    return {row,...match,adjacentTitle:retrievalHits(row.title,retrieval.adjacent_keywords)};
  }).sort((a,b)=>b.score-a.score||a.row.id.localeCompare(b.row.id));
  const targets=companyDiverse(ranked.filter(r=>r.target).map(r=>r.row));
  const relatedGroups=new Map();
  for(const item of ranked.filter(r=>r.related).sort((a,b)=>b.adjacentTitle.length-a.adjacentTitle.length||b.score-a.score||a.row.id.localeCompare(b.row.id))){
    const group=item.adjacentTitle[0]||item.adjacent[0]||'其他相近候选';
    if(!relatedGroups.has(group))relatedGroups.set(group,[]);
    relatedGroups.get(group).push(item.row);
  }
  const related=[],buckets=[...relatedGroups.values()].map(companyDiverse);
  for(let offset=0;buckets.some(group=>group.length>offset);offset++)for(const group of buckets)if(group[offset])related.push(group[offset]);
  const chosen=[],seen=new Set(),allocations={};
  function take(rows,n,stratum,uniform=false){
    const available=rows.filter(r=>!seen.has(r.id)),picked=uniform?evenly(available,Math.min(n,available.length)):available.slice(0,n);
    for(const row of picked){seen.add(row.id);chosen.push({...row,sampling:{stratum,...(hints.get(row.id)||{title:[],duties:[],adjacent:[]})}});}
    allocations[stratum]=(allocations[stratum]||0)+picked.length;
  }
  // Freeze the random slice BEFORE enrichment, independent of keywords and
  // labels. Unmatched rows are never excluded from the annotation universe.
  const randomQuota=Math.floor(count*.2),targetQuota=Math.floor(count*.6),relatedQuota=count-randomQuota-targetQuota;
  const randomKeys=Array.isArray(randomSourceKeys)?new Set(randomSourceKeys):null;
  const randomSource=randomKeys?source.filter(row=>randomKeys.has(row.source_key)):source;
  take(randomSource,randomQuota,'random_source',true);
  take(targets,targetQuota,'target_candidate');
  take(related,relatedQuota,'related_candidate');
  const deficit=()=>count-chosen.length;
  if(deficit())take(targets,deficit(),'target_overflow');
  if(deficit())take(related,deficit(),'related_overflow');
  if(deficit())take(source,deficit(),'source_fallback',true);
  // No mandatory 30% all-library dilution. Background is only a shortage
  // fallback when the current dataset cannot supply the requested count.
  if(deficit())take(background,deficit(),'background_fallback',true);
  // Mix strata so early progress isn't misleadingly all-positive/all-negative.
  chosen.sort((a,b)=>a.id.localeCompare(b.id));
  const warnings=[];
  if(randomKeys&&randomSource.length<randomQuota)warnings.push('全库随机层有效去重样本不足，已由候选补齐；本轮随机覆盖不足');
  if(retrieval.source!=='approved-schema')warnings.push('旧规范未包含检索词，暂用岗位名与示例召回；重新起草确认可启用完整关键词');
  if(targets.length<targetQuota)warnings.push('目标候选不足，已用相近及随机岗位补齐；关键词命中不等于正例');
  if(source.length&&targets.length/source.length>.8)warnings.push('检索词覆盖超过80%岗位，区分度可能不足，请核对规范');
  if(chosen.length<count)warnings.push('去重后候选不足请求数量');
  return {samples:chosen,scope_candidates:source.length,background_candidates:background.length,sampling:{version:INSIGHT_SAMPLING_VERSION,retrieval,requested:count,targetCandidates:targets.length,relatedCandidates:related.length,randomPopulation:randomKeys?'all-library-reservoir':'source-candidates',allocations,warnings,metricsBasis:'分层富集抽样上的留出标签一致性，不代表全库准确率或目标岗位占比',classificationByKeywords:false}};
}

export function assessTrainingLabels(samples,requested=samples.length){
  const positive=samples.filter(r=>r.label==='include').length,negative=samples.filter(r=>r.label==='exclude').length,review=samples.length-positive-negative;
  const minimum={positive:24,negative:24,total:60};
  const deficits={positive:Math.max(0,minimum.positive-positive),negative:Math.max(0,minimum.negative-negative),total:Math.max(0,minimum.total-positive-negative)};
  return {ready:!Object.values(deficits).some(Boolean),positive,negative,review,minimum,deficits,recommendedPositive:Math.ceil(requested*.25),basis:'先检查有效类别数量，再按公司及近重复隔离检查训练/验证/测试；不调整测试集凑指标'};
}
