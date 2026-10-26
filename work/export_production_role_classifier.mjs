// One-time deployment export; never trains or changes the sealed experiment.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const root=path.resolve(import.meta.dirname,'..');
const source=path.join(root,'ui_data/insights/comparisons/codex-classifier-20261016');
const dest=path.join(root,'work/models/role-screening');
const bytes=await fs.readFile(path.join(source,'classifier.json')),hash=x=>createHash('sha256').update(x).digest('hex');
const classifier=JSON.parse(bytes),seal=JSON.parse(await fs.readFile(path.join(source,'selection-before-test.json'),'utf8'));
assert.equal(hash(bytes),seal.classifier_sha256);
assert.equal(classifier.selections.char_tfidf_lr.C,10);assert.equal(classifier.selections.char_tfidf_lr.threshold,.55);
const artifact={version:'data-analysis-tfidf-lr-v1',family:'数据分析',algorithm:'char-tfidf-logistic-regression',
 threshold:.55,classes:[0,1],C:10,input_contract:'generic-duty-head-middle-tail420-v1',
 tfidf:classifier.tfidf,head:classifier.heads.char_tfidf_lr,
 provenance:{source_classifier_sha256:hash(bytes),training_rows:286,validation_rows:57,
   annotation:'Codex源文证据标签，非独立人工金标准',scope:'仅数据分析岗位族；不是其他岗位的分类器；分数未经概率校准',
   old_random:{known:76,precision:6/7,recall:6/11},old_challenge:{known:38,precision:1,recall:.8},
   fresh_random:{known:77,positive:5,precision:.8,recall:.8},fresh_challenge:{known:35,positive:13,precision:1,recall:9/13},
   limitation:'两轮隔离样本规模有限，含Codex标签偏差；存在误纳漏纳。词云显示词不参与准入，查询词与外部标签不作为特征。'}};
const output=JSON.stringify(artifact),filename=path.join(dest,'data-analysis-tfidf-lr-v1.json');
await fs.mkdir(dest,{recursive:true});await fs.writeFile(filename,output,{flag:'wx'});
console.log(JSON.stringify({filename,sha256:hash(output),features:Object.keys(artifact.tfidf.vocabulary).length,bytes:Buffer.byteLength(output)}));
