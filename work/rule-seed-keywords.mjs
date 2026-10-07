import crypto from 'node:crypto';
import {dutiesOf, extractKeywords, matchKeywordRole} from './keyword-role-matcher.mjs';

const normalize=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu,'');
const digest=s=>crypto.createHash('sha256').update(s).digest('hex');
export const datasetFingerprint=rows=>digest(rows.map(r=>[r['平台'],r['岗位ID'],normalize(r['岗位名称']),normalize(r['岗位描述'])].join('|')).sort().join('\n'));

export function titleExcluded(row) {
  const title=String(row['岗位名称']||'');
  if (/标注|评测|训练师|数据处理|数据训练|模型训练|算法|运维|架构|研发|技术支持|技术支撑|办公|生态经理|测试/.test(title)) return true;
  return /产品经理|产品实习|法务|合规|律师/.test(title);
}

export function ruleProductionEvidence(row) {
  const body=dutiesOf(row).split(/任职条件|工作要求|基本要求|任职资格|岗位资格/)[0];
  return body.split(/[\n。；;]/).map(x=>x.trim()).filter(s=>{
    if(/公司简介|公司介绍|我们是|致力于|服务全球/.test(s))return false;
    if(/标注|质检|评测|训练数据|模型训练|算法研发|数据集|架构|准入标准|工具清单|质量评估|评估标准|效果比对|评估结论|工具产品|功能模块|维护|归档|备份|格式转换|测试报告|合规筛查|版权归属|素材授权链|内容合规风控/.test(s))return false;
    return /(?:制作|创作|剪辑|拍摄|绘制|编写|撰写|执导|导演).{0,24}(?:视频|短剧|漫剧|动画|剧本|分镜|成片|镜头|短片)|(?:视频|短剧|漫剧|动画|剧本|分镜|成片|镜头|短片).{0,24}(?:制作|创作|剪辑|拍摄|绘制|编写|撰写|执导)/.test(s)
      || /生成.{0,12}(?:视频|镜头|画面|素材)|(?:视频|镜头|画面|素材).{0,12}生成/.test(s);
  });
}

export function strictRuleSeed(row) {
  const title=String(row['岗位名称']||'').normalize('NFKC');
  const target=/(?:AI|AIGC)\s*(?:短剧|漫剧)|漫剧/i.test(title);
  const creative=/制作|创作|剪辑|编导|导演|编剧|生成|分镜|后期|编辑|主编|抽卡|绘图/.test(title)
    || /(?:AI|AIGC)\s*漫剧(?:师|实习生)/i.test(title);
  return target && creative && !titleExcluded(row) && ruleProductionEvidence(row).length>0;
}

// This partition depends only on company identity and JD text, never labels.
export function unlabeledGroups(rows) {
  const parent=rows.map((_,i)=>i),find=i=>parent[i]===i?i:parent[i]=find(parent[i]);
  const union=(a,b)=>{a=find(a);b=find(b);if(a!==b)parent[b]=a;};
  const companySeen=new Map(),jdSeen=new Map(),prefixSeen=new Map();
  const identities=[];
  rows.forEach((r,i)=>{
    const company=normalize(r['公司名称'])||`${r['平台']}:${r['公司ID']||r['岗位ID']||i}`;
    const jd=normalize(r['岗位描述']),id=company+'|'+digest(jd);
    identities.push(id);
    if(companySeen.has(company))union(i,companySeen.get(company));else companySeen.set(company,i);
    if(jd.length>40){if(jdSeen.has(jd))union(i,jdSeen.get(jd));else jdSeen.set(jd,i);}
    // Conservative prefix grouping protects common copied opening paragraphs.
    if(jd.length>160){const prefix=jd.slice(0,160);if(prefixSeen.has(prefix))union(i,prefixSeen.get(prefix));else prefixSeen.set(prefix,i);}
  });
  const reps=new Map();
  rows.forEach((_,i)=>{const g=find(i);if(!reps.has(g)||identities[i]<reps.get(g))reps.set(g,identities[i]);});
  return rows.map((_,i)=>digest(reps.get(find(i))));
}

