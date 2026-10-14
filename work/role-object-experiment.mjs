// Offline candidates: never imported by the production matcher.
import {sectionsV3} from './role-evidence-v3-offline.mjs';
const norm = s => String(s || '').normalize('NFKC').toLowerCase();
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const action = /开发|研发|编写|构建|搭建|建设|设计|实现|集成|接入|封装|编排|配置|维护|优化|治理|抓取|爬取|develop\w*|build\w*|design\w*|implement\w*|integrat\w*|deploy\w*|maintain\w*|extract\w*/gi;
const optional = /优先|加分|更佳|preferred|nice.to.have/i;
const soft = /^(?:\s*\d+[.、)]\s*)?(?:熟悉|了解|关注|探索|学习|掌握|有.*经验|familiar|knowledge|experience|proficien)/i;
const profiles = {
 agent: {
  object:/智能体|\b(?:ai[ -]*)?agents?\b|\brag\b|检索增强生成|大模型应用|\bllm\b.{0,20}(?:app|service|integration)|(?:大模型|大语言模型).{0,20}(?:应用|服务|接口|接入)|(?:知识库|工作流|工具调用|对话系统)/gi,
  context:/智能体|\b(?:ai[ -]*)?agents?\b|\bllms?\b|\brag\b|大模型|大语言模型|langchain|langgraph|dify|coze|llamaindex/i,
  clear:/智能体|ai[ -]*agents?|\brag\b|检索增强生成|大模型应用/i,
  wrong:/辅助.{0,12}(?:编程|编码)|(?:cursor|copilot).{0,20}(?:效率|编程)|销售方案|运营数据|测试用例|接口测试|测试平台|强化学习算法|运动控制|传感器|仿真环境/i,
 },
 crawler: {
  object:/爬虫|\b(?:web[ -]*)?(?:crawl\w*|scrap\w*)\b|(?:网页|网站|互联网|web|app).{0,24}(?:抓取|采集|提取|数据)|(?:抓取|采集|提取).{0,24}(?:网页|网站|互联网|web|app)/gi,
  context:/爬虫|scrapy|selenium|playwright|beautifulsoup|xpath|web.scrap|web.crawl/i,
  clear:/爬虫|web.scrap|web.crawl|网站.{0,20}(?:抓取|采集)|互联网.{0,20}(?:抓取|采集)/i,
  wrong:/传感器|plc|scada|信号采集|设备采集|机器人感知|测试设备|入侵检测|防爬|反爬.{0,12}(?:防护|检测|安全体系)/i,
 },
 bigdata: {
  object:/etl|elt|数仓|数据仓库|数据管道|数据治理|数据质量|数据模型|数据建模|数据集市|指标体系|报表开发|data\s+(?:pipeline\w*|warehous\w*|model\w*|mart\w*|governance)|(?:实时|离线|流式|批量).{0,16}(?:计算|处理|任务|加工)|(?:spark|flink).{0,20}(?:任务|作业|开发|计算)/gi,
  context:/etl|elt|数仓|数据仓库|spark|flink|hadoop|hive|数据治理|data\s+(?:pipeline|warehouse|model)/i,
  clear:/etl|elt|数仓|数据仓库|数据管道|数据治理|data\s+(?:pipeline|warehouse|model)/i,
  wrong:/服务器|网络设备|集群部署|集群运维|云平台运维|安装配置|桌面支持|系统巡检|硬件维护/i,
 },
};
function present(q, name) {
 const key=norm(name);
 return /^[a-z0-9 .+#_-]+$/.test(key) ? new RegExp(`(?<![a-z0-9])${esc(key)}(?![a-z0-9])`,'i').test(norm(q)) : norm(q).replace(/\s/g,'').includes(key.replace(/\s/g,''));
}
export function scoreRoleObjects(doc, role, terms, baseline, mode='rescue') {
 const profile=profiles[role];
 if(!profile)throw new Error('Unknown offline profile');
 const sections=sectionsV3({'岗位描述':doc.original_description || doc.description || doc.text});
 const mandatory=sections.filter(s=>s.location!=='bonus'&&!optional.test(s.quote));
 const background=mandatory.filter(s=>profile.context.test(s.quote));
 const frames=[];
 for(const s of mandatory){
  const duty=s.location==='duties'||s.location==='unknown';
  // A requirements list alone cannot establish the actual job responsibility.
  if(!duty||soft.test(s.quote))continue;
  for(const clause of s.quote.split(/[，,]/)){
   if(profile.wrong.test(clause))continue;
   const objects=[...clause.matchAll(profile.object)],actions=[...clause.matchAll(action)];
   if(!objects.length||!actions.some(a=>objects.some(o=>Math.abs(a.index-o.index)<=100)))continue;
   if(!profile.clear.test(clause)&&!background.length)continue;
   const hits=terms.filter(t=>present(s.quote,t.name));
   const support=background.filter(b=>b.quote!==s.quote);
   const supportingHits=terms.filter(t=>support.some(b=>present(b.quote,t.name)));
   // Repeated and nested keywords are not additional independent evidence.
   const independent=[];
   for(const t of [...hits,...supportingHits].sort((a,b)=>b.weight-a.weight)){
    if(independent.some(o=>norm(t.name).includes(norm(o.name))||norm(o.name).includes(norm(t.name))))continue;
    independent.push(t);
   }
   const learned=independent.reduce((sum,t)=>sum+Math.min(t.weight,3)*(hits.includes(t)?1:.35),0);
   if(!learned)continue;
   frames.push({quote:s.quote,location:s.location,object:objects.map(o=>o[0]),actions:actions.map(a=>a[0]),learned,terms:independent.map(t=>t.name),support:support.slice(0,2).map(b=>b.quote)});
  }
 }
 const unique=[...new Map(frames.map(f=>[norm(f.quote).replace(/\s/g,''),f])).values()];
 const score=mode==='gate'?(unique.length?baseline.score:0):unique.length?2.5+Math.min(3,Math.max(...unique.map(f=>f.learned)))+Math.min(.5,(unique.length-1)*.25):0;
 return {row_no:doc.row_no,score:Number(score.toFixed(6)),frames:unique,baseline_score:baseline.score,mode};
}
