import assert from 'node:assert/strict';
import { roleSections, learnRoleEvidence, matchRoleEvidence } from './role-evidence-v2.mjs';
const row=(title,jd)=>({'岗位名称':title,'岗位描述':jd});
const model={profile:'agent-engineering',version:'role-evidence-v2',algorithm:'tfidf',threshold:4,keywords:[{term:'agent'},{term:'rag'},{term:'api'},{term:'增强'},{term:'生成'},{term:'llm'}]};
const match=jd=>matchRoleEvidence(row('软件工程师',jd),model);
assert.equal(match('岗位职责：负责AI Agent研发').matched,true,'明确职责单强学习词可以纳入');
assert.equal(match('岗位职责：负责API开发和图像增强生成').matched,false,'弱词组合不能纳入');
assert.equal(match('岗位职责：使用AI Coding工具和Agent辅助编程生成代码').matched,false,'编程工具使用不能当开发对象');
assert.equal(match('岗位职责：维护故障排查知识库和API接口').matched,false);
assert.equal(match('岗位职责：负责RAG知识库集成开发').matched,true);
assert.equal(match('岗位职责：普通开发。公司介绍：我们负责AI Agent研发').matched,false,'公司介绍不能作为职责');
assert.equal(match('岗位职责：普通开发。任职要求：了解Agent工具').decision,'review');
assert.equal(match('岗位职责：探索AI Agent研发方向').decision,'review');
assert.equal(matchRoleEvidence(row('AI应用工程师','岗位要求：负责Agent开发迭代'),model).matched,true,'标题互换时任职要求工程证据可纳入');
assert.equal(matchRoleEvidence(row('智能体开发','无实际正文'),model).matched,false,'标题不能直通');
assert.equal(matchRoleEvidence(row('软件工程师','岗位职责：负责RAG开发'),{...model,keywords:[{term:'api'}]}).matched,false,'固定领域规则不能绕过学习关键词');
assert.equal(match('岗位职责：负责agenda生成').matched,false,'英文词边界');
const sections=roleSections(row('','任职要求：负责AI Agent研发。岗位职责：普通开发。公司简介：RAG开发。福利待遇：五险'));
assert.equal(sections[0].location,'requirements');
assert.ok(!sections.some(s=>s.quote.includes('RAG开发')));
const seeds=Array.from({length:8},(_,i)=>({...row('AI应用工程师',`岗位职责：负责RAG开发和AI Agent研发，编号${i}。任职要求：熟悉模型路由和Prompt集成`),row_no:i}));
const negatives=Array.from({length:24},(_,i)=>({...row('销售',`岗位职责：拜访客户${i}。公司简介：RAG开发与Agent研发`),row_no:20+i}));
for(const algorithm of ['tfidf','textrank','contrast','fusion']) {
  const learned=learnRoleEvidence([...seeds,...negatives],{name:'智能体/大模型应用',title:/AI应用/},{algorithm});
  assert.equal(matchRoleEvidence(seeds[0],learned).matched,true);
  assert.equal(matchRoleEvidence(negatives[0],learned).matched,false);
}
console.log('role-evidence-v2: section isolation/context/threshold/learning gate/4 algorithms passed');
