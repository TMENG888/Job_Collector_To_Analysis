import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {matchKeywordRole,productionEvidence,reviewKey,extractKeywords} from './keyword-role-matcher.mjs';
const row=(name,jd)=>({'岗位名称':name,'岗位描述':jd,'岗位ID':'test','平台':'fixture'});
const model={version:'test',display_name:'测试',algorithm:'contrast',minimum_hits:2,require_production:true,keywords:[{term:'分镜'},{term:'分镜脚本'},{term:'剪辑'},{term:'成片'}]};
assert.equal(matchKeywordRole(row('短剧师','岗位职责：设计分镜脚本并剪辑成片。任职要求：本科'),model).matched,true);
assert.equal(matchKeywordRole(row('工具推广','岗位职责：推广办公工具。公司介绍：制作短剧。任职要求：熟悉分镜剪辑成片'),model).matched,false);
assert.equal(matchKeywordRole(row('模型标注','岗位职责：负责视频数据标注及成片评测，研究分镜剪辑。'),model).matched,false);
assert.equal(matchKeywordRole(row('分镜师','岗位职责：设计分镜脚本。'),model).matched,false,'嵌套短语不能算两个信号');
const r=row('技术支持','岗位职责：负责剧本工具维护及视频格式导出。');
model.reviewed_overrides={[reviewKey(r)]:{label:'exclude',reason:'已审核为技术维护'}};
assert.equal(matchKeywordRole(r,model,{applyReviewedLabels:true}).matched,false);
assert.equal(matchKeywordRole({...r,'岗位描述':'岗位职责：制作分镜并剪辑成片。'},model,{applyReviewedLabels:true}).keyword_evidence.reviewed_label,null,'JD变化必须失效覆盖');
const hasLocalFixtures = await Promise.all([
 './models/ai-drama-keywords-v1.json', '../ui_data/keyword_validation/ai_drama_v1/review_input.json',
].map(file => fs.access(new URL(file, import.meta.url)).then(() => true).catch(error => {
 if(error.code==='ENOENT') return false; throw error;
})));
if (!hasLocalFixtures.every(Boolean)) {
 console.log('keyword-role-matcher: synthetic fixtures passed; private dataset regression skipped (not bundled)');
} else {
const real=JSON.parse(await fs.readFile(new URL('./models/ai-drama-keywords-v1.json',import.meta.url),'utf8'));
const input=JSON.parse(await fs.readFile(new URL('../ui_data/keyword_validation/ai_drama_v1/review_input.json',import.meta.url),'utf8'));
for(const n of [3,4,18,244,2697]) assert.equal(matchKeywordRole(input.rows.find(x=>x.row_no===n),real,{applyReviewedLabels:true}).matched,true);
for(const n of [600,940,995,2686]) assert.equal(matchKeywordRole(input.rows.find(x=>x.row_no===n),real,{applyReviewedLabels:true}).matched,false);
for(const n of [10,29,71,96,425,506,1015]) assert.equal(matchKeywordRole(input.rows.find(x=>x.row_no===n),real,{applyReviewedLabels:true}).matched,false);
const predictions=input.rows.map(x=>matchKeywordRole(x,real,{applyReviewedLabels:true}));
assert.equal(predictions.filter(x=>x.matched).length,229);
console.log(JSON.stringify({ok:true,rows:input.rows.length,accepted:229,reviewOverridesContentBound:true,uncertainExcluded:true,keywordNestingDeduplicated:true}));
}
