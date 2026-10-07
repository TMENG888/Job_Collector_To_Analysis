// Offline experiment only. Not imported by the production analysis entry.
import {matchRoleEvidence} from './role-evidence-v2.mjs';
const norm=s=>String(s||'').normalize('NFKC').toLowerCase();
const heading=/(岗位职责与内容|工作职责与内容|主要工作职责|岗位核心定位|岗位核心说明|核心工作|核心职责|岗位职责|工作职责|主要职责|工作内容|岗位定位|职位描述|职责描述|你要负责什么|任职要求|职位要求|岗位要求|任职资格|招聘要求|基本要求|加分项|优先条件|优先项|以下人员优先|公司介绍|公司简介|关于我们|企业介绍|福利待遇|岗位福利|薪酬福利|key responsibilities|responsibilities|qualifications|requirements|position overview)/gi;
export function sectionsV3(row){
 const jd=String(row['岗位描述']||'');let cursor=0,location='unknown';const parts=[];
 for(const m of jd.matchAll(heading)){
  parts.push({location,text:jd.slice(cursor,m.index)});
  const h=norm(m[0]);
  location=/公司|企业介绍|关于我们|福利|薪酬/.test(h)?'excluded':/加分|优先/.test(h)?'bonus':/要求|资格|qualifications|requirements/.test(h)?'requirements':'duties';
  cursor=m.index+m[0].length;
 }
 parts.push({location,text:jd.slice(cursor)});
 return parts.filter(p=>p.location!=='excluded').flatMap(p=>p.text.split(/[\n。；;]/).map(q=>({location:p.location,quote:q.trim()}))).filter(s=>s.quote&&!/^(公司|我们)(成立|是|致力于)/.test(s.quote));
}
const alias={agent:/\bagents?\b|智能体/i,rag:/\brag\b|检索增强生成/i,llm:/\bllms?\b|大语言模型|大模型/i,prompt:/prompt|提示词/i};
function hitsOf(q,model){
 const body=norm(q);return model.keywords.filter(k=>alias[norm(k.term)]?alias[norm(k.term)].test(body):/^[a-z0-9]+$/.test(norm(k.term))?new RegExp(`(?<![a-z0-9])${norm(k.term)}(?![a-z0-9])`,'i').test(body):body.replace(/\s/g,'').includes(norm(k.term).replace(/\s/g,''))).map(k=>k.term);
}
const llmContext=/\bllms?\b|大语言模型|\brag\b|检索增强生成|langchain|langgraph|llamaindex|dify|coze|fastgpt|qwen|deepseek|openai|gpt|大模型.{0,12}应用/i;
const domain=/\bagents?\b|智能体|\brag\b|检索增强生成|大模型|大语言模型|\bllms?\b|langchain|dify|coze|fastgpt/i;
const object=/\bagents?\b|智能体|\brag\b|检索增强生成|langchain|dify|coze|fastgpt|大语言模型|\bllms?\b|大模型|知识库|工作流|模型能力|模型服务|ai能力|ai服务/i;
const action=/开发|研发|构建|搭建|集成|接入|封装|部署|编排|实现|建设|二次开发|配置|设计|适配|打通|调用|develop|build|integrat\w*|implement\w*|deploy\w*|enable/gi;
const deliverable=/应用|系统|服务|平台|引擎|知识库|工作流|插件|工具|接口|模块|对话|问答|业务|场景|产品|原型|app|application|system|service|platform|workflow|tool|api|business|agents?/i;
const negative=/销售|营销策略|渠道开发|拓客|签单|货款|运营数据|竞品|产品规划|原型设计|需求整理|评测体系|测试策略|质量保障|测试工具|测试平台|评测平台|接口测试|核心能力测试|核心测试工作|算子编码|算子优化|芯片|编译器|reward system|后训练|强化学习训练策略|训练数据集|模型训练数据/i;
const usingTools=/(使用|借助|利用|运用).{0,30}(编程工具|ai.ide|cursor|copilot|codex|claude.code)|辅助.{0,10}(编程|编码|研发)|提升.{0,12}(开发|编程|编码)效率/i;
const weak=/^(api|生成|机制|增强|解析|自主|拆解|提示|问答|检索|微调|上下文|记忆)$/i;
export function matchEvidenceV3(row,model){
 const old=matchRoleEvidence(row,model);
 const sections=sectionsV3(row).map(s=>({...s,hits:hitsOf(s.quote,model)}));
 const background=sections.filter(s=>s.location!=='bonus'&&llmContext.test(norm(s.quote))&&s.hits.some(h=>!weak.test(h))&&!usingTools.test(norm(s.quote)));
 const frames=[];
 for(const s of sections){
  if(s.location==='bonus'||!s.hits.some(h=>!weak.test(h)))continue;
  const q=norm(s.quote);
  if(negative.test(q)||usingTools.test(q))continue;
  // Inspect every action/object pair within a clause, not only the first match.
  const clauses=q.split(/[，,：:]/);
  for(const clause of clauses){
   if(!object.test(clause)||!/负责|参与|承担|完成|主导|能够|可独立|构建|搭建|开发|研发|设计|implement|develop|lead|enable|build/i.test(q))continue;
   if(/^(?:\d+[、.\s]*)?(?:探索|关注|了解|熟悉|对.*兴趣)/.test(clause)&&!/能够|负责|参与|完成|具备.*落地|can\b|enable/i.test(clause))continue;
   const actions=[...clause.matchAll(action)];
   const obj=clause.match(object);
   if(!actions.some(a=>Math.abs(a.index-obj.index)<=90))continue;
   const directLLM=llmContext.test(q);
   const chineseAgent=/智能体|\bagents?\b/i.test(q);
   const clearAIagent=/ai[\s-]*agents?/i.test(q);
   if(!(directLLM||(chineseAgent&&background.length)||clearAIagent))continue;
   if(/多智能体|装备|强化学习|时序|运动控制|感知模型|生理信号/.test(q)&&!directLLM&&!background.length)continue;
   if(/预训练|sft|rlhf|权重优化|微调|模型训练/.test(q)&&!/应用|集成|接入|业务.*系统|服务|问答|助手|api|文档|图纸/.test(q))continue;
   if(!deliverable.test(q))continue;
   const roleEvidence=s.location==='duties';
   const explicitUnknown=s.location==='unknown'&&/负责|参与|主导|承担|lead|develop|build/i.test(q);
   const requirementBuild=s.location==='requirements'&&/能够|可独立|完成.*开发|具备.*落地能力/.test(q);
   if(!(roleEvidence||explicitUnknown||requirementBuild))continue;
   frames.push({location:s.location,quote:s.quote,hits:s.hits,domain:directLLM?'LLM/RAG应用':clearAIagent?'AI Agent':'岗位内LLM证据关联',action:actions.map(a=>a[0]),object:obj[0],deliverable:q.match(deliverable)?.[0],support:directLLM?[]:background.filter(b=>b.quote!==s.quote).slice(0,2).map(b=>b.quote)});
  }
 }
 const unique=[...new Map(frames.map(f=>[norm(f.quote).replace(/\s/g,''),f])).values()];
 const include=unique.some(f=>f.location==='duties'||f.location==='unknown')||unique.length>=2;
 // Conservative second pass adds evidence frames, not automatic approval of review.
 const decision=include?'include':old.decision==='include'&&sections.some(s=>negative.test(norm(s.quote))&&s.hits.length)?'review':old.decision;
 return {matched:decision==='include',decision,version:'role-evidence-v3-offline',added:include&&!old.matched,evidence_frames:unique,
  review_engine:'结构化动作/对象/交付物启发式，非外部LLM语义分类器',old_decision:old.decision};
}
