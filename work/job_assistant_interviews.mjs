import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {roleFamilies} from './job_knowledge_schema.mjs';
import {analyzeInterviewPosts} from './interview_influence.mjs';
import {redactPersonalInfo} from './job_decision_assistant.mjs';
import {toolError} from './job_agent_task.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex').slice(0,24);
const norm=value=>String(value||'').normalize('NFKC').toLowerCase().replace(/\s+/g,'');
const topics=[['RAG与检索',/\bRAG\b|检索增强|向量(?:库|数据库|检索)|chunk|重排|rerank/i],['Agent编排与工具',/\bAgent\b|智能体|LangGraph|LangChain|Function.?Calling|工具调用|\bMCP\b/i],['提示词与输出校验',/Prompt|提示词|结构化输出|JSON|幻觉/i],['模型训练与微调',/微调|\bSFT\b|\bLoRA\b|\bGRPO\b|\bDPO\b|预训练/i],['评测与工程落地',/评测|评估|验收|延迟|成本|并发|部署|Docker|FastAPI/i],['Python基础',/Python|深浅拷贝|装饰器|生成器|协程|GIL/i],['数据库与SQL',/\bSQL\b|MySQL|PostgreSQL|Redis|数据库|索引/i],['算法与数据结构',/算法题|手撕|数组|链表|二叉树|动态规划|公共前缀/i],['项目与个人贡献',/项目|个人负责|个人贡献|技术选型/i]];

export const isInterviewQuestion=message=>/面经|面试|笔试|牛客|(?:高频|常问|常考|会问|考察).{0,12}(?:问题|题目|考点|什么)|(?:问哪些|问什么|哪些).{0,6}(?:题|高频问题)/.test(String(message||''));
export const interviewOnlyIndex={cacheKey:'interview-only',report:{knowledge:true,role:'岗位与面经知识库',roles:roleFamilies.map(f=>f.name),generated_at:'interview-only'},jobs:[],skills:[]};

export function interviewQueryScope(base,args={}){
  if(args.query!=null&&(typeof args.query!=='string'||args.query.length>500))throw toolError('TOOL_INVALID_ARGUMENTS','面经检索词最多500字。');
  const roles=args.roles||base.roles||[];
  if(!Array.isArray(roles)||roles.length>4||roles.some(r=>typeof r!=='string'||!roleFamilies.some(f=>f.name===r)))throw toolError('TOOL_INVALID_SCOPE','请指定1–4个支持的面经岗位方向。');
  if(base.roles?.length&&roles.some(r=>!base.roles.includes(r)))throw toolError('TOOL_SCOPE_MISMATCH','面经检索超出本轮岗位方向，请按当前范围查询。',{field:'roles',confirmed:base.roles});
  return {...base,roles};
}