export function learnRuleSeedModel(rows, settings={}) {
  const algorithm=settings.algorithm||'tfidf';
  if(!['tfidf','textrank','fusion'].includes(algorithm))throw Error('规则种子模式仅支持TF-IDF、TextRank及两者融合');
  const topK=settings.top_k??40,minimum_hits=settings.minimum_hits??2;
  if(!Number.isInteger(topK)||topK<5||topK>100||!Number.isInteger(minimum_hits)||minimum_hits<1||minimum_hits>5)throw Error('规则种子关键词参数无效');
  const groups=unlabeledGroups(rows);
  const training=rows.filter((r,i)=>parseInt(groups[i].slice(0,8),16)%10<6);
  const candidates=rows.filter(strictRuleSeed);
  const seen=new Set();
  const seeds=training.filter(strictRuleSeed).sort((a,b)=>digest(normalize(a['岗位描述'])).localeCompare(digest(normalize(b['岗位描述']))))
    .filter(r=>{const i=rows.indexOf(r),group=groups[i];if(seen.has(group))return false;seen.add(group);return true;}).slice(0,32);
  let keywords=[];
  if(seeds.length>=5) {
    if(algorithm==='fusion') {
      const a=extractKeywords(seeds,training,[],'tfidf',100),b=extractKeywords(seeds,training,[],'textrank',100),merged=new Map();
      for(const list of [a,b])list.forEach((x,i)=>{const old=merged.get(x.term)||{...x,score:0};old.score+=1/(60+i+1);merged.set(x.term,old);});
      keywords=[...merged.values()].sort((a,b)=>b.score-a.score||a.term.localeCompare(b.term)).slice(0,topK);
    } else keywords=extractKeywords(seeds,training,[],algorithm,topK);
  }
  const names={tfidf:'规则种子＋TF-IDF',textrank:'规则种子＋TextRank',fusion:'规则种子＋TF-IDF/TextRank融合'};
  return {version:'ai-drama-rule-seed-v2',family:'AI漫剧创作',algorithm,display_name:names[algorithm],top_k:topK,minimum_hits,require_production:true,
    keywords,seed_source:'标题和制作职责规则自动选取，不使用审核标签或负样本',rule_seed_candidates:candidates.length,
    training_seed_rows:seeds.map(r=>r.row_no),training_background_rows:training.length,dataset_fingerprint:datasetFingerprint(rows),
    cold_start:seeds.length<5,scope:'AI短剧/漫剧及实际承担AI视频创作、剧本分镜、剪辑成片的相邻岗位',
    selection_policy:'规则自动选种子；按公司、精确重复JD和相同160字前缀分组，60%组用于提词；每组最多一条，最多32条；不足5条时不做关键词扩展，只保留严格规则命中'};
}

export function matchRuleSeedRole(row, model) {
  const direct=strictRuleSeed(row);
  const result=matchKeywordRole(row,model); // no reviewed overrides in this workflow
  const quotes=ruleProductionEvidence(row);
  result.matched=result.keyword_evidence.hits.length>=model.minimum_hits&&quotes.length>0;
  if(direct){result.matched=true;result.method='严格标题与制作职责规则命中';result.reasons=['目标创作岗位标题','实际制作职责原文'];}
  else if(titleExcluded(row)){result.matched=false;result.reasons=['标题为非创作职能，扩展排除'];result.joint_evidence=null;}
  result.keyword_evidence={...result.keyword_evidence,production_quotes:quotes.slice(0,3),rule_seed:direct,reviewed_label:null,reviewed_reason:null};
  if(result.matched) result.joint_evidence={skills:result.joint_evidence?.skills||[],tasks:quotes.slice(0,3).map(quote=>({name:'实际制作职责',keyword:'制作动作与产出对象',quote}))};
  else {result.joint_evidence=null;if(!titleExcluded(row))result.reasons=[quotes.length?'独立关键词命中不足':'缺少实际制作职责原文'];}
  return result;
}
