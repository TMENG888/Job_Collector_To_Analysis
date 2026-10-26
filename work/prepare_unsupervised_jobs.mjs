// Read-only discovery corpus: no title strata, classifier labels or query features.
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { roleSections } from './role-evidence-v2.mjs';
const root=path.resolve(import.meta.dirname,'..');
export const digest=s=>createHash('sha256').update(s).digest('hex');
export function discoveryInput(raw){
  const sections=roleSections({'岗位描述':raw.job_description||''});
  const explicit=sections.filter(s=>s.location==='duties');
  const body=(explicit.length?explicit:sections.filter(s=>s.location==='unsectioned')).map(s=>s.quote).join('\n')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[邮箱已移除]').replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g,'[手机号已移除]');
  if(body.replace(/\s/g,'').length<100||String(raw.job_description||'').length>9000)return null;
  const title=String(raw.job_name||'').trim().slice(0,60);if(!title)return null;
  const mid=Math.floor(body.length/2);
  const excerpt=body.length<=420?body:body.slice(0,160)+'\n…\n'+body.slice(mid-65,mid+65)+'\n…\n'+body.slice(-130);
  return {title,body,excerpt,text:title+'\n主要职责：'+excerpt,compressed:body.length>420,body_hash:digest(body.normalize('NFKC').replace(/\s/g,'').toLowerCase()),section_mode:explicit.length?'explicit_duties':'unsectioned'};
}
export async function prepareDiscovery(out,limit=5000){
  await fs.mkdir(out,{recursive:true});
  const corpusFile=path.join(out,'corpus.json');
  try{await fs.access(corpusFile);throw Error('Discovery corpus already sealed; use a new output directory');}catch(e){if(e.code!=='ENOENT')throw e;}
  const db=new DatabaseSync(path.join(root,'ui_data/knowledge/岗位知识库.sqlite'),{readOnly:true});
  const pool=[];let total=0,revision;
  try{
    db.exec('PRAGMA query_only=ON;PRAGMA busy_timeout=10000;BEGIN');
    revision=db.prepare("SELECT value FROM metadata WHERE key='revision'").get()?.value;
    for(const row of db.prepare('SELECT job_key,content_hash,raw FROM jobs ORDER BY job_key').iterate()){
      total++;const raw=JSON.parse(row.raw),input=discoveryInput(raw);if(!input)continue;
      const company=String(raw.company_name||'').normalize('NFKC').toLowerCase().replace(/\s|（.*?）|\(.*?\)/g,'');
      pool.push({key:row.job_key,content_hash:row.content_hash,platform:raw.platform,job_id:raw.job_id,company_hash:digest(company||row.job_key),...input,order:digest('unsupervised-20261017:'+row.job_key)});
    }
  }finally{db.close();}
  pool.sort((a,b)=>a.order.localeCompare(b.order));const seen=new Set(),companies=new Map(),docs=[];
  for(const row of pool){if(seen.has(row.body_hash)||(companies.get(row.company_hash)||0)>=5)continue;
    seen.add(row.body_hash);companies.set(row.company_hash,(companies.get(row.company_hash)||0)+1);delete row.order;docs.push(row);if(docs.length===limit)break;}
  const protocol={version:'unsupervised-codex-pilot-v1',source:'read-only production SQLite transaction',revision,source_rows:total,eligible_rows:pool.length,sampled_rows:docs.length,
    sampling:'stable SHA256 order; exact normalized duty dedup; max5/company; no role/task/title strata; NOT population-weighted',
    embedding:'local BAAI/bge-small-zh-v1.5; raw pretrained encoder, no prior classifier or SetFit weights',input:'title60 + explicit duty sections or unsectioned body; head160/mid130/tail130 if >420; no queries/salary/city/company/skills/labels',
    comparison:{kmeans:{clusters:24,n_init:10,seed:42},hdbscan:{pca_components:30,min_cluster_size:50,min_samples:10,cluster_selection_method:'eom'}},
    naming_selection:'prefer HDBSCAN if >=4 clusters and non-noise coverage>=0.3, otherwise KMeans24; operational heuristic, NOT semantic accuracy selection',
    annotation:'Codex reads 2 center +2 random +2 boundary samples per cluster;2 further deterministic random members held out until names sealed; same Codex audit not independent human gold',
    safeguards:'no network/API fees; no production labels/reports/source writes; no propagation of labels as confirmed ground truth; generated cluster IDs local to run',seed:42};
  await fs.writeFile(path.join(out,'protocol.json'),JSON.stringify(protocol,null,2),{flag:'wx'});
  const serialized=JSON.stringify({protocol,docs},null,2);await fs.writeFile(corpusFile,serialized,{flag:'wx'});
  console.log(JSON.stringify({...protocol,corpus_sha256:digest(serialized),out}));return {protocol,docs};
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(import.meta.filename))await prepareDiscovery(path.resolve(process.argv[2]||path.join(root,'ui_data/insights/comparisons/unsupervised-codex-20261017')));
