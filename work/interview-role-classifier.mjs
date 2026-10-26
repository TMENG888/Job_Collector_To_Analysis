import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {redactClassifierText} from './insight-classifier-input.mjs';

export const INTERVIEW_INPUT_VERSION='interview-original-v1';
export function prepareInterviewClassifierInput({title='',content='',body=content}={}){
  const clean=value=>redactClassifierText(String(value)).normalize('NFKC').toLowerCase().replace(/\s+/gu,' ').trim();
  const heading=Array.from(clean(title)).slice(0,100).join(''),points=Array.from(clean(body));
  const excerpt=points.length>2400?[...points.slice(0,1200),' … ',...points.slice(Math.floor(points.length/2)-300,Math.floor(points.length/2)+300),' … ',...points.slice(-600)].join(''):points.join('');
  return {text:heading+'。'+excerpt,title:heading,bodyChars:points.length,compressed:points.length>2400};
}

const wilson=(successes,n)=>{
  if(!n)return 0;
  const z=1.959963984540054,p=successes/n;
  return (p+z*z/(2*n)-z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n)))/(1+z*z/n);
};
export function interviewHardFilterGate({validation={},test={}}={}){
  const reasons=[];
  const consistent=m=>{
    if(!['n','positive','negative','tp','tn','fp','fn'].every(k=>Number.isSafeInteger(m[k])&&m[k]>=0)||m.n!==m.tp+m.tn+m.fp+m.fn||m.positive!==m.tp+m.fn||m.negative!==m.tn+m.fp)return false;
    const expected={precision:m.tp/(m.tp+m.fp),recall:m.tp/(m.tp+m.fn),f1:2*m.tp/(2*m.tp+m.fp+m.fn)};
    return Object.entries(expected).every(([key,value])=>Number.isFinite(value)&&Number.isFinite(m[key])&&Math.abs(value-m[key])<1e-9);
  };
  if(!consistent(validation)||!consistent(test))reasons.push('评测计数或指标不一致');
  if((test.n||0)<30)reasons.push('独立测试不足30篇');
  if(Math.min(test.positive||0,test.negative||0)<10)reasons.push('独立测试每类不足10篇');
  if(Math.min(validation.positive||0,validation.negative||0)<5)reasons.push('验证集每类不足5篇');
  for(const [name,m] of [['验证',validation],['测试',test]]){
    if(!(m.precision>=.9&&m.recall>=.85&&m.f1>=.87))reasons.push(name+'指标未达到精确率90%、召回率85%、F1 87%');
  }
  if(wilson(test.tp||0,(test.tp||0)+(test.fp||0))<.7)reasons.push('测试精确率95%置信区间下界不足70%');
  if(wilson(test.tp||0,(test.tp||0)+(test.fn||0))<.7)reasons.push('测试召回率95%置信区间下界不足70%');
  return {eligible:reasons.length===0,reasons};
}

export async function loadInterviewRoleClassifier(filename,{sha256}={}){
  if(!/^[a-f0-9]{64}$/.test(String(sha256||'')))throw Error('面经分类器必须提供固定文件摘要');
  const stat=await fs.stat(filename);
  if(stat.size>25*1024*1024)throw Error('面经分类器超出文件预算');
  const bytes=await fs.readFile(filename);
  if(createHash('sha256').update(bytes).digest('hex')!==sha256)throw Error('面经分类器文件校验失败');
  const model=JSON.parse(bytes),spec=model.tfidf,head=model.head;
  if(model.input_preprocessing!==INTERVIEW_INPUT_VERSION||model.family!=='智能体/大模型应用'||!spec||!head||!Array.isArray(head.coef)||!Array.isArray(spec.idf)||!spec.vocabulary||head.coef.length!==spec.idf.length||head.coef.length>20000||!head.coef.length||!head.coef.every(Number.isFinite)||!spec.idf.every(v=>Number.isFinite(v)&&v>0)||!Number.isFinite(head.intercept)||JSON.stringify(head.classes)!=='[0,1]'||JSON.stringify(spec.ngram_range)!=='[2,4]'||spec.sublinear_tf!==true||!(model.threshold>0&&model.threshold<1))throw Error('面经分类器输入或结构不兼容');
  const vocabulary=new Map(Object.entries(spec.vocabulary)),indices=[...vocabulary.values()];
  if(indices.length!==head.coef.length||new Set(indices).size!==indices.length||!indices.every(i=>Number.isInteger(i)&&i>=0&&i<head.coef.length)||[...vocabulary.keys()].some(k=>Array.from(k).length<2||Array.from(k).length>4))throw Error('面经分类器词表无效');
  const gate=interviewHardFilterGate(model.provenance||{});
  const hardEligible=model.hard_filter_eligible===true&&gate.eligible;
  return {
    metadata:{version:model.version,role:model.family,threshold:model.threshold,sha256,hardFilterEligible:hardEligible,gate,metricsBasis:'Codex语义标签的隔离一致性；非人工准确率，非来源真实性验证'},
    classify(post,{role=model.family,hardFilter=false}={}){
      if(role!==model.family)return {decision:'review',score:null,reason:'不借用其他岗位分类器',version:model.version};
      const input=prepareInterviewClassifierInput(post);
      if(!input.title||input.bodyChars<40||input.bodyChars>60000)return {decision:'review',score:null,reason:'标题缺失或正文超出40–60000字范围',version:model.version};
      const points=Array.from(input.text),counts=new Map();
      for(let n=2;n<=4;n++)for(let i=0;i+n<=points.length;i++){
        const index=vocabulary.get(points.slice(i,i+n).join(''));
        if(index!==undefined)counts.set(index,(counts.get(index)||0)+1);
      }
      const bodyPoints=Array.from(input.text.slice(input.title.length+1));
      let bodyKnown=false;
      for(let n=2;n<=4&&!bodyKnown;n++)for(let i=0;i+n<=bodyPoints.length;i++)if(vocabulary.has(bodyPoints.slice(i,i+n).join(''))){bodyKnown=true;break;}
      if(!counts.size||!bodyKnown)return {decision:'review',score:null,reason:'正文没有训练词表特征',version:model.version};
      const values=[...counts].map(([i,count])=>[i,(1+Math.log(count))*spec.idf[i]]),norm=Math.sqrt(values.reduce((sum,[,value])=>sum+value*value,0));
      const logit=head.intercept+values.reduce((sum,[i,value])=>sum+value/norm*head.coef[i],0),score=1/(1+Math.exp(-Math.max(-500,Math.min(500,logit)))),rawDecision=score>=model.threshold?'include':'exclude';
      return {decision:rawDecision==='include'?'candidate':hardFilter&&hardEligible?'exclude':'review',rawDecision,score,threshold:model.threshold,version:model.version,hardFilterApplied:hardFilter&&hardEligible,compressed:input.compressed,reason:'仅岗位相关性分数；不是面经真实性或正确概率'};
    },
  };
}
