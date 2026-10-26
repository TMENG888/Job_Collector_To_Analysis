// Native Node inference of the sealed sklearn TF-IDF + LR head. No Python,
// network, runtime fitting, pickle, query terms, salary or skills-field input.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {redactClassifierText} from './insight-classifier-input.mjs';

export const DATA_ANALYSIS_CLASSIFIER_VERSION='data-analysis-tfidf-lr-v1';
export const DATA_ANALYSIS_CLASSIFIER_SHA256='44cb86ca5f03b01905ef5dc94a474e51511ad047df733e6a61f1f3b405a96d37';
const artifactPath=path.join(import.meta.dirname,'models/role-screening/data-analysis-tfidf-lr-v1.json');
// Match Python re's Unicode whitespace, including C0 information separators,
// rather than JS \s (which also strips BOM and omits several Python spaces).
const spaces=/[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/gu;
const repeatedSpaces=/[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]{2,}/gu;
const duty=/岗位职责|工作职责|工作内容|岗位内容|职责描述|岗位描述|职位描述|我们需要你|(?:job\s+)?responsibilities|main\s+tasks|job\s+description/i;
const stop=/任职要求|任职资格|岗位要求|职位要求|招聘条件|我们期望你|教育背景|福利待遇|薪酬福利|(?:key\s+)?qualifications|requirements|educational\s+background|benefits/i;
const chars=s=>Array.from(s);
export function prepareClassifierInput(row){
  const title=String(row['岗位名称']??row.job_name??row.title??''),body=String(row['岗位描述']??row.job_description??row.body??'');
  const text=body.replace(spaces,' ').replace(/^ +| +$/g,''),heading=duty.exec(text);
  let part,mode;
  if(heading){part=text.slice(heading.index+heading[0].length);const end=stop.exec(part);
    if(end&&chars(part.slice(0,end.index)).length>=35)part=part.slice(0,end.index);mode='duties_heading';
  }else{const end=stop.exec(text);part=end&&chars(text.slice(0,end.index)).length>=50?text.slice(0,end.index):text;mode='fallback_body';}
  const points=chars(part),compressed=points.length>420;
  if(compressed){const middle=Math.floor(points.length/2);part=points.slice(0,200).join('')+' … '+points.slice(middle-55,middle+55).join('')+' … '+points.slice(-110).join('');}
  return {text:chars(title).slice(0,60).join('')+'。主要工作：'+part,duties:part,mode,compressed,body_chars:chars(body).length,title,body};
}

// Versioned scoped input: learn technical requirements from original JD text,
// not from training-only AI tags that would be unavailable at bulk inference.
export function prepareClassifierInputV2(row){
  const title=redactClassifierText(row['岗位名称']??row.job_name??row.title??''),body=redactClassifierText(row['岗位描述']??row.job_description??row.body??'');
  const base=prepareClassifierInput({job_name:title,job_description:body});
  let detail=body.replace(spaces,' ').trim();
  const footer=/福利待遇|薪酬福利|公司简介|关于我们|联系方式|投递方式/.exec(detail);
  if(footer&&footer.index>=80)detail=detail.slice(0,footer.index);
  const points=chars(detail),compressed=points.length>2400;
  if(compressed){const middle=Math.floor(points.length/2);detail=points.slice(0,1200).join('')+' … '+points.slice(middle-300,middle+300).join('')+' … '+points.slice(-600).join('');}
  return {...base,text:chars(title).slice(0,60).join('')+'。主要工作：'+base.duties+'。岗位与任职要求：'+detail,feature_body:base.duties+'。'+detail,mode:'duties-and-requirements-v2',compressed:base.compressed||compressed};
}

export function createRoleClassifierMatcher(filename,{sha256,version,family,threshold}){
  const bytes=fs.readFileSync(filename);
  if(createHash('sha256').update(bytes).digest('hex')!==sha256)throw new Error(`${family}筛选模型校验失败，已停止；不会静默回退关键词方案`);
  const model=JSON.parse(bytes),spec=model.tfidf,weights=model.head.coef;
  if(model.input_preprocessing&&!['duties-v1','scoped-jd-v2'].includes(model.input_preprocessing))throw new Error('模型输入契约不受支持，停止分类');
  if(model.version!==version||model.family!==family||model.threshold!==threshold||!(threshold>0&&threshold<1)||weights.length!==spec.idf.length||!weights.every(Number.isFinite)||!spec.idf.every(Number.isFinite)||!Number.isFinite(model.head.intercept)||Object.keys(spec.vocabulary).length!==weights.length||!Object.values(spec.vocabulary).every(i=>Number.isInteger(i)&&i>=0&&i<weights.length)||new Set(Object.values(spec.vocabulary)).size!==weights.length)throw new Error(`${family}筛选模型结构无效，已停止`);
  const vocabulary=new Map(Object.entries(spec.vocabulary)),terms=Array(weights.length);
  for(const [term,index] of vocabulary)terms[index]=term;
  function match(row){
    const input=model.input_preprocessing==='scoped-jd-v2'?prepareClassifierInputV2(row):prepareClassifierInput(row);
    const evidence={model_version:model.version,artifact_sha256:sha256,threshold:model.threshold,
      input_mode:input.mode,compressed:input.compressed,body_chars:input.body_chars,score:null,
      score_semantics:'未校准分类分数，不是正确概率；特征贡献不代表因果或逐句职责判断'};
    const result=(decision,reason)=>({matched:decision==='include',decision,method:`TF-IDF＋逻辑回归（${family}）`,
      confidence_band:decision==='include'?'模型纳入（非人工确认）':decision==='review'?'待复核':'排除',reasons:[reason],topic_matches:[],joint_evidence:null,
      classifier_evidence:evidence,keyword_evidence:{hits:[],rule_seed:false,algorithm:model.algorithm,model_version:model.version,
        quotes:decision==='review'&&input.body?[{location:'source',quote:chars(input.body).slice(0,180).join('')}]:[],production_quotes:[]}});
    // Do not silently truncate an out-of-scope JD into an apparent confident decision.
    if(!input.title.trim()||input.body_chars<80||input.body_chars>9000)return result('review',`标题缺失或正文不在已评估的80–9000字符范围，待复核且不计入${family}统计`);
    // A familiar title must not admit an entirely out-of-vocabulary body.
    const bodyPoints=chars((input.feature_body??input.duties).toLowerCase().replace(repeatedSpaces,' '));let knownBody=false;
    for(let n=2;n<=4&&!knownBody;n++)for(let i=0;i+n<=bodyPoints.length;i++)if(vocabulary.has(bodyPoints.slice(i,i+n).join(''))){knownBody=true;break;}
    if(!knownBody)return result('review','正文没有已知模型特征，待复核；不回退标题纳入');
    const points=chars(input.text.toLowerCase().replace(repeatedSpaces,' ')),counts=new Map();
    for(let n=2;n<=4;n++)for(let i=0;i+n<=points.length;i++){
      const index=vocabulary.get(points.slice(i,i+n).join(''));
      if(index!==undefined)counts.set(index,(counts.get(index)||0)+1);
    }
    if(!counts.size)return result('review','正文没有已知模型特征，待复核；不回退标题或关键词纳入');
    const tfidf=[...counts].sort((a,b)=>a[0]-b[0]).map(([index,count])=>[index,(1+Math.log(count))*spec.idf[index]]);
    const norm=Math.sqrt(tfidf.reduce((sum,[,value])=>sum+value*value,0));
    let logit=model.head.intercept;const contributions=[];
    for(const [index,value] of tfidf){const contribution=value/norm*weights[index];logit+=contribution;contributions.push({term:terms[index],contribution});}
    evidence.score=1/(1+Math.exp(-Math.max(-500,Math.min(500,logit))));evidence.matched_features=counts.size;
    evidence.top_features=contributions.sort((a,b)=>Math.abs(b.contribution)-Math.abs(a.contribution)).slice(0,8);
    return result(evidence.score>=model.threshold?'include':'exclude',evidence.score>=model.threshold?`封存的监督分类模型达到${threshold}纳入阈值；仍可能误纳`:`监督分类分数未达到${threshold}，不纳入${family}；不代表与所有岗位无关`);
  }
  return {match,metadata:{version:model.version,family:model.family,algorithm:model.algorithm,threshold:model.threshold,artifact_sha256:sha256,
    provenance:model.provenance,input_contract:model.input_contract}};
}
export function createDataAnalysisMatcher(filename=artifactPath){return createRoleClassifierMatcher(filename,{sha256:DATA_ANALYSIS_CLASSIFIER_SHA256,version:DATA_ANALYSIS_CLASSIFIER_VERSION,family:'数据分析',threshold:.55});}
let singleton;
const instance=()=>singleton??=createDataAnalysisMatcher();
export const matchDataAnalysis=row=>instance().match(row);
export const dataAnalysisClassifierMetadata=()=>structuredClone(instance().metadata);
export function dataAnalysisScreeningEnabled(){
  const value=process.env.JOB_DATA_ANALYSIS_SCREENING||'tfidf-lr';
  if(!['tfidf-lr','legacy'].includes(value))throw new Error('JOB_DATA_ANALYSIS_SCREENING仅支持tfidf-lr或legacy');
  return value==='tfidf-lr';
}
export function dataAnalysisInsightModel(){
  const metadata=dataAnalysisClassifierMetadata();
  return {...metadata,profile:'data-analysis-supervised',display_name:'TF-IDF＋逻辑回归（数据分析）',scope:'数据分析',
    keywords:[],display_keywords:[],minimum_hits:null,training_seed_rows:[],rule_seed_candidates:0,training_background_rows:286,cold_start:false,
    annotation_type:metadata.provenance.annotation,validation:metadata.provenance,
    seed_source:'固定离线监督训练集；当前数据不参与拟合或选阈值',
    selection_policy:'仅标题＋原文职责经固定字符TF-IDF与逻辑回归评分，阈值0.55；没有标题直通或关键词命中门槛；超出长度范围/无特征单列待复核；词云词不参与筛选；非人工确认，存在漏纳误纳'};
}
