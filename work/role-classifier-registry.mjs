import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRoleClassifierMatcher,dataAnalysisScreeningEnabled,dataAnalysisInsightModel,matchDataAnalysis} from './data-analysis-classifier.mjs';
const dir=path.join(import.meta.dirname,'models/role-screening');
const registryBytes=fs.readFileSync(path.join(dir,'multirole-registry-v1.json'));
if(createHash('sha256').update(registryBytes).digest('hex')!=='4a6adf7b9607e1ebbc82949321494a06dc27e882affc13e8075ff6f240b84b63')throw Error('多岗位分类器注册清单校验失败');
const registry=JSON.parse(registryBytes),instances=new Map();
export function roleScreeningEnabled(){const setting=process.env.JOB_ROLE_SCREENING||'tfidf-lr';if(!['tfidf-lr','legacy'].includes(setting))throw Error('JOB_ROLE_SCREENING仅支持tfidf-lr或legacy');return setting==='tfidf-lr';}
export function hasRoleClassifier(family){return roleScreeningEnabled()&&(family==='数据分析'?dataAnalysisScreeningEnabled():Object.hasOwn(registry.models,family));}
export function supervisedRoleFamilies(){return ['数据分析',...Object.keys(registry.models)].filter(hasRoleClassifier);}
export function roleClassifier(family){
  if(!hasRoleClassifier(family))return null;
  if(family==='数据分析')return {match:matchDataAnalysis,metadata:dataAnalysisInsightModel()};
  if(!instances.has(family)){
    const spec=registry.models[family];if(path.basename(spec.file)!==spec.file)throw Error('模型文件路径无效');
    instances.set(family,createRoleClassifierMatcher(path.join(dir,spec.file),{...spec,family}));
  }
  return instances.get(family);
}
export function roleInsightModel(family){
  const model=roleClassifier(family);if(!model)return null;if(family==='数据分析')return model.metadata;
  const meta=structuredClone(model.metadata);
  return {...meta,profile:'family-supervised',scope:family,display_name:`TF-IDF＋逻辑回归（${family}）`,keywords:[],display_keywords:[],minimum_hits:null,training_seed_rows:[],rule_seed_candidates:0,training_background_rows:meta.provenance.train_rows,cold_start:false,
    annotation_type:meta.provenance.annotation,validation:meta.provenance,seed_source:'固定原文证据标注训练集；当前待分析数据不参与拟合',
    selection_policy:`仅标题＋原文职责经固定字符TF-IDF与逻辑回归评分，阈值${meta.threshold}；不使用标题直通/查询词/外部标签纳入；短缺正文待复核且不参与统计；模型分数未经校准，仍会误纳漏纳`};
}
export function roleScreeningStatus(){return {version:registry.version,mode:'supervised-only',active:supervisedRoleFamilies().map(roleInsightModel),pending:[
  {family:'新媒体运营',reason:'公司及近重复隔离后训练正例不足，未发布'},
  {family:'销售工程师',reason:'隔离测试正例不足，未通过发布门槛'},
  {family:'爬虫/数据采集',reason:'隔离测试召回率不足，未通过发布门槛'},
  {family:'大数据开发',reason:'隔离验证集无负例，暂不发布'},
  {family:'其他岗位族',reason:'需岗位专用标签、训练和隔离评测；无合格分类器时暂停筛选，不回退规则或语义参照'}]};}
export const roleScreeningCacheKey=()=>supervisedRoleFamilies().map(f=>f+':'+(f==='数据分析'?'data-analysis-tfidf-lr-v1':registry.models[f].version)).join('|');
