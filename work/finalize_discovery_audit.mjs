// Validate manually authored Codex review; write experiment artifacts, never production labels.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {digest} from './prepare_unsupervised_jobs.mjs';

export function validateReview({corpus,clusters,heldout,labels,decisions,seal,labelsHash}) {
  assert.equal(labelsHash,seal.labels_sha256,'Sealed names changed after audit');
  assert.equal(seal.production_published,false);
  const docs=new Map(corpus.docs.map(d=>[d.key,d]));
  const reps=new Set(clusters.cards.flatMap(c=>c.samples.map(s=>s.key)));
  assert.equal(decisions.decisions.length,heldout.length);
  assert.equal(new Set(decisions.decisions.map(d=>d.audit_index)).size,heldout.length);
  const names=new Map(labels.labels.map(l=>[l.cluster,l]));
  const reviewed=decisions.decisions.map(d=>{
    assert.ok(Number.isInteger(d.audit_index)&&d.audit_index>=0&&d.audit_index<heldout.length);
    const h=heldout[d.audit_index],doc=docs.get(h.key),label=names.get(h.cluster);
    assert.ok(doc&&label);assert.equal(d.cluster,h.cluster);
    assert.equal(h.content_hash,doc.content_hash);assert.ok(!reps.has(h.key));
    assert.ok(['aligned','adjacent','different','insufficient'].includes(d.relation_to_center));
    assert.ok(d.role&&d.reason);
    assert.ok(d.quote.length>=6&&doc.body.includes(d.quote),'Audit quote mismatch at '+d.audit_index);
    return {...d,key:h.key,content_hash:h.content_hash,title:h.title,candidate_cluster_name:label.proposed_name,cluster_status:label.status,individually_confirmed:false};
  });
  for(const c of clusters.cards)assert.equal(reviewed.filter(d=>d.cluster===c.cluster).length,2);
  return reviewed;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  await main();
}

