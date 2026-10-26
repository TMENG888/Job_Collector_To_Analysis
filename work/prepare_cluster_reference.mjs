// Isolated, write-once Codex reference pilot. No production reads/writes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const root=path.resolve('ui_data/insights/comparisons');
const source=path.join(root,'bertopic-codex-20261017-zh-v2');
const out=path.join(root,'cluster-reference-codex-20261017');
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const taxonomy={
 it_ops:'IT系统、网络、数据库与云运维；不含机电设备维护',
 equipment_ops:'机电、制造或能源设备维护与操作；不含IT运维',
 software_dev:'通用业务软件、前后端、客户端及应用系统开发',
 ai_app:'以LLM/Agent/RAG应用系统与编排开发为主；非仅提到AI技能',
 algorithm:'模型、机器学习、视觉、推荐或控制算法研发训练优化',
 data_eng:'数据平台、数仓、ETL、数据治理与数据基础设施开发',
 data_analysis:'以业务分析、指标、统计建模和分析报告为主要交付',
 embedded:'嵌入式固件、驱动、单片机、RTOS与设备端软件开发',
 hardware:'电子电路、PCB、芯片、电子硬件研发',
 mechanical:'机械结构、电机、机械设计与仿真研发',
 software_test:'软件、系统、网络软件测试与质量保障',
 physical_test:'硬件、制造产品、材料、可靠性与物理试验测试',
 manufacturing:'制造工艺、生产、质量管理；不含主责测试或维护',
 sales:'销售、商务拓展、售前方案、客户开发与销售支持',
 ecommerce_ops:'电商店铺、平台交易、商品与商家运营',
 content_marketing:'新媒体内容、活动、用户增长、广告投放与营销运营',
 product:'产品需求、PRD、产品规划、产品迭代管理',
 design_media:'平面、交互、动画、视频、摄影等设计制作',
 project_delivery:'以项目统筹、交付实施、客户技术支持为主；不含销售主责',
 supply_chain:'采购、物流、供应链与计划',
 business_support:'人事、行政、财务、法务、客服等职能支持',
 education_research:'教学、升学咨询、学术科研、生物实验等非计算机算法科研',
 other:'有明确主责，但不属于上述类别',
 mixed:'两个及以上不同主责同等明确，无法合理选定一个主类',
 insufficient:'只有任职要求、公司介绍或过少信息，不能从职责判断主类'
};
const seen=new Set();
function keys(v){if(!v||typeof v!=='object')return;if(typeof v.key==='string')seen.add(v.key);for(const x of Object.values(v))if(x&&typeof x==='object')keys(x);}
for(const dir of ['unsupervised-codex-20261017','bertopic-codex-20261017-zh-v2']){
 for(const file of ['clusters.json','heldout-audit.json','noise-review.json']){
  const p=path.join(root,dir,file);if(fs.existsSync(p))keys(read(p));
 }
}
const corpus=read(path.join(source,'corpus.json'));
const eligible=corpus.docs.filter(d=>!seen.has(d.key));
const selected=[];
for(const split of ['calibration','test']){
 const group=eligible.filter(d=>(parseInt(hash('company-reference-v1:'+d.company_hash).slice(0,8),16)%2===0?'calibration':'test')===split);
 group.sort((a,b)=>hash('sample-reference-v1:'+a.key).localeCompare(hash('sample-reference-v1:'+b.key)));
 selected.push(...group.slice(0,80).map(d=>({...d,split})));
}
selected.sort((a,b)=>hash('blind-order-v1:'+a.key).localeCompare(hash('blind-order-v1:'+b.key)));
const manifest=selected.map((d,i)=>({id:`S${String(i+1).padStart(3,'0')}`,key:d.key,content_hash:d.content_hash,company_hash:d.company_hash,split:d.split}));
if(selected.length!==160||new Set(selected.map(d=>d.key)).size!==160)throw Error('Invalid sample');
const calCompanies=new Set(manifest.filter(d=>d.split==='calibration').map(d=>d.company_hash));
if(manifest.some(d=>d.split==='test'&&calCompanies.has(d.company_hash)))throw Error('Company leakage');
fs.mkdirSync(out); // Refuse overwrite.
const save=(name,data)=>fs.writeFileSync(path.join(out,name),JSON.stringify(data,null,2),'utf8');
save('protocol.json',{
 version:'codex-reference-cluster-comparison-v1',rows:160,calibration:80,test:80,
 taxonomy,source_corpus_sha256:hash(fs.readFileSync(path.join(source,'corpus.json'))),
 sampling:'Stable SHA sample; exclude earlier discovery naming/audit/noise packets; company-disjoint calibration/test. Conditional on original company-capped 5000 pilot, NOT representative of full database.',
 annotation:'Codex reads only id + complete text used by embeddings. No cluster IDs, topic words, prior names or split in annotation packet. One principal duty, exact supporting quote. Equal mixed duties or insufficient evidence retained explicitly. Same model as earlier reviews, NOT independent human gold or guaranteed blind.',
 mapping:'Each unsupervised cluster gets majority occupational label from calibration ONLY; ties alphabetical, unsupported clusters abstain. Noise always abstains. No label training, no parameter selection by test.',
 metrics:'Held-out mapped classification P/R/F1 and confusion including abstention errors; ARI/AMI pairwise clustering; Hungarian cluster accuracy on test is diagnostic oracle only, not deployable accuracy. Wilson interval for mapped accuracy. No claims on unknown/mixed jobs.',
 comparison:'Predeclared BERTopic primary50_seed42 versus prior KMeans24 on identical sealed 5000 embeddings; rerun BERTopic independently after annotation, verify assignment reproducibility; no annotation input to fit.',
 limitations:'80 test labels only before ambiguity exclusion; per-class small samples; no human double annotation; candidate accuracy not a production acceptance criterion',
 safeguards:'offline, no production writes/restarts, no paid API calls, existing outputs preserved',
 prior_review_keys_excluded:seen.size,remaining_pool:eligible.length
});
save('manifest.json',manifest);
save('blind-packet.json',selected.map((d,i)=>({id:manifest[i].id,text:d.text})));
console.log(JSON.stringify({out,rows:manifest.length,excluded:seen.size,eligible:eligible.length}));
