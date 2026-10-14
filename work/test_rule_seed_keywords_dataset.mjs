import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readJobDataset} from './job_dataset.mjs';
import {learnRuleSeedModel,matchRuleSeedRole,unlabeledGroups,strictRuleSeed} from './rule-seed-keywords.mjs';
const root=path.resolve(import.meta.dirname,'..'),out=path.join(root,'ui_data/keyword_validation/ai_drama_rule_seed_v2');
// Preserve the first iteration before an evidence-driven rule refinement.
if(process.argv.includes('--audit-refinement')) {
  for(const name of ['算法评估.json','实测报告.md']) {
    const file=path.join(out,name),snapshot=path.join(out,'首轮_'+name);
    try {await fs.copyFile(file,snapshot,fs.constants.COPYFILE_EXCL);} catch(e){if(!['ENOENT','EEXIST'].includes(e.code))throw e;}
  }
}
const source=process.env.JOB_TEST_DATASET||path.join(root,'outputs','ai漫剧师岗位_3150条.xlsx');
const before=crypto.createHash('sha256').update(await fs.readFile(source)).digest('hex');
const {rows}=await readJobDataset(source,'岗位数据');
assert.equal(rows.length,3150);
// Labels are loaded exclusively for measurement after the learner is defined.
const reviewed=JSON.parse(await fs.readFile(path.join(root,'ui_data/keyword_validation/ai_drama_v1/验证集标注.json'),'utf8')).annotations;
const byNo=new Map(rows.map(r=>[r.row_no,r])),groups=unlabeledGroups(rows),groupFor=new Map(rows.map((r,i)=>[r.row_no,groups[i]]));
const dev=reviewed.filter(x=>x.label!=='uncertain'&&parseInt(groupFor.get(x.row_no).slice(0,8),16)%10<6);
const test=reviewed.filter(x=>x.label!=='uncertain'&&parseInt(groupFor.get(x.row_no).slice(0,8),16)%10>=6);
const measure=(samples,predict)=>{
  const c={tp:0,fp:0,fn:0,tn:0},errors=[];
  for(const x of samples){const actual=x.label==='include',predicted=predict(byNo.get(x.row_no));c[predicted?(actual?'tp':'fp'):(actual?'fn':'tn')]++;if(actual!==predicted)errors.push({row_no:x.row_no,title:x.title,label:x.label,predicted});}
  const p=c.tp/(c.tp+c.fp)||0,r=c.tp/(c.tp+c.fn)||0;
  return {...c,precision:p,recall:r,f1:2*p*r/(p+r)||0,n:samples.length,errors};
};
const candidates=[];
for(const algorithm of ['tfidf','textrank','fusion'])for(const top_k of [20,40,80])for(const minimum_hits of [1,2,3]){
  const model=learnRuleSeedModel(rows,{algorithm,top_k,minimum_hits});
  assert.ok(!model.reviewed_overrides);
  assert.ok(model.training_seed_rows.every(n=>strictRuleSeed(byNo.get(n))));
  assert.ok(model.training_seed_rows.every(n=>!test.some(x=>groupFor.get(x.row_no)===groupFor.get(n))));
  candidates.push({model,development:measure(dev,r=>matchRuleSeedRole(r,model).matched)});
}
const order=(a,b)=>b.development.f1-a.development.f1||b.development.precision-a.development.precision||a.model.top_k-b.model.top_k||b.model.minimum_hits-a.model.minimum_hits;
candidates.sort(order);const winner=candidates[0];
const evaluated=[{name:'仅严格种子规则',development:measure(dev,strictRuleSeed),test:measure(test,strictRuleSeed)},...['tfidf','textrank','fusion'].map(a=>{const x=candidates.filter(x=>x.model.algorithm===a).sort(order)[0];return {name:x.model.display_name,top_k:x.model.top_k,minimum_hits:x.model.minimum_hits,development:x.development,test:measure(test,r=>matchRuleSeedRole(r,x.model).matched)};})];
const model={...winner.model,development_rows:dev.map(x=>x.row_no),test_rows:test.map(x=>x.row_no),
  validation:{development:winner.development,test:measure(test,r=>matchRuleSeedRole(r,winner.model).matched)},
  annotation_type:'既有AI原文审核标签仅用于评估与参数选型；已在前次工作查看过，属回顾性分组挑战集，不是新盲测',
  evaluated_model_fingerprint:winner.model.dataset_fingerprint};
