// Display enrichment only. Never feed these terms back into role matching.
import {dutiesOf,extractKeywords} from './keyword-role-matcher.mjs';
import {roleSections} from './role-evidence-v2.mjs';
import {buildGenericKeywordCloud} from './keyword-cloud-generic.mjs';
const norm=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/\s+/g,'');
const vocabulary={
工具:'SQL|Python|Excel|Power BI|Tableau|FineBI|FineReport|Hive|Spark|Hadoop|MySQL|ClickHouse|Presto|Pandas|NumPy|SPSS|SAS|R语言|Scikit-learn|Matplotlib|Seaborn|DAX|ETL|Flink|Kafka|Oracle|SQL Server|VBA|Power Query|Superset',
方法:'统计分析|回归分析|聚类分析|因果推断|假设检验|机器学习|深度学习|时间序列|时序预测|A/B测试|AB测试|实验设计|归因分析|漏斗分析|留存分析|关联分析|相关性分析|预测模型|分类模型|异常检测|特征工程|数据挖掘|统计建模|数据建模|用户分群|用户画像|量化分析|可视化',
职责:'数据清洗|数据采集|数据治理|数据质量|数据整合|数据处理|数据提取|指标体系|指标口径|指标监控|分析报告|数据报表|数据看板|经营分析|业务分析|运营分析|专题分析|需求分析|市场分析|财务分析|风险分析|销售分析|营销分析|产品分析|用户分析|用户行为|客户分析|决策支持|趋势预测|风险预警|业务洞察|效果评估|成本分析|数据仓库|数据字典|数据标准|商业分析|增长分析|数据可视化|数据监控|业务指标',
业务:'转化率|留存率|活跃用户|用户增长|客户留存|销售预测|库存预测|风险控制|精准营销|供应链|用户生命周期|客户生命周期|电商|金融|教育|游戏|医疗|广告投放|人力资源|用户体验'
};
const generic=/^(?:决策|结论|提取|呈现|专题|波动|分析结果|分析方法|决策提供|能够|及时|定期|有效|准确|深入|制定|建立|开展|协同|各项|独立|跟踪|日常|经验|岗位|职责|工作|优先|相关|要求|熟悉|掌握|以上|负责)$/;
export function buildKeywordCloudDisplay(rows,family,{seedRows,limit=100}={}){
 // Keep the evaluated 数据分析 vocabulary; other roles use corpus-learned
 // phrases, never borrow the data-analysis dictionary.
 if(family.name!=='数据分析')return buildGenericKeywordCloud(rows,family,{seedRows,limit});
 limit=Math.max(1,Math.min(100,limit));
 const selectedIds=seedRows?new Set(seedRows):null,seen=new Set();
 const seeds=rows.filter(r=>selectedIds?selectedIds.has(r.row_no):family.title.test(String(r['岗位名称']||'')))
  .filter(r=>{const body=norm(dutiesOf(r));if(!body||seen.has(body))return false;seen.add(body);return true;});
 if(seeds.length<5)return null;
 const fullRows=rows.map(r=>({...r,'岗位描述':roleSections(r).map(s=>s.quote).join('\n')}));
 const ids=new Set(seeds.map(r=>r.row_no)),fullSeeds=fullRows.filter(r=>ids.has(r.row_no));
 const seedDocs=fullSeeds.map(r=>norm(r['岗位描述'])),docs=fullRows.map(r=>norm(r['岗位描述']));
 const minimum=Math.max(3,Math.ceil(seeds.length*.005)),candidates=[];
 for(const [category,entries] of Object.entries(vocabulary))for(const name of entries.split('|')){
  const key=norm(name),has=s=>/^[a-z0-9]+$/.test(key)?new RegExp(`(?<![a-z0-9])${key}(?![a-z0-9])`,'i').test(s):s.includes(key);
  const seed_df=seedDocs.filter(has).length,background_df=docs.filter(has).length;
  if(seed_df<minimum)continue;
  candidates.push({term:name,category,seed_df,background_df,lift:(seed_df/seeds.length)/(background_df/rows.length),score:seed_df/seeds.length*(Math.log((rows.length+1)/(background_df+1))+1),source:'observed_dictionary'});
 }
 const ranked=extractKeywords(fullSeeds,fullRows,[],'tfidf',5000);
 for(const t of ranked){
  if(t.seed_df<minimum||generic.test(t.term)||t.term.length>8||!(/^[a-z][a-z0-9.+#-]{1,18}$/i.test(t.term)||/分析|预测|指标|画像|报表|看板|检验|挖掘|统计|仓库|清洗|治理/.test(t.term)))continue;
  if(candidates.some(c=>norm(c.term)===norm(t.term)))continue;
  candidates.push({...t,category:/^[a-z]/i.test(t.term)?'工具':'职责',source:'learned_unknown'});
 }
 const cleaned=candidates.filter(t=>t.source==='observed_dictionary'||(!/^[a-z]/i.test(t.term)&&t.term.length>=4&&t.term.length<=8&&!/提供|相关|具备|熟悉|掌握|负责|进行|能够|完成|基础|能力|方法|结果|结论|体系建设/.test(t.term)));
 const compact=cleaned.filter(t=>t.source==='observed_dictionary'||!cleaned.some(k=>k.source==='observed_dictionary'&&norm(t.term).includes(norm(k.term))&&k.seed_df>=t.seed_df*.8));
 const groups=Object.values(vocabulary).map((_,i)=>compact.filter(t=>t.category===Object.keys(vocabulary)[i]).sort((a,b)=>b.score-a.score));
 const terms=[];
 for(let i=0;terms.length<limit&&i<limit;i++)for(const group of groups)if(group[i]&&terms.length<limit)terms.push(group[i]);
 return {version:'keyword-cloud-fusion-v1',profile:'data-analysis',method:'职责短语＋技术工具＋去噪融合（仅展示）',seed_rows:seeds.length,minimum_seed_df:minimum,
  policy:'职责与任职要求分节，排除公司和福利；观测短语/工具与TF-IDF长尾融合；四类别平衡，最多100词，不足不凑数；不改变岗位筛选',
  terms:terms.map(t=>{const key=norm(t.term),r=fullSeeds.find(r=>norm(r['岗位描述']).includes(key));return {...t,name:t.term,seed_count:t.seed_df,used_for_filter:false,
   evidence:{row_no:r.row_no,title:r['岗位名称'],quote:r['岗位描述'].split(/[\n。；;]/).find(s=>norm(s).includes(key))||r['岗位描述']}};})};
}
