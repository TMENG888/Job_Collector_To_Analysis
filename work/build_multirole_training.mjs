// Freeze source-backed labels before fitting; old experiments remain untouched.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {prepareClassifierInput} from './data-analysis-classifier.mjs';
const base=path.resolve(import.meta.dirname,'../ui_data/insights/comparisons'),out=path.join(base,'multirole-lr-20261016');
const read=async p=>JSON.parse(await fs.readFile(path.join(base,p),'utf8'));
const sha=s=>createHash('sha256').update(s).digest('hex');
const corpusBytes=await fs.readFile(path.join(out,'extended-corpus.json')),corpus=JSON.parse(corpusBytes),labels=await read('multirole-lr-20261016/source-labels.json');
assert.equal(sha(corpusBytes),labels.corpus_sha256);
const samples=[];
function add(d,decisions,quote,origin){
 const body=d.body||d.description||d.original_description,title=d.title,company=d.company_group||d.company;
 assert.ok(body?.replace(/\s+/g,' ').includes(quote.replace(/\s+/g,' ')),origin+': invalid source quote '+(d.id||d.audit_id||d.row_no));
 if(!company)return; // No company separation guarantee without a source company.
 const p=prepareClassifierInput({title,body});if(p.body_chars<80||p.body_chars>9000)return;
 samples.push({id:origin+':'+(d.id||d.audit_id||d.row_no),title,body,company:String(company).normalize('NFKC').replace(/\s|（.*?）|\(.*?\)/g,'').toLowerCase(),text:p.text,quote,decisions,origin});
}
for(const d of corpus.docs){const label=labels.records.find(r=>r.id===d.id);assert.equal(d.content_hash,label.content_hash);add(d,label.decisions,label.quote,'new-codex-duty');}
for(const [id,family]of [['agent','智能体/大模型应用'],['crawler','爬虫/数据采集']]){
 const records=await read(`weighted-role-threshold-20261010/${id}-population-stratified-audit/reviewed-records.json`);
 for(const d of records)add(d,{[family]:{t:'include',n:'exclude',u:'review'}[d.label]},d.quote,'prior-'+id+'-audit');
}
const prior=await read('weighted-role-threshold-20261010/review-labels.json');
for(const [id,family]of [['crawler','爬虫/数据采集'],['bigdata','大数据开发']]){
 const raw=await read(`weighted-role-threshold-20261010/${id}-raw.json`),byRow=new Map(raw.docs.map(d=>[d.row_no,d]));
 for(const l of prior.filter(l=>l.role===id)){const d=byRow.get(l.row_no);assert.ok(d);add(d,{[family]:{target:'include',non_target:'exclude',review:'review'}[l.label]},l.quote,'prior-'+id+'-review');}
}
for(const d of await read('object-aware-screening-20261010/fresh-reviewed.json'))if(['crawler','bigdata'].includes(d.role))add(d,{[{crawler:'爬虫/数据采集',bigdata:'大数据开发'}[d.role]]:{target:'include',non_target:'exclude',review:'review'}[d.label]},d.quote,'prior-object-'+d.role);
const payload={annotation:'Codex source-evidence annotations; not independent human gold; previous evaluations are now development only, not new independent tests',families:[...new Set(samples.flatMap(s=>Object.keys(s.decisions)))],samples};
await fs.writeFile(path.join(out,'training-corpus.json'),JSON.stringify(payload,null,2),{flag:'wx'});
console.log(JSON.stringify({records:samples.length,families:payload.families}));