const predictions=rows.map(r=>({row_no:r.row_no,job_id:r['岗位ID'],title:r['岗位名称'],...matchRuleSeedRole(r,model)}));
const seeds=rows.filter(r=>model.training_seed_rows.includes(r.row_no)).map(r=>({row_no:r.row_no,title:r['岗位名称'],job_id:r['岗位ID'],description:r['岗位描述']}));
const summary={source,source_sha256:before,total_rows:rows.length,seed_source:model.seed_source,rule_seed_candidates:model.rule_seed_candidates,training_seed_rows:model.training_seed_rows.length,training_background_rows:model.training_background_rows,development_rows:dev.length,test_rows:test.length,uncertain_rows:reviewed.filter(x=>x.label==='uncertain').length,selected:model.display_name,top_k:model.top_k,minimum_hits:model.minimum_hits,included:predictions.filter(x=>x.matched).length,direct:predictions.filter(x=>x.matched&&x.keyword_evidence.rule_seed).length,expanded:predictions.filter(x=>x.matched&&!x.keyword_evidence.rule_seed).length,candidates:evaluated,review_overrides:0,limits:['既有标签为AI单审核者标注，不是人工金标准','本次沿用已看过的审核集，并依据扩展结果抽查收紧规则，是回顾性验证，不是新的独立盲测','分层抽样指标不能当作3150条总体准确率','相同前缀分组不能覆盖全部近重复文本','审核标签不参与种子选取和提词，但开发标签参与算法及阈值选型']};
await fs.mkdir(out,{recursive:true});
await fs.writeFile(path.join(root,'work/models/ai-drama-rule-seed-v2.json'),JSON.stringify(model,null,2));
for(const [name,data] of [['规则种子.json',seeds],['全量筛选结果.json',predictions],['算法评估.json',summary]])await fs.writeFile(path.join(out,name),JSON.stringify(data,null,2));
const pct=x=>(x*100).toFixed(1)+'%';
const report=['# AI漫剧规则种子关键词筛选实测','',`原始数据 ${rows.length} 条；严格规则候选 ${model.rule_seed_candidates} 条，分组后选 ${model.training_seed_rows.length} 条自动种子提词。无人工正负标签作为提词输入。`,'',`选用 ${model.display_name}，前 ${model.top_k} 个关键词，至少命中 ${model.minimum_hits} 个独立关键词并具备制作职责；严格规则命中可直接纳入。`,'',`纳入 ${summary.included} 条：直接规则 ${summary.direct} 条，关键词扩展 ${summary.expanded} 条。不采用审核覆盖。`,'','|方案|开发F1|测试Precision|测试Recall|测试F1|TP/FP/FN/TN|','|---|---:|---:|---:|---:|---|',...evaluated.map(x=>`|${x.name}|${pct(x.development.f1)}|${pct(x.test.precision)}|${pct(x.test.recall)}|${pct(x.test.f1)}|${x.test.tp}/${x.test.fp}/${x.test.fn}/${x.test.tn}|`),'',`开发评估 ${dev.length} 条，测试评估 ${test.length} 条；7条待定不评分。`,'','## 限制','',...summary.limits.map(x=>'- '+x),'','## 关键词','',model.keywords.map(x=>x.term).join('、'),'','## 测试错误','',...model.validation.test.errors.map(x=>`- 第${x.row_no}行 ${x.title}：审核${x.label}，预测${x.predicted?'纳入':'排除'}`)];
await fs.writeFile(path.join(out,'实测报告.md'),report.join('\n'));
assert.equal(crypto.createHash('sha256').update(await fs.readFile(source)).digest('hex'),before);
console.log(JSON.stringify({...summary,candidates:evaluated.map(x=>({...x,development:{...x.development,errors:undefined},test:{...x.test,errors:undefined}}))},null,2));
