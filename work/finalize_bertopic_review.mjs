// Experiment-only report. No HTTP calls, production database access, or confirmed labels.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {digest} from './prepare_unsupervised_jobs.mjs';
import {validateReview} from './finalize_discovery_audit.mjs';

const out=path.resolve(process.argv[2]||'ui_data/insights/comparisons/bertopic-codex-20261017-zh-v2');
const read=async n=>JSON.parse(await fs.readFile(path.join(out,n),'utf8'));
const [corpus,clusters,heldout,labels,decisions,seal,summary,noise,noiseDecisions,protocol]=await Promise.all(['corpus.json','clusters.json','heldout-audit.json','codex-cluster-labels.json','codex-audit-decisions.json','naming-seal.json','summary.json','noise-review.json','codex-noise-decisions.json','protocol.json'].map(read));
assert.equal(labels.clustering_sha256,digest(await fs.readFile(path.join(out,'clusters.json'))));
const labelsHash=digest(await fs.readFile(path.join(out,'codex-cluster-labels.json')));
const rows=validateReview({corpus,clusters,heldout,labels,decisions,seal,labelsHash});
const docs=new Map(corpus.docs.map(d=>[d.key,d]));
assert.equal(noiseDecisions.decisions.length,noise.length);assert.equal(new Set(noiseDecisions.decisions.map(d=>d.noise_index)).size,noise.length);
const noiseRows=noiseDecisions.decisions.map(d=>{
 const s=noise[d.noise_index];assert.ok(s&&d.role&&d.judgment);
 assert.equal(s.content_hash,docs.get(s.key).content_hash);
 assert.ok(d.quote.length>=6&&docs.get(s.key).body.includes(d.quote),'Noise quote mismatch '+d.noise_index);
 return {...d,key:s.key,content_hash:s.content_hash,title:s.title,individually_confirmed:false};
});
const byStatus=Object.fromEntries(['candidate','mixed','uncertain'].map(status=>[status,{clusters:labels.labels.filter(l=>l.status===status).length,rows:clusters.cards.filter(c=>labels.labels.some(l=>l.cluster===c.cluster&&l.status===status)).reduce((n,c)=>n+c.rows,0)}]));
const relations=rs=>Object.fromEntries(['aligned','adjacent','different','insufficient'].map(k=>[k,rs.filter(r=>r.relation_to_center===k).length]));
const perCluster=clusters.cards.map(c=>{const l=labels.labels.find(l=>l.cluster===c.cluster);return {cluster:c.cluster,name:l.proposed_name,status:l.status,rows:c.rows,audit:relations(rows.filter(r=>r.cluster===c.cluster)),precision:null,recall:null,F1:null};});
// v1 preflight removed Chinese only in c-TF-IDF. Verify the correction did NOT change any cluster decisions or sample identities.
const preflight=path.join(path.dirname(out),'bertopic-codex-20261017');
const previousCards=JSON.parse(await fs.readFile(path.join(preflight,'clusters.json'),'utf8')).cards;
assert.deepEqual(clusters.cards.map(c=>c.samples),previousCards.map(c=>c.samples));
for(const name of Object.keys(summary.methods))assert.deepEqual(await read(name+'-assignments.json'),JSON.parse(await fs.readFile(path.join(preflight,name+'-assignments.json'),'utf8')));
assert.ok(clusters.cards.some(c=>c.topic_words.some(([word])=>/[\u4e00-\u9fff]/u.test(word))));
const original=path.join(path.dirname(out),'unsupervised-codex-20261017');
const oldCards=JSON.parse(await fs.readFile(path.join(original,'clusters.json'),'utf8')).cards;
const oldAudit=JSON.parse(await fs.readFile(path.join(original,'heldout-audit.json'),'utf8'));
const oldSeen=new Set([...oldCards.flatMap(c=>c.samples.map(s=>s.key)),...oldAudit.map(r=>r.key)]);
const priorOverlap=rows.filter(r=>oldSeen.has(r.key)).length;
const result={version:'bertopic-codex-review-v1',completed_at:new Date().toISOString(),labels_sha256:labelsHash,decision_sha256:digest(await fs.readFile(path.join(out,'codex-audit-decisions.json'))),noise_decision_sha256:digest(await fs.readFile(path.join(out,'codex-noise-decisions.json'))),status:byStatus,reviewed:rows.length,relation_to_center:relations(rows),candidate_cluster_audit:relations(rows.filter(r=>r.cluster_status==='candidate')),prior_review_overlap_rows:priorOverlap,per_cluster:perCluster,noise_review:noiseRows,rows,precision:null,recall:null,F1:null,confirmed_job_labels:0,production_changed:false,paid_api_calls:0,limitation:'same Codex, some samples seen in earlier experiment; descriptive review, not independent or population-weighted occupational evaluation'};
const primary=summary.methods.primary50_seed42,cn={candidate:'宽口径候选',mixed:'混合',uncertain:'待确认'};
const n=v=>v==null?'—':v.toFixed(3);
const lines=[
 '# BERTopic岗位聚类对照实测',
 '',
 '结论：BERTopic官方模块化流程已在同一5,000条真实岗位上跑通，并由Codex完成主实验簇命名及补充审阅；当前不能证明比上一轮KMeans更精准，也不宜替换生产准入。',
 '',
 '## 数据与实际流程',
 '',
 '- 使用数据库版本478的原5,000条封存样本，源库当时共60,042条；标题与职责摘要、公司上限5条及去重方式完全相同，未重新抽取更容易的样本。',
 '- 直接复用上轮Sentence Transformers生成的本地BAAI/bge-small-zh-v1.5归一化512维向量，保留文本与向量SHA256。不是换编码器后宣称BERTopic提升。',
 '- 主流程：缓存的Sentence Transformers向量 → UMAP（15邻居、5维、min_dist=0、cosine、seed42）→ 外部hdbscan实现（最小簇50、min_samples10、EOM）→ 中文分词＋c-TF-IDF → Codex阅读样本给候选名。',
 '- 这不是不加配置的默认BERTopic：复用中文编码器、固定随机种子、采用较大最小簇限制资源，并配置中文分词。未设置固定主题数，未把噪声强行归入主题。',
 `- 版本：BERTopic ${protocol.packages.bertopic}、UMAP ${protocol.packages['umap-learn']}、HDBSCAN ${protocol.packages.hdbscan}；独立venv新增依赖，只读复用既有CPU运行库，未升级原环境。`,
 `- 正式中文配置三轮共 ${summary.seconds_including_imports.toFixed(2)} 秒，主轮 ${primary.seconds.toFixed(2)} 秒；已复用向量，不含上轮 ${summary.prior_embedding_seconds.toFixed(2)} 秒编码、安装、Codex阅读及报告时间。`,
 '',
 '## 固定参数与敏感性结果',
 '',
 '| 实验 | 非噪声簇数 | 噪声条数 | 非噪声覆盖 | 最大簇条数 |',
 '| --- | ---: | ---: | ---: | ---: |',
 ...Object.entries(summary.methods).map(([name,m])=>`| ${name} | ${m.topics} | ${m.noise_rows} | ${(m.coverage*100).toFixed(2)}% | ${m.largest_topic_rows} |`),
 '',
 'primary50_seed42为读样本前固定的主实验；fine25只在相同UMAP空间把最小簇改为25、min_samples改为5；seed43只更改UMAP随机种子。没有按哪个看起来最好来选择命名对象。更细设置出现更多簇，也增加拒分，不能仅凭簇数宣称效果更好。',
 '',
 `seed42与seed43共同非噪声 ${summary.seed_stability.joint_nonnoise_rows} 条上的ARI=${n(summary.seed_stability.ARI_joint_nonnoise)}、AMI=${n(summary.seed_stability.AMI_joint_nonnoise)}；噪声/非噪声状态一致率 ${(summary.seed_stability.outlier_status_agreement*100).toFixed(2)}%。这说明随机种子稳定性，不是98%的岗位分类准确率。`,
 '',
 '## 与上一轮的可比诊断',
 '',
 '上轮KMeans24覆盖100%；PCA30＋sklearn HDBSCAN只有2簇、覆盖50.54%。本轮主实验20簇、覆盖83.56%，提供了更细的拒分式主题结构；这还不是精确率提升。PCA和UMAP、HDBSCAN实现都发生变化，不是单变量消融。',
 '',
 `在相同固定抽样、剔除本轮噪声后的 ${summary.common_diagnostic_silhouette.same_rows} 条上，原512维向量空间余弦轮廓系数：KMeans24=${n(summary.common_diagnostic_silhouette.KMeans24)}，BERTopic主实验=${n(summary.common_diagnostic_silhouette.BERTopic_primary)}。按这个诊断，本轮没有改善原空间分离度；但该指标也不是职业正确率，不足以单独决定优劣。`,
 '',
 '## Codex主实验命名及审阅',
 '',
 `每簇读2中心＋2随机＋2边界，共120条；名称证据校验锁定后，再读每簇2条，共40条。${byStatus.candidate.clusters}个宽口径候选簇共${byStatus.candidate.rows}条，${byStatus.mixed.clusters}个混合簇共${byStatus.mixed.rows}条，${byStatus.uncertain.clusters}个待确认簇共${byStatus.uncertain.rows}条；另有${primary.noise_rows}条保留未分组。成员数不是合格岗位确认数。`,
 '',
 '| 簇ID | 条数 | 候选名称 | 判定 | 另外2条：相符/相邻/不同/不足 |',
 '| --- | ---: | --- | --- | --- |',
 ...perCluster.map(c=>`| ${c.cluster} | ${c.rows} | ${c.name} | ${cn[c.status]} | ${c.audit.aligned}/${c.audit.adjacent}/${c.audit.different}/${c.audit.insufficient} |`),
 '',
 `40条补充样本：相符${result.relation_to_center.aligned}、相邻/兼任${result.relation_to_center.adjacent}、主职责不同${result.relation_to_center.different}、证据不足${result.relation_to_center.insufficient}。相对于中心主职责进行判断，不能用一个含多职业的混合名称让全部样本都算正确。`,
 '',
 `这是同一Codex的定性审阅，其中${priorOverlap}条在上一轮命名或审阅中已见过，不是独立盲测。每簇2条也不足以估计纯度。各簇职业精确率、召回率和F1均保留null，没有独立金标就不报告虚构数值。`,
 '',
 '具体观察：',
 '',
 '- 设备应用/上位机软件、软件应用开发、软件测试形成可解释的宽口径候选，但仍不能确认全簇每个成员。',
 '- 最大IT运维簇940条，代表样本含电工、冶金操作和泵车司机；嵌入式簇含纯硬件和机械结构；测试簇仍有物理试验；产品簇仍有营销、语音评测、检测客服。',
 '- 英文实习形成混合簇，含法务、传播和销售；说明语言和文本风格仍会干扰职业职责分组。',
 '- 仅资格要求、公司宣传及长文摘要的信息不足仍存在。主题词清楚不等于职业准入精确。',
 '',
 '## 噪声不是无效数据',
 '',
 '预先固定的10条噪声样本中能识别出软件研发、数据分析、嵌入式软件、广告投放、招聘交付、DBA等明确职责。不能把822条噪声全部删除，否则会损失有效岗位；这些样本只用于定性发现风险，不估算整体漏检率。',
 '',
 '| 噪声样本 | 识别方向 | 说明 |',
 '| --- | --- | --- |',
 ...noiseRows.map(r=>`| ${r.noise_index} | ${r.role} | ${r.judgment} |`),
 '',
 '## 中文适配修正与安全边界',
 '',
 '预检版本bertopic-codex-20261017发现BERTopic默认英文预处理会在c-TF-IDF前删掉汉字，虽然jieba已配置也无济于事。正式zh-v2指定language=multilingual，保留汉字并用jieba分词。两版三个实验的逐条分组、主实验的120条命名样本均已校验完全一致；只修正主题词表示，没有按审阅结果改成员。预检产物保留以便追溯。',
 '',
 '全流程没有调用DeepSeek或其他外部付费API，没有生产数据库读写，没有服务重启，没有更新生产岗位分类器或洞察统计。原始封存样本及上一轮结果不覆盖。候选成员只带候选/混合/噪声状态，已确认逐条标签为0。',
 '',
 '## 建议',
 '',
 '保留BERTopic作主题探索与辅助标注，不直接替代生产过滤。先改进职责段落准入及非单岗公告识别，再对职责表示、分层聚类做固定独立评测；用独立人工评测集测岗位级P/R/F1及噪声漏检，不能以调参后可读主题或同模型自审冒充质量保证。',
 '',
 '## 文件与复现',
 '',
 '- [固定实验协议及依赖版本](./protocol.json)；[三轮运行指标](./summary.json)',
 '- [Codex簇命名及原文证据](./codex-cluster-labels.json)；[补充审阅与噪声判断](./codex-audit-review.json)',
 '- [候选成员映射（非确认标签）](./candidate-memberships.json)；[名称封存哈希](./naming-seal.json)',
 '- 运行源码：work/run_bertopic_discovery.py；复核源码：work/finalize_bertopic_review.mjs；测试：work/test_bertopic_discovery.py、work/test_bertopic_review.mjs。输出存在时拒绝覆盖，复现需指定新的同级实验目录。',
 '- [BERTopic官方项目](https://github.com/MaartenGr/BERTopic)；[UMAP配置](https://maartengr.github.io/BERTopic/getting_started/dim_reduction/dim_reduction.html)；[中文分词配置](https://maartengr.github.io/BERTopic/getting_started/vectorizers/vectorizers.html)',
 ''
];
await fs.writeFile(path.join(out,'codex-audit-review.json'),JSON.stringify(result,null,2),{flag:'wx'});
await fs.writeFile(path.join(out,'BERTopic岗位聚类对照报告.md'),lines.join('\n'),{flag:'wx'});
console.log(JSON.stringify({status:byStatus,reviewed:rows.length,relations:result.relation_to_center,prior_review_overlap_rows:priorOverlap,production_changed:false}));