async function main(){
 const out=path.resolve(process.argv[2]||'ui_data/insights/comparisons/unsupervised-codex-20261017');
 const read=async n=>JSON.parse(await fs.readFile(path.join(out,n),'utf8'));
 const [corpus,clusters,heldout,labels,decisions,seal,summary]=await Promise.all(['corpus.json','clusters.json','heldout-audit.json','codex-cluster-labels.json','codex-audit-decisions.json','naming-seal.json','summary.json'].map(read));
 const labelsHash=digest(await fs.readFile(path.join(out,'codex-cluster-labels.json')));
 assert.equal(labels.clustering_sha256,digest(await fs.readFile(path.join(out,'clusters.json'))));
 const reviewed=validateReview({corpus,clusters,heldout,labels,decisions,seal,labelsHash});
 const countRelations=rows=>Object.fromEntries(['aligned','adjacent','different','insufficient'].map(k=>[k,rows.filter(d=>d.relation_to_center===k).length]));
 const status=Object.fromEntries(['candidate','mixed','uncertain'].map(k=>[k,{clusters:labels.labels.filter(l=>l.status===k).length,rows:clusters.cards.filter(c=>labels.labels.some(l=>l.cluster===c.cluster&&l.status===k)).reduce((n,c)=>n+c.rows,0)}]));
 const result={version:'codex-discovery-review-v1',completed_at:new Date().toISOString(),labels_sha256:labelsHash,audit_decisions_sha256:digest(await fs.readFile(path.join(out,'codex-audit-decisions.json'))),source_revision:corpus.protocol.revision,status,reviewed:reviewed.length,relation_to_center:countRelations(reviewed),candidate_cluster_audit:countRelations(reviewed.filter(d=>d.cluster_status==='candidate')),confirmed_job_labels:0,paid_external_model_calls:0,production_changed:false,limitations:['Same Codex names and audits; no independent human gold.','Two held-out samples per cluster are not a population-weighted precision/recall evaluation.','Broad candidate families are not exact occupation or subrole labels.','Company cap and duty dedup alter source distribution.'],rows:reviewed};
 const statusCN={candidate:'宽口径候选',mixed:'混合，不传播',uncertain:'待确认，不传播'};
 const lines=[
 '# 岗位无监督聚类＋Codex簇命名试验',
 '',
 '结论：流程已跑通，但当前聚类不能直接替代生产岗位筛选。Codex能辅助命名并发现混合簇；给簇起名不能使其内部自动变纯。生产标签、分类器和洞察结果未修改，外部付费模型调用为0。',
 '',
 '## 数据与执行',
 '',
 `- 数据库只读快照版本 ${corpus.protocol.revision}：${summary.source_rows.toLocaleString('en-US')} 条，职责文本长度等基础准入后 ${corpus.protocol.eligible_rows.toLocaleString('en-US')} 条；抽取 ${summary.sampled_rows.toLocaleString('en-US')} 条。`,
 '- 按稳定SHA顺序抽样、规范化职责全文精确去重，每公司最多5条；不是按总体分布加权的随机样本。未使用旧岗位标签、查询关键词、城市、薪资、公司、技能标签作为聚类特征。',
 '- 本地原版 BAAI/bge-small-zh-v1.5，512维；标题最多60字符＋职责长文的头/中/尾摘要。CPU两线程、batch8；离线执行，没有下载或调用DeepSeek。',
 `- 实测聚类流程 ${summary.total_seconds.toFixed(2)} 秒，其中向量编码 ${summary.embedding_seconds.toFixed(2)} 秒；不含Codex人工式阅读命名、审阅及报告时间。最长输入 ${summary.max_input_tokens} tokens，未静默截断。`,
 '- 每簇命名阅读2条中心、2条随机、2条边界，共144条；名称及证据通过校验并锁定后，再读每簇2条不重合随机样本，共48条。JD文字按不可信数据处理，不执行其中指令。',
 '',
 '## 两种算法的实际结果',
 '',
 '| 方法 | 簇数 | 噪声 | 非噪声覆盖 | 抽样余弦轮廓系数 |',
 '| --- | ---: | ---: | ---: | ---: |',
 `| KMeans，预设K=24 | 24 | 0 | 100% | ${summary.methods.kmeans.cosine_silhouette_sample1000_excluding_noise.toFixed(3)} |`,
 `| PCA30＋HDBSCAN，最小簇50、min_samples10 | 2 | 2,473条 | 50.54% | ${summary.methods.hdbscan.cosine_silhouette_sample1000_excluding_noise.toFixed(3)} |`,
 '',
 '参数先固定再运行，没有按命名结果挑选最优参数。HDBSCAN未达到预设“至少4簇且覆盖至少30%”的命名条件，故审阅KMeans24；这是操作启发式，不是证明KMeans更准确。HDBSCAN剔除约一半样本、只形成两个粗簇，其较高轮廓系数不可直接与全覆盖KMeans解释为职业分类准确率。本试验没有运行BERTopic。',
 '',
 '## Codex命名结果',
 '',
 `4个宽口径候选簇，共${status.candidate.rows}条；19个混合簇，共${status.mixed.rows}条；1个待确认簇，共${status.uncertain.rows}条。条数是簇成员数，不是已确认合格岗位数。已确认逐条岗位标签为0。`,
 '',
 '| 簇ID | 成员数 | 候选名称 | 判定 |',
 '| --- | ---: | --- | --- |',
 ...clusters.cards.map(c=>{const l=labels.labels.find(x=>x.cluster===c.cluster);return `| ${c.cluster} | ${c.rows} | ${l.proposed_name} | ${statusCN[l.status]} |`;}),
 '',
 '## 锁名后补充审阅',
 '',
 '由同一Codex根据职责摘录判断相对该簇前两条中心样本的关系：相符、相邻/兼任、主职责不同、证据不足。不是用“混合”名称把所有成员解释成匹配，也没有用补充样本改写已经锁定的名称。此审阅口径不是预注册统计评测。',
 '',
 `48条中：相符${result.relation_to_center.aligned}、相邻/兼任${result.relation_to_center.adjacent}、主职责不同${result.relation_to_center.different}、证据不足${result.relation_to_center.insufficient}。`,
 `4个候选簇的另外8条样本中：相符${result.candidate_cluster_audit.aligned}、相邻/兼任${result.candidate_cluster_audit.adjacent}、主职责不同${result.candidate_cluster_audit.different}、证据不足${result.candidate_cluster_audit.insufficient}。每簇仅2条，且同一模型复核，不可据此宣称纯度、精确率或召回率达标。`,
 '',
 '发现的具体风险：',
 '',
 '- 电商运营簇混入跨境会计；测试簇混入金属材料和力学试验；嵌入式簇混入纯电子硬件；AI应用簇混入用AI工具制作视频的内容岗。行业、技能和工具相同，不代表同一主职责。',
 '- 英文/双语样本形成混合簇，包含IT、广告、销售、理化质检；提示语言形式也可能影响向量分组。',
 '- 部分资格条件、公司福利、泛校招公告通过基础长度准入；标题或公司背景不能代替职责证据。须提升职责段落识别和非单岗公告准入，不能把本轮结果隐瞒为清洁训练集。',
 '- 标题“销售工程师”的一条补充样本实际主要做订单、合同、物流及回款辅助；需要按职责标为销售支持。另有英文测试实习JD写2023届，岗位时效需单独治理。',
 '',
 '## 如何用于后续DeepSeek标注',
 '',
 '本轮产物只进入实验候选目录。下一阶段先加强职责/公告准入，再做分层聚类与职责专门化表示的对照；混合簇拆分后重新抽样命名，保留待确认和噪声。每个新版本保留内容哈希与模型版本。',
 '',
 '之后DeepSeek可沿用同一JSON提示合同：主职责、候选岗位族、各样本角色、混合判定、原文证据和拆分建议。进入生产前需人工独立标注随机与困难样本，按岗位分别评估精确率、召回率、覆盖率；候选簇成员不可直接全量当作监督训练金标。',
 '',
 '## 复核文件',
 '',
 '- [簇命名与逐样本职责](./codex-cluster-labels.json)',
 '- [补充样本审阅与证据](./codex-audit-review.json)',
 '- [候选成员映射：非确认标签](./candidate-memberships.json)',
 '- [固定实验协议](./protocol.json)；[算法运行统计](./summary.json)；[锁名哈希](./naming-seal.json)',
 '- 仓库内提示合同：docs/聚类岗位命名提示词模板.md；实验源码：work/prepare_unsupervised_jobs.mjs、work/cluster_unsupervised_jobs.py、work/finalize_discovery_labels.mjs、work/finalize_discovery_audit.mjs。',
 '',
 '这是一个5,000条的探索性试验，不是数据库全量职业标注。没有精确率/召回率的独立金标对照，未更换生产TF-IDF＋逻辑回归或其他岗位准入方案。',
 ''
 ];
 await fs.writeFile(path.join(out,'codex-audit-review.json'),JSON.stringify(result,null,2),{flag:'wx'});
 await fs.writeFile(path.join(out,'聚类命名试验报告.md'),lines.join('\n'),{flag:'wx'});
 console.log(JSON.stringify({status,reviewed:result.reviewed,relation_to_center:result.relation_to_center,candidate_cluster_audit:result.candidate_cluster_audit,production_changed:false}));
}
