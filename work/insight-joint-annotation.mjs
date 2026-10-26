import {semanticPrompt,concreteTechnologyInstructions,validateSemantic} from './insight-semantic-contract.mjs';

export const jointAnnotationPrompt=semanticPrompt.replace(/^严格返回JSON.*\n/m,'').replace('fit判断','label判断')+concreteTechnologyInstructions+`
本次同时完成监督分类标签与语义标签，响应改为JSON对象 {"labels":[{"id":"输入id","label":"include|exclude|review","evidence_id":"D1","skills":[],"tasks":[],"domains":[],"industries":[]}]}。
label对应fit（review对应uncertain），不要重复输出fit或jobs。分类只判断主要职责，evidence_id必须选classification_evidence_options中的职责编号D；不以行业、福利、任职技能偶然出现代替职责。语义四类数组的每项用{name,evidence_id}，skills另有category字段。skills最多30项，其余每类最多10项。证据从semantic_evidence_options选择。任职技能从完整岗位证据判断，不局限于职责片段。exclude/review的四类数组为空。信息不足用review。只输出JSON。
目标为销售时：主要承担客户开发、商务谈判与业绩为include；开发CRM软件或做销售报表、不承担销售业绩为exclude。其他目标按主要职责类比。`;

// Classification proof is validated separately by validateLabels, against duties
// only. Invalid classification proof must never grant semantic inclusion.
export function validateJointSemantics(payload,batch,classified){
  const fitEvidenceById=new Map();
  for(const sample of batch){
    const label=classified.find(r=>r.id===sample.sourceId);
    const proof=sample.options?.find(o=>o.quote===label?.evidence);
    if(['include','exclude'].includes(label?.label)&&proof&&sample.model_body.includes(proof.quote))fitEvidenceById.set(sample.id,{...proof,field:'normalized_duties',source:'validated_classification'});
  }
  return validateSemantic({jobs:payload.labels.map(item=>{
    const label=classified.find(r=>r.id===batch.find(s=>s.id===item.id)?.sourceId)?.label;
    return {...item,fit:label==='review'?'uncertain':label};
  })},batch.map(s=>({...s,key:s.semantic_key,options:s.semantic_options})),{fitEvidenceById}).rows;
}

export function summarizeJointSemantics(rows){
  const fields={};
  for(const field of ['skills','tasks','domains','industries']){
    const counts=new Map();let taggedRows=0;
    for(const row of rows.filter(r=>r.fit==='include')){
      const names=new Set((row[field]||[]).map(t=>t.name).filter(Boolean));
      if(names.size)taggedRows++;
      for(const name of names)counts.set(name,(counts.get(name)||0)+1);
    }
    fields[field]={taggedRows,mentions:[...counts.values()].reduce((a,b)=>a+b,0),unique:counts.size,top:[...counts].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,12).map(([name,count])=>({name,count}))};
  }
  return {sampled:rows.length,accepted:rows.filter(r=>r.fit==='include').length,fields};
}