function questions(content){
  return [...new Set(String(content||'').split(/\n+/).map(line=>line.trim()).filter(line=>line.length>=4&&line.length<=420&&(/[？?]|如何|怎么|为什么|区别|原理|介绍|讲解|考察|手撕|实现|设计|优化|选型/.test(line))&&(/^(?:\d{1,3}[.、)）]|[-*•]|问[:：])/.test(line)||/[？?]/.test(line))).map(line=>line.slice(0,320)))].slice(0,60);
}
const questionKey=quote=>norm(quote).replace(/^(?:\d{1,3}[.、)）]|[-*•]|问[:：])+/,'').replace(/[，。？?！!、:：；;“”"'()（）]/g,'');
function uniqueQuestionSets(rows){
  const groups=new Map();
  for(const row of [...rows].sort((a,b)=>(Date.parse(a.post.created_at)||Infinity)-(Date.parse(b.post.created_at)||Infinity)||a.post.key.localeCompare(b.post.key))){
    const keys=[...new Set(row.post.question_excerpts.map(questionKey))].sort();
    const key=keys.length>=5?hash(keys.join('\n')):row.post.key;
    if(!groups.has(key))groups.set(key,row);
  }
  return [...groups.values()];
}
function roleRelevance(post,roles){
  const targets=roleFamilies.filter(f=>roles.includes(f.name)),title=post.title,content=post.content;
  if(targets.some(f=>f.title.test(title)||f.query.test(title)))return 2;
  const competing=roleFamilies.filter(f=>!['通用软件开发','后端开发',...roles].includes(f.name)&&f.title.test(title));
  if(competing.length)return 0;
  return targets.some(f=>f.query.test(content)&&f.content.test(content))?1:0;
}
function validPost(raw,task){
  if(!raw||raw.platform!=='nowcoder'||typeof raw.content!=='string'||typeof raw.title!=='string'||raw.role_key!==task.interviews.roleKey)return null;
  const url=String(raw.url||'');
  if(!/^https:\/\/www\.nowcoder\.com\/(?:discuss\/\d{1,20}|feed\/main\/detail\/[a-f0-9]{32})$/.test(url))return null;
  const text=raw.content.slice(0,60000),questionExcerpts=questions(text);
  const guide=/题库|题集|指南|攻略|满分答法|参考答案|服务商|课程|押题|八股合集|面经汇总/.test(raw.title);
  const experience=!guide&&/面经|一面|二面|三面|终面|笔试|面了|面完|面试经历|面试官|面试公司|面试时间|反问/.test(raw.title+'\n'+text)&&questionExcerpts.length>0;
  return {...raw,id:String(raw.id||url),title:raw.title.slice(0,300),content:text,metrics:Object.fromEntries(['views','likes','favorites','comments'].map(key=>[key,Number.isSafeInteger(raw.metrics?.[key])&&raw.metrics[key]>=0?raw.metrics[key]:null])),question_excerpts:questionExcerpts,evidence_type:experience?'reported_interview':guide?'reference_article':'unverified_context',task_id:task.id};
}
function deduplicate(posts){
  const bySource=new Map();
  for(const post of posts){const old=bySource.get(post.url);if(!old||String(post.collected_at||'')>String(old.collected_at||''))bySource.set(post.url,post);}
  const groups=new Map();
  for(const post of bySource.values()){
    const key=post.content_status==='detail'&&norm(post.content).length>=120?hash(norm(post.content)):post.url;
    if(!groups.has(key))groups.set(key,[]);groups.get(key).push(post);
  }
  return [...groups.values()].map(group=>{
    group.sort((a,b)=>(Date.parse(a.created_at)||Infinity)-(Date.parse(b.created_at)||Infinity)||a.url.localeCompare(b.url));
    const post=group[0];return {...post,duplicate_count:group.length-1,key:'I'+hash(post.url+'\n'+post.content)};
  });
}
const terms=query=>[...new Set((query.normalize('NFKC').toLowerCase().match(/[a-z][a-z0-9+#.-]{1,24}|[\u4e00-\u9fff]{2,}/g)||[]).flatMap(term=>/^[\u4e00-\u9fff]+$/.test(term)?Array.from(new Intl.Segmenter('zh',{granularity:'word'}).segment(term)).filter(x=>x.isWordLike).map(x=>x.segment):[term]).filter(x=>x.length>=2&&!/^(?:哪些|什么|可能|高频|问题|面试|面经|开发|岗位|可以|内容|参考|需要|怎么|如何|请问|有没有|智能体)$/.test(x)))].slice(0,30);

export function emptyInterviewResult(message='尚未检索到当前岗位的本地面经，请先在任务中心启用牛客面经并采集。'){
  return {status:'ready',mode:'interviews',message,sources:[],interview_statistics:{corpus_posts:0,matched_posts:0,eligible_posts:0,duplicate_posts:0,question_frequency:[],topic_mentions:[],frequency_basis:'去重完整面经正文；仅统计原文问题与主题提及，不代表平台总体题频。'},scope:{roles:[],matched_interviews:0},notice:'面经是网友自述，未经独立核实；岗位JD只能作为考察方向推演。'};
}

export function createInterviewKnowledgeStore(dataDir,{now=Date.now,enrich=async posts=>posts}={}){
  let cached=null;
  async function load(){
    let tasks;
    try{const file=path.join(dataDir,'tasks.json'),stat=await fs.stat(file);if(stat.size>4*1024*1024)throw Error('任务目录超出只读检索预算');tasks=JSON.parse(await fs.readFile(file,'utf8'));}
    catch(error){if(error.code==='ENOENT')return {posts:[],raw:0,warnings:[]};throw toolError('TOOL_INTERVIEW_STORAGE','面经目录读取失败，请检查本机任务存储；不会以空库冒充成功。');}
    if(!Array.isArray(tasks))throw toolError('TOOL_INTERVIEW_STORAGE','面经任务目录格式异常。');
    const descriptors=[],warnings=[];let budget=0;
    for(const task of tasks){
      if(!task.interviews?.roleKey||typeof task.outputDir!=='string'||!path.isAbsolute(task.outputDir))continue;
      const file=path.join(task.outputDir,'面经数据','nowcoder.checkpoint.json');
      try{const stat=await fs.stat(file);if(stat.size>16*1024*1024||budget+stat.size>64*1024*1024||descriptors.length>=200){warnings.push('部分材料超出单次只读检索预算');continue;}budget+=stat.size;descriptors.push({task,file,signature:[task.id,task.interviews.roleKey,stat.mtimeMs,stat.size,stat.ino]});}
      catch(error){if(error.code!=='ENOENT')warnings.push('部分面经文件不可读取');}
    }
    const signature=JSON.stringify([descriptors.map(d=>d.signature),warnings]);
    if(cached?.signature===signature)return cached;
    const all=[];
    for(const {task,file}of descriptors){
      try{
        const data=JSON.parse(await fs.readFile(file,'utf8'));
        if(data.task_id!==task.id||data.role_key!==task.interviews.roleKey||!Array.isArray(data.posts)){warnings.push('部分面经任务归属校验未通过');continue;}
        for(const raw of data.posts){const post=validPost(raw,task);if(post)all.push(post);else warnings.push('部分面经记录格式校验未通过');}
      }catch{warnings.push('部分面经断点不可读取，已跳过并保留其余证据');}
    }
    cached={signature,posts:deduplicate(all),trainingPosts:all,raw:all.length,warnings:[...new Set(warnings)]};return cached;
  }
  return {
    async trainingCorpus({taskId}={}){const data=await load();return (data.trainingPosts||data.posts).filter(post=>!taskId||post.task_id===taskId);},
    async metadata(){const data=await load();return {provider:'nowcoder',posts:data.posts.length,complete_posts:data.posts.filter(p=>p.content_status==='detail').length,raw_posts:data.raw,duplicate_posts:data.raw-data.posts.length,partial:data.warnings.length>0,warnings:data.warnings};},
    async search({query='',filters={},limit=8}={}){
      const scope=interviewQueryScope(filters),roles=scope.roles;
      if(!roles.length)return {...emptyInterviewResult('请先指定要查询面经的岗位方向；不会用全部职业面经混算高频问题。'),status:'clarification'};
      const data=await load(),tokens=terms(String(query||'').slice(0,500));
      const enriched=(await enrich(data.posts,roles)).map(post=>{
        const annotation=post.qwen_annotation;
        if(!annotation)return post;
        const type=annotation.material_type==='single_interview'?'reported_interview':['interview_collection','reference_guide'].includes(annotation.material_type)?'reference_article':'unverified_context';
        return {...post,evidence_type:type,question_excerpts:annotation.questions.filter(q=>post.content.includes(q)),annotation_basis:'Qwen标签，非人工核实'};
      });
      const matched=enriched.map(post=>{
        const inference=post.supervised_relevance;
        const other=roles.includes('智能体/大模型应用')?roleRelevance(post,roles.filter(r=>r!=='智能体/大模型应用')):0;
        const relevance=inference?inference.rawDecision==='include'?2:inference.decision==='exclude'?other:Math.max(1,other):Math.max(roleRelevance(post,roles),post.qwen_annotation?.label==='include'?1:0);
        return {post,relevance};
      }).filter(row=>row.relevance>0);
      const complete=matched.filter(({post})=>post.content_status==='detail'&&post.evidence_type==='reported_interview'&&(!post.qwen_annotation||post.qwen_annotation.label==='include')&&(!post.supervised_relevance||post.supervised_relevance.rawDecision==='include')),eligible=uniqueQuestionSets(complete);
      const analyzed=analyzeInterviewPosts(matched.map(({post})=>({...post,role_key:roles.join('、')})),{roleKey:roles.join('、'),now:now(),halfLifeDays:180});
      const influences=new Map(analyzed.rows.map(p=>[p.id,p.influence]));
      const ranked=matched.map(({post,relevance})=>{
        const title=post.title.toLowerCase(),body=post.content.toLowerCase(),hits=tokens.reduce((sum,token)=>sum+(title.includes(token)?3:body.includes(token)?1:0),0),influence=influences.get(post.id);
        return {...post,relevance,influence,retrieval_score:relevance*10+hits+(post.evidence_type==='reported_interview'?6:0)+(post.content_status==='detail'?2:0)+(influence?.score||0)/100};
      }).sort((a,b)=>b.retrieval_score-a.retrieval_score||a.key.localeCompare(b.key));
      const byQuestion=new Map();
      for(const {post}of eligible)for(const quote of post.question_excerpts){
        const key=questionKey(quote);
        if(key.length<4)continue;if(!byQuestion.has(key))byQuestion.set(key,{question:quote,posts:new Map()});byQuestion.get(key).posts.set(post.key,post);
      }
      const repeated=[...byQuestion.values()].filter(g=>g.posts.size>=2).sort((a,b)=>b.posts.size-a.posts.size||a.question.localeCompare(b.question,'zh-CN')).slice(0,8);
      const max=Math.max(1,Math.min(8,Number(limit)||8)),selected=[];
      for(const group of repeated.slice(0,4)){const support=ranked.find(p=>group.posts.has(p.key));if(selected.length<max&&support&&!selected.some(p=>p.key===support.key))selected.push(support);}
      for(const post of ranked)if(selected.length<max&&!selected.some(p=>p.key===post.key))selected.push(post);
      const selectedKeys=new Set(selected.map(p=>p.key));
      const question_frequency=repeated.map(g=>({question:redactPersonalInfo(g.question),post_count:g.posts.size,citations:[...g.posts.keys()].filter(key=>selectedKeys.has(key))})).filter(g=>g.citations.length);
      const topic_mentions=topics.map(([topic,re])=>{const hit=eligible.filter(({post})=>post.question_excerpts.some(q=>re.test(q)));return {topic,post_count:hit.length,citations:hit.map(({post})=>post.key).filter(key=>selectedKeys.has(key))};}).filter(g=>g.post_count&&g.citations.length).sort((a,b)=>b.post_count-a.post_count);
      const sources=selected.map(post=>{
        const focus=post.question_excerpts.filter(q=>tokens.some(token=>q.toLowerCase().includes(token)));
        const repeatedQuotes=repeated.filter(g=>g.posts.has(post.key)).map(g=>post.question_excerpts.find(q=>questionKey(q)===questionKey(g.question))||g.question);
        const excerpts=[...new Set([...repeatedQuotes,...focus,...post.question_excerpts])].filter(q=>post.content.includes(q)).slice(0,5);
        const quote=excerpts.length?excerpts.join('\n'):post.content.slice(0,1200);
        return {key:post.key,citation:post.key,source_type:'interview',platform:'nowcoder',title:post.title,url:post.url,quote:redactPersonalInfo(quote).slice(0,1800),question_excerpts:excerpts.map(redactPersonalInfo),content_status:post.content_status,evidence_type:post.evidence_type,role_relevance:post.supervised_relevance?'supervised_'+post.supervised_relevance.decision:post.relevance===2?'title_match':'body_related',annotation_basis:post.annotation_basis||'本地文本特征识别，非人工核实',supervised_relevance:post.supervised_relevance||null,created_at:post.created_at||null,collected_at:post.collected_at||null,metrics_at:post.metrics_at||null,metrics:post.metrics,influence:post.influence,duplicate_count:post.duplicate_count,source_verified:false};
      });
      return {...emptyInterviewResult(),message:sources.length?`已召回 ${sources.length} 篇牛客材料；当前岗位相关 ${matched.length} 篇，其中 ${eligible.length} 篇完整自述面经可用于本库题频。${eligible.length<10?'样本较少，不称为行业高频。':''}`:'当前岗位未命中本地面经；不能用其他职业或JD推演冒充真实面试题。',sources,
        scope:{roles,matched_interviews:matched.length,frequency_sample_posts:eligible.length,unapplied_filters:['城市','学历','毕业届次','招聘阶段'],scope_notice:'面经通常缺少可靠资格元数据，不套用JD城市/学历/届次筛选，不代表同条件面试统计。'},
        interview_statistics:{corpus_posts:data.posts.length,raw_posts:data.raw,duplicate_posts:data.raw-data.posts.length,matched_posts:matched.length,eligible_posts:eligible.length,duplicate_question_sets:complete.length-eligible.length,retrieved_posts:sources.length,question_frequency,topic_mentions,partial:data.warnings.length>0,warnings:data.warnings,frequency_basis:'同岗位相关、去重完整自述面经；5题及以上的相同题目集合保守合并，避免改标题/开头转载抬高题频。相同问题仅做文字归一化，每篇最多计一次。主题统计为问题片段提及篇数，不等于同一道题出现次数。'},
      };
    },
  };
}

export function interviewFallback(result){
  const stats=result?.interview_statistics,posts=(result?.sources||[]).filter(p=>p.evidence_type==='reported_interview'&&p.content_status==='detail');
  let answer=result?.message||'面经检索未成功，不能报告题频。';
  if(stats?.question_frequency?.length)answer+='\n\n本库重复出现的原文问题：\n'+stats.question_frequency.slice(0,5).map(g=>`- ${g.question}（${g.post_count}/${stats.eligible_posts} 篇）${g.citations.map(c=>`[${c}]`).join('')}`).join('\n');
  else if(posts.length)answer+='\n\n已采面经中的原文考察点（不是全行业高频排名）：\n'+posts.slice(0,4).map(p=>`- ${p.title}：${p.question_excerpts.slice(0,3).join('；')} [${p.citation}]`).join('\n');
  else if(result?.sources?.length)answer+='\n\n目前只有经验参考文章或摘要，不用于统计真实题频。';
  if(stats?.topic_mentions?.length)answer+='\n\n问题主题提及（按去重面经篇数，不是同一道题频次）：'+stats.topic_mentions.slice(0,5).map(g=>`${g.topic} ${g.post_count}/${stats.eligible_posts} 篇`).join('、')+'。';
  if(stats?.partial)answer+='\n\n部分材料未能读取，以上仅代表成功读取的子集。';
  return answer+'\n\n面经为网友自述，未经独立核实；JD只能补充岗位要求推演。面经缺少可靠城市、学历与届次信息，不代表同条件统计。';
}
