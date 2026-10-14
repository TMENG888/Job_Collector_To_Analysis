// Display-only unsupervised extraction; it never grants admission to a report.
import {extractKeywords} from './keyword-role-matcher.mjs';
const normalize=s=>String(s||'').normalize('NFKC').toLowerCase();
const compact=s=>normalize(s).replace(/\s/g,'');
const headings=/(岗位核心定位|核心工作|核心职责|岗位职责|工作职责|主要职责|工作内容|职位描述|任职要求|职位要求|岗位要求|任职资格|招聘要求|公司介绍|公司简介|关于我们|企业介绍|福利待遇|岗位福利|薪酬福利|key responsibilities|responsibilities|qualifications|requirements|about us|company overview|benefits)/gi;
const noise=/负责|熟悉|掌握|具备|优先|相关|以上|能够|要求|经验|学历|本科|硕士|博士|沟通|团队|学习能力|责任心|待遇|福利|五险|一金|公司|招聘|工作地点|完成|参与|协助|以及|包括|进行|良好|扎实|至少|不限|精通|熟练|了解|理解|主流|skills?|experience|requirements?|responsibilit|proficien|familiar|knowledge|ability|excellent|strong|candidate/i;
const generic=/^(?:业务|场景|开发|设计|维护|优化|管理|建设|实现|系统|平台|技术|工具|应用|服务|需求|工作|模型|数据|工程|分析|处理|使用|支持|目标|任务|and|the|with|for|from|that|this|you|your|our|are|will|have|must|can|able|work|team|using|use|develop|build|design|implement|maintain|data|model|system|platform|service|development|business)$/i;
const fragment=/^(?:人工|智能|仓库|计算|体系|保障|支撑|性能|标准|机制|结构|稳定|动态|验证|应对|策略|搭建|框架|架构|能力|效率|深度|持续|基础|软件|语言|程序|功能|方法|方向|环节|日常|实际|独立|协作|质量|内容|研发|一门|一种|之一|知识|模块|结合|链路|过程|方式|落地|方案|前沿|规范|准确|及时|专业|计算机|计算机科学|软件工程|ai)$/i;
const segmenter=new Intl.Segmenter('zh-CN',{granularity:'word'});
function literalPhrases(text){
 const words=[...segmenter.segment(text)].filter(s=>s.isWordLike),found=new Set();
 for(let i=0;i<words.length;i++)for(let n=2;n<=3&&i+n<=words.length;n++){
  const part=words.slice(i,i+n);if(part.slice(1).some((s,j)=>!/^\s*$/.test(text.slice(part[j].index+part[j].segment.length,s.index))))continue;
  const phrase=text.slice(part[0].index,part.at(-1).index+part.at(-1).segment.length);
  if(!/[\u4e00-\u9fff]/.test(phrase)||phrase.length<4||phrase.length>12||noise.test(phrase)||/^\d|\d$/.test(phrase))continue;
  // Keep a technical noun phrase such as 数据仓库 or 人工智能, but not a
  // concatenation made entirely from generic verbs/nouns.
  if(part.every(s=>generic.test(s.segment)||fragment.test(s.segment))&&!/数据仓库|数据模型|数据管道|数据治理|数据质量|数据采集|人工智能|大模型|智能体|工具调用|工作流|机器学习|深度学习/.test(phrase))continue;
  found.add(normalize(phrase));
 }return found;
}
export function cloudSections(row){
 const text=String(row['岗位描述']||'');let cursor=0,location='正文';const parts=[];
 for(const m of text.matchAll(headings)){parts.push({location,text:text.slice(cursor,m.index)});location=/公司|企业|关于我们|福利|薪酬|about us|company overview|benefits/i.test(m[0])?'排除':/要求|资格|qualifications|requirements/i.test(m[0])?'任职要求':'职责';cursor=m.index+m[0].length;}
 parts.push({location,text:text.slice(cursor)});
 return parts.filter(p=>p.location!=='排除').flatMap(p=>p.text.split(/[\n。；;]/).map(quote=>({location:p.location,quote:quote.trim()}))).filter(p=>p.quote&&!/^(?:公司|我们)(?:成立|是|致力于)|^(?:薪资|待遇|福利|五险)/.test(p.quote));
}
export function buildGenericKeywordCloud(rows,family,{seedRows,limit=100}={}){
 limit=Math.max(1,Math.min(100,limit));
 const ids=seedRows?new Set(seedRows):null,seen=new Set();
 const prepared=rows.map(row=>({...row,sections:cloudSections(row)})).map(row=>({...row,'岗位描述':row.sections.map(s=>s.quote).join('\n')}));
 const accepted=prepared.filter(r=>ids?ids.has(r.row_no):family.title.test(String(r['岗位名称']||''))).filter(r=>{const key=compact(r['岗位描述']);if(!key||seen.has(key))return false;seen.add(key);return true;});
 if(accepted.length<5)return null;
 const minimum=Math.max(2,Math.ceil(accepted.length*.005));
 const tfidf=extractKeywords(accepted,prepared,[],'tfidf',5000),rank=extractKeywords(accepted,prepared,[],'textrank',5000);
 const terms=new Map();
 for(const list of [tfidf,rank])list.forEach((t,i)=>{if(t.seed_df<minimum||noise.test(t.term)||generic.test(t.term)||fragment.test(t.term)||t.term.length>20||/^\d/.test(t.term))return;const key=compact(t.term),entry=terms.get(key)||{...t,rank_weight:0};entry.rank_weight+=1/(61+i);terms.set(key,entry);});
 const backgroundPhrases=new Map(),seedPhrases=new Map();
 for(const r of prepared)for(const phrase of literalPhrases(r['岗位描述']))backgroundPhrases.set(phrase,(backgroundPhrases.get(phrase)||0)+1);
 for(const r of accepted)for(const phrase of literalPhrases(r['岗位描述']))seedPhrases.set(phrase,(seedPhrases.get(phrase)||0)+1);
 for(const [term,seed_df] of seedPhrases){if(seed_df<minimum||fragment.test(term)||terms.has(compact(term)))continue;const background_df=backgroundPhrases.get(term)||0;terms.set(compact(term),{term,seed_df,background_df,rank_weight:0,score:seed_df/accepted.length*(Math.log((prepared.length+1)/(background_df+1))+1)});}
 // Preserve literal multi-word / punctuation-bearing technical names. Never
 // synthesize C++, .NET or English phrases by deleting intervening words.
 const english=new Map();
 for(const row of accepted){const local=new Map();for(const s of row.sections){const matches=[...s.quote.matchAll(/[A-Za-z][A-Za-z0-9]*(?:[.+#/-][A-Za-z0-9]*)*/g)];for(let i=0;i<matches.length;i++)for(let n=1;n<=3&&i+n<=matches.length;n++){
  const span=matches.slice(i,i+n);if(span.some(m=>noise.test(m[0])||generic.test(m[0])||fragment.test(m[0])||m[0].length<2))continue;
  if(span.slice(1).some((m,j)=>!/^\s+$/.test(s.quote.slice(span[j].index+span[j][0].length,m.index))))continue;
  const name=s.quote.slice(span[0].index,span.at(-1).index+span.at(-1)[0].length);if(name.length>32)continue;
  local.set(compact(name),name);
 }}for(const [key,name] of local){const entry=english.get(key)||{term:name,seed_df:0};entry.seed_df++;english.set(key,entry);}}
 const docs=prepared.map(r=>normalize(r['岗位描述']));
 for(const [key,t] of english){if(t.seed_df<minimum||terms.has(key))continue;const escaped=normalize(t.term).replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/\s+/g,'\\s+'),pattern=new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`,'i');const background_df=docs.filter(d=>pattern.test(d)).length;terms.set(key,{...t,background_df,score:t.seed_df/accepted.length*(Math.log((prepared.length+1)/(background_df+1))+1),rank_weight:0});}
 const candidates=[...terms.values()].map(t=>({...t,score:t.score*(1+10*t.rank_weight)*(/[\u4e00-\u9fff]/.test(t.term)&&t.term.length>=4?1.35:1),category:/[a-z]/i.test(t.term)?'技术/原文术语':'职责/原文短语'})).sort((a,b)=>b.score-a.score||a.term.localeCompare(b.term));
 // Suppress a lexical fragment only when the longer phrase has almost the
 // same document coverage. A frequent standalone stack remains large.
 const selected=candidates.filter(t=>!candidates.some(o=>o!==t&&compact(o.term).includes(compact(t.term))&&o.term.length>t.term.length&&o.seed_df>=t.seed_df*.9&&o.score>=t.score*.8)).slice(0,limit);
 return {version:'keyword-cloud-generic-v2',profile:'generic',method:'TF-IDF＋TextRank短语融合（仅展示）',seed_rows:accepted.length,minimum_seed_df:minimum,source_scope:ids?'主报告纳入记录':'标题种子（仅展示）',policy:'职责和任职要求提词；公司福利排除；正文去重计文档频次；英文原文边界；不改变岗位筛选，不足不凑数',terms:selected.flatMap(t=>{const r=accepted.find(r=>r.sections.some(s=>compact(s.quote).includes(compact(t.term))));if(!r)return [];const section=r.sections.find(s=>compact(s.quote).includes(compact(t.term)));return [{...t,name:t.term,seed_count:t.seed_df,used_for_filter:false,evidence:{row_no:r.row_no,title:r['岗位名称'],quote:section.quote,location:section.location}}];})};
}
