// Read-only source sampling. Sampling strata are NOT training labels.
import fs from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {prepareClassifierInput} from './data-analysis-classifier.mjs';
const root=path.resolve(import.meta.dirname,'..'),out=path.join(root,'ui_data/insights/comparisons/multirole-lr-20261016');
const sha=s=>createHash('sha256').update(s).digest('hex');
const corpusFile=path.join(out,'new-corpus.json');
if(process.argv.includes('--read')){
 const rows=JSON.parse(await fs.readFile(corpusFile,'utf8')).docs,start=Number(process.argv.at(-1));
 for(const d of rows.slice(start,start+16))console.log(JSON.stringify({id:d.id,title:d.title,duties:d.duties,chars:d.body.length}));
}else{
 const db=new DatabaseSync(path.join(root,'ui_data/knowledge/岗位知识库.sqlite'),{readOnly:true});
 let rows;try{rows=db.prepare('SELECT job_key,content_hash,raw FROM jobs ORDER BY job_key').all().map(r=>({...JSON.parse(r.raw),key:r.job_key,content_hash:r.content_hash}));}finally{db.close();}
 const extra=process.argv.includes('--software-extra');
 const docs=extra?JSON.parse(await fs.readFile(corpusFile,'utf8')).docs:[];
 const usedCompanies=new Set(docs.map(d=>d.company_group)),usedBodies=new Set(docs.map(d=>d.body_sha256));
 const groups=extra?[['software','测试工程',/软件测试|测试开发|自动化测试工程师/i]]:[['embedded','嵌入式开发',/嵌入式|单片机|固件|BSP|RTOS/i],['testing','测试工程',/软件测试|测试开发|测试工程师|自动化测试/i],['media','新媒体运营',/新媒体|短视频运营|内容运营/],['sales','销售工程师',/销售工程师|技术销售|售前工程师/]];
 for(const [group,family,re]of groups){
  const pool=rows.filter(r=>re.test(r.job_name)&&r.job_description?.length>=80&&r.job_description.length<=1600).sort((a,b)=>sha('multirole-v1:'+a.key).localeCompare(sha('multirole-v1:'+b.key)));
  let n=0;for(const r of pool){
   const company=String(r.company_name||'').normalize('NFKC').replace(/\s|（.*?）|\(.*?\)/g,'').toLowerCase();
   const bodyHash=sha(r.job_description.normalize('NFKC').replace(/\s/g,''));
   if(!company||usedCompanies.has(company)||usedBodies.has(bodyHash))continue;
   const p=prepareClassifierInput(r);if(p.compressed)continue;
   usedCompanies.add(company);usedBodies.add(bodyHash);n++;
   docs.push({id:group+'-'+String(n).padStart(2,'0'),sampling_family:family,key:r.key,platform:r.platform,job_id:r.job_id,company_group:company,title:r.job_name,body:r.job_description,content_hash:r.content_hash,body_sha256:bodyHash,text:p.text,duties:p.duties});
   if(n===32)break;
  }if(n<32)throw new Error('Insufficient independent sources: '+family+' '+n);
 }
 await fs.mkdir(out,{recursive:true});
 await fs.writeFile(extra?path.join(out,'extended-corpus.json'):corpusFile,JSON.stringify({annotation:'No labels yet; titles used only to sample; original source duties must be reviewed',docs},null,2),{flag:'wx'});
 console.log(JSON.stringify({output:corpusFile,rows:docs.length}));
}
