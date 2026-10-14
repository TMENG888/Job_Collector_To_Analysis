import assert from 'node:assert/strict';
import {buildKeywordCloudDisplay} from './keyword-cloud-display.mjs';
import {cloudSections} from './keyword-cloud-generic.mjs';
import {layoutWordCloud} from '../job_collector_ui/public/insight-wordcloud.js';
for(const [name,title,text] of [
 ['智能体/大模型应用',/智能体/,'构建智能体，设计RAG检索链路；任职要求：熟悉LangChain、Python、LLM'],
 ['爬虫/数据采集',/爬虫/,'开发网页爬虫，维护数据解析链路；任职要求：熟悉Scrapy、Python、XPath'],
 ['大数据开发',/大数据/,'建设数据仓库与数据管道；任职要求：熟悉Spark、Flink、SQL'],
 ['自定义岗位',/自定义/,'Responsibilities: build ETL pipelines with Spark.\nRequirements: Python, SQL, C++.'],
]){
 const rows=Array.from({length:8},(_,i)=>({row_no:i+2,'岗位名称':name,'岗位描述':`岗位职责：${text}\n${i}批次。公司简介：InvisibleCompanyWord。福利待遇：InvisibleBenefitsWord。`}));
 rows.push({row_no:100,'岗位名称':name,'岗位描述':'岗位职责：NoiseExcludedOnlyWord unrelated.'});
 const snapshot=structuredClone(rows),ids=rows.slice(0,8).map(r=>r.row_no);
 const cloud=buildKeywordCloudDisplay(rows,{name,title},{seedRows:ids});
 assert.ok(cloud?.terms.length>0,name);assert.deepEqual(rows,snapshot);
 assert.ok(cloud.terms.every(t=>t.used_for_filter===false&&ids.includes(t.evidence.row_no)&&rows.find(r=>r.row_no===t.evidence.row_no)['岗位描述'].includes(t.evidence.quote)));
 assert.ok(!cloud.terms.some(t=>/Invisible|NoiseExcludedOnlyWord/i.test(t.name)));
 assert.ok(cloud.terms.some(t=>/python|spark/i.test(t.name)),'Requirements and English stacks');
 const layout=layoutWordCloud(cloud.terms);assert.equal(layout.words.length,cloud.terms.length);
 assert.equal(buildKeywordCloudDisplay(rows.slice(0,4),{name,title},{seedRows:ids}),null);
}
const english=cloudSections({'岗位描述':'Responsibilities: build pipelines\nRequirements: Python\nAbout us: NotEvidence\nBenefits: AlsoNotEvidence'});
assert.ok(english.some(s=>s.location==='职责'));assert.ok(english.some(s=>s.location==='任职要求'));
assert.ok(!english.some(s=>s.quote.includes('NotEvidence')));
console.log('PASS generic cloud: four families, accepted-only, immutable, English sections, company isolation, stack evidence, layout, cold start');
