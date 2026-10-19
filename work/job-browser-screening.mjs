import {roleClassifier,supervisedRoleFamilies} from './role-classifier-registry.mjs';
import {createRoleClassifierMatcher} from './data-analysis-classifier.mjs';
import {scopedClassifierRow} from './insight-classifier-input.mjs';

export function createBrowserScreening({supervised}={}){
  const trainedCache=new Map();
  async function models(){
    const released=supervisedRoleFamilies().map(role=>{
      const model=roleClassifier(role);
      return {id:'released:'+role,role,source:'released-supervised',version:model.metadata.version,threshold:model.metadata.threshold,match:model.match,metricsBasis:'原发布评测；BOSS新样本效果尚未人工核验'};
    });
    for(const spec of await supervised?.browserModels?.()||[]){
      const key=spec.id+':'+spec.sha256;
      if(!trainedCache.has(key))trainedCache.set(key,createRoleClassifierMatcher(spec.file,spec));
      const model=trainedCache.get(key);
      released.push({id:'trained:'+spec.id,role:spec.role,source:'qwen-trained',version:spec.version,threshold:spec.threshold,match:row=>model.match(scopedClassifierRow(row)),metricsBasis:'Qwen标签代理评测；迁移到BOSS后未人工校准'});
    }
    return released;
  }
  return {
    async catalog(){return (await models()).map(({match,...meta})=>meta);},
    async screen(modelId,job){
      const model=(await models()).find(m=>m.id===modelId);
      if(!model)throw Error('未找到已启用的岗位专用监督分类器；请先在岗位洞察训练并启用，不回退规则');
      const result=model.match({'岗位名称':job.title,'岗位描述':job.description});
      return {decision:result.decision,score:result.classifier_evidence?.score??null,threshold:model.threshold,modelId:model.id,role:model.role,version:model.version,method:result.method,reason:result.reasons?.[0]||'',metricsBasis:model.metricsBasis};
    }
  };
}
