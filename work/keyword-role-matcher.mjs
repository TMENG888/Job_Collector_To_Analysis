// Offline keyword selection and deterministic, auditable inference. No platform calls.
import crypto from 'node:crypto';
const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
const stop = new Set('岗位 工作 负责 完成 参与 协助 公司 相关 要求 任职 优先 熟悉 掌握 能力 经验 本科 以上 学历 专业 团队 使用 具备 良好 实习 实习生 内容 技术 工具 模型 数据 项目 学习 支持 优化 流程 进行 输出 以及 包括 等 设计 制作 创作 ai aigc'.split(' '));
for (const term of '业务 场景 应用 落地 持续 基于 迭代 智能 知识 方案 产品 平台 系统 开发 工程师 客户 服务 需求 实现 建设 管理 维护 解决 结合 提升 推动 核心 领域 实际 问题 高效 负责 任务 日常 其他 各类 不断 通过 对接 协作 沟通 质量 效果 方向 规划 工作职责 岗位职责 任职要求 职位要求'.split(' ')) stop.add(term);
const clean = s => String(s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
export const reviewKey = row => `${row['平台']}:${row['岗位ID']}:${crypto.createHash('sha256').update([row['岗位名称'],row['岗位描述']].map(clean).join('\n')).digest('hex')}`;

export function dutiesOf(row) {
  const jd = String(row['岗位描述'] || '');
  const start = jd.search(/岗位职责|工作职责|主要职责|主要工作职责|工作内容|工作任务|你会参与的工作|你将参与|你要做的|你将参与的工作/);
  let body = start >= 0 ? jd.slice(start) : jd;
  const end = body.search(/任职要求|职位要求|岗位要求|任职资格|岗位任职|我们希望你|我们希望找到|我们需要你|招聘要求|基础要求|岗位福利|福利待遇/);
  if (end >= 0) body = body.slice(0, end);
  return body;
}

export function productionEvidence(row) {
  const body = dutiesOf(row);
  const sentences = body.split(/[\n。；;]/).map(s => s.trim()).filter(Boolean);
  return sentences.filter(s => {
    if (!/短剧|漫剧|分镜|剧本|成片|视频|镜头|动画|短片|宣传片/.test(s)) return false;
    if (!/制作|创作|剪辑|撰写|拍摄|生成|产出|绘制|设计|编写|执导|导演/.test(s)) return false;
    // Describing/assessing a model's output is not producing a film.
    if (/标注|质检|评测|训练数据|模型训练|算法研发|数据集|架构|准入标准|工具清单/.test(s) && !/制作.{0,16}成片|剪辑.{0,16}成片|独立.{0,12}(?:创作|制作)|撰写.{0,12}(?:剧本|分镜)|剧本.{0,12}撰写/.test(s)) return false;
    if (/公司简介|公司介绍|我们是|致力于|服务全球/.test(s)) return false;
    return true;
  });
}

export function tokensOf(source) {
  const words = [...segmenter.segment(String(source || '').normalize('NFKC').toLowerCase())]
    .filter(x => x.isWordLike).map(x => x.segment).filter(x => x.length >= 2 && !stop.has(x) && !/^\d+$/.test(x));
  // Single lexical terms and contiguous lexical phrases, not whitespace-independent character fragments.
  const terms = [...words];
  const normalized = clean(source);
  for (let i=0;i<words.length;i++) for (let n=2;n<=3;n++) {
    const phrase = words.slice(i,i+n).join('');
    if (i+n<=words.length && phrase.length<=12 && normalized.includes(phrase)) terms.push(phrase);
  }
  return { words, terms };
}

export function extractKeywords(seeds, background, negatives, algorithm, limit) {
  const documents = background.map(r => new Set(tokensOf(dutiesOf(r)).terms));
  const seedDocs = seeds.map(r => tokensOf(dutiesOf(r)));
  const negativeDocs = negatives.map(r => new Set(tokensOf(dutiesOf(r)).terms));
  // Compute document frequencies once rather than rescanning every document
  // for each candidate term when processing full task datasets.
  const documentFrequency = new Map(), negativeFrequency = new Map();
  for (const doc of documents) for (const term of doc) documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
  for (const doc of negativeDocs) for (const term of doc) negativeFrequency.set(term, (negativeFrequency.get(term) || 0) + 1);
  const counts = new Map();
  for (const doc of seedDocs) for (const term of new Set(doc.terms)) counts.set(term,(counts.get(term)||0)+1);
  const candidates = [...counts].filter(([,n])=>n>=2);
  let centrality = new Map();
  if (algorithm === 'textrank') {
    const graph = new Map();
    for (const doc of seedDocs) for(let i=0;i<doc.words.length;i++) for(let j=i+1;j<Math.min(i+5,doc.words.length);j++) {
      const a=doc.words[i],b=doc.words[j]; if(a===b)continue;
      if(!graph.has(a))graph.set(a,new Set());if(!graph.has(b))graph.set(b,new Set());
      graph.get(a).add(b);graph.get(b).add(a);
    }
    centrality=new Map([...graph.keys()].map(x=>[x,1]));
    for(let i=0;i<40;i++) centrality=new Map([...graph].map(([a,edges])=>[a,0.15+0.85*[...edges].reduce((sum,b)=>sum+(centrality.get(b)||0)/graph.get(b).size,0)]));
  }
  return candidates.map(([term,df])=>{
    const globalDf=documentFrequency.get(term)||0;
    const negDf=negativeFrequency.get(term)||0;
    const idf=Math.log((documents.length+1)/(globalDf+1))+1;
    let score=df/seeds.length*idf;
    if(algorithm==='contrast') score=Math.log(((df+0.5)/(seeds.length-df+0.5))/((negDf+0.5)/(negativeDocs.length-negDf+0.5)))*df/seeds.length;
    if(algorithm==='textrank') score=[...segmenter.segment(term)].filter(x=>x.isWordLike).reduce((s,x)=>s+(centrality.get(x.segment)||0),0)/Math.max(1,term.length/2)*df/seeds.length;
    return {term,score:Number(score.toFixed(6)),seed_df:df,background_df:globalDf,negative_df:negDf};
  }).filter(x=>x.score>0).sort((a,b)=>b.score-a.score||a.term.localeCompare(b.term)).slice(0,limit);
}

export function matchKeywordRole(row, model, {applyReviewedLabels=false}={}) {
  const duties=dutiesOf(row), normalized=clean(duties);
  const hits=(model.keywords||[]).filter(x=>normalized.includes(clean(x.term)));
  // Avoid counting a keyword and its longer variant as two independent signals.
  const independent=hits.filter(x=>!hits.some(y=>y.term!==x.term && clean(y.term).includes(clean(x.term))));
  const quotes=productionEvidence(row);
  let accepted=independent.length>=model.minimum_hits;
  let strong=false;
  if(model.algorithm==='hybrid') {
    const target=/短剧|漫剧/.test(String(row['岗位名称']||'')) && quotes.length>0;
    const direct=/AI\s*(?:短剧|漫剧)|AIGC\s*(?:短剧|漫剧)|漫剧/.test(duties);
    strong=target||direct&&quotes.length>0;
    accepted=strong||accepted;
  }
  if(model.require_production && !quotes.length) accepted=false;
  const reviewed=applyReviewedLabels ? model.reviewed_overrides?.[reviewKey(row)] : null;
  if(reviewed) accepted=reviewed.label==='include';
  const result={matched:accepted,method:reviewed?'同源逐条审核结论':'验证选型：'+model.display_name,confidence_band:reviewed?'AI原文审核（待人工验收）':'规则证据（非概率）',
    reasons:accepted?[strong?'目标岗位业务词与制作职责':'学习关键词与制作职责联合命中']:[],
    topic_matches:independent.map(x=>x.term),joint_evidence:accepted?{skills:independent.slice(0,8).map(x=>({name:x.term,keyword:x.term,quote:duties.split(/[\n。]/).find(s=>clean(s).includes(clean(x.term)))||''})),tasks:quotes.slice(0,3).map(quote=>({name:'实际制作职责',keyword:'职责原文',quote}))}:null,
    keyword_evidence:{hits:independent.map(x=>x.term),production_quotes:quotes.slice(0,3),strong_match:strong,model_version:model.version,reviewed_label:reviewed?.label||null,reviewed_reason:reviewed?.reason||null}};
  if(reviewed)result.reasons=[reviewed.reason];
  return result;
}
