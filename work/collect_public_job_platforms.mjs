import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {normalize51Records} from './job51/normalizer.mjs';
import { parseChannelCsv } from './public_channel_csv.mjs';
import {assertCollectorResources} from './collector_resources.mjs';
import {writeJsonAtomic} from './collector_storage.mjs';
import {CHANNEL_PARTIAL,collectionExitCode,checkedJsonResponse} from './collection_policy.mjs';
import {parseIguopinPage,selectIguopinRows} from './public_json_contracts.mjs';
import {channelAcquisition} from './channel_acquisition.mjs';
import {jobonlineRoundBudget} from './jobonline_round_budget.mjs';
import {jobonlineContinuation} from './jobonline_continuation.mjs';
import {otherChannelValidCount} from './task_collection_target.mjs';
import {fetchShixisengList,fetchShixisengDetail,fetchMohrssList} from './public_api_adapters.mjs';
import {collectionChannelAvailable,collectionChannelPauseReason,assertDirectHttpCollection} from './channel_availability.mjs';
import {createPoliteHttpClient} from './polite_http_client.mjs';
import {retainedChannelErrors,isConditionScopedStop,readCollectionRound,filterCollectionCombinations} from './task_collection_config.mjs';
import {runChannels,loadShixiDetailCache,reuseShixiDetails} from './collection_concurrency.mjs';
import {YieldWindow,yieldNote} from './collection_yield.mjs';
import {assertTaskOutputOwnership} from './task_dataset_scope.mjs';

const configPath = path.resolve(process.argv[2] || 'work/job_collect_config.json');
const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
if(process.env.JOB_COLLECTOR_YIELD_RECOVERY==='1')config.lowYield={...config.lowYield,enabled:false};
const outputDir = path.resolve(process.argv[3] || 'outputs/public-collection');
const currentTaskId=config.task_id||process.env.JOB_COLLECTOR_TASK_ID||null;
if(config.task_id&&process.env.JOB_COLLECTOR_TASK_ID&&config.task_id!==process.env.JOB_COLLECTOR_TASK_ID)throw Error('采集配置与进程任务 ID 不匹配');
if(currentTaskId)process.env.JOB_COLLECTOR_TASK_ID=currentTaskId;
if(currentTaskId)await assertTaskOutputOwnership({id:currentTaskId,outputDir});
const requestedRound=readCollectionRound(currentTaskId);
const rawDir = path.join(outputDir, '原始数据');
const checkpointDir = path.join(outputDir, '断点数据');
await fs.mkdir(rawDir, { recursive: true });
await fs.mkdir(checkpointDir, { recursive: true });

const collectedAt = new Date().toISOString();
const directHttpRequest=createPoliteHttpClient({stateDir:process.env.JOB_HTTP_RATE_DIR||path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../ui_data/http_rate_limits'),minimumIntervalMs:config.request?.minimumIntervalMs,jitterMs:config.request?.jitterMs,attempts:config.request?.attempts});
const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pendingOutputs = [];
const shixiDetailCache=await loadShixiDetailCache(checkpointDir,config.task_id);
const discoveredIds={shixiseng:new Set(),iguopin:new Set(),jobonline:new Set(),liepin:new Set()};
const deferredCombos=new Set();
let jobonlineBudget=null;
const comboKey=(platform,keyword,city)=>JSON.stringify([platform,keyword,city]);
for(const name of await fs.readdir(checkpointDir)) {
  const platform=name.startsWith('shixiseng_')?'shixiseng':name.startsWith('iguopin_')?'iguopin':name.startsWith('jobonline_')?'jobonline':name.startsWith('liepin_')?'liepin':null;
  if(!platform || !name.endsWith('.json'))continue;
  const saved=JSON.parse(await fs.readFile(path.join(checkpointDir,name),'utf8'));
  if((saved.task_id??null)!==currentTaskId)continue;
  for(const row of saved.list||saved.records||[]) {
    const id=platform==='shixiseng'?row.uuid:row.job_id;
    if(id!=null && String(id)!=='')discoveredIds[platform].add(String(id));
  }
}

async function readOwnedCheckpoint(file) {
  let saved;try{saved=JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return {};throw error;}
  if((saved.task_id??null)!==currentTaskId)throw Object.assign(new Error('断点任务 ID 不匹配，拒绝混入其他任务'),{code:'TASK_OUTPUT_OWNERSHIP',stopChannel:true});
  return saved;
}

function safeName(value) {
  return String(value).replace(/[\\/:*?"<>|]/g, '_');
}

async function request(url, options = {}) {
  return directHttpRequest(url,{...options,headers:{'user-agent':userAgent,'accept-language':'zh-CN,zh;q=0.9',...options.headers}});
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0, failure=null;
  async function worker() {
    while (true) {
      if(failure)return;
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try{results[index] = await fn(items[index], index);}catch(error){failure ||= error;return;}
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if(failure)throw failure;
  return results;
}

function htmlToText(value) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(p|li|tr|div|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (match, name) => entities[name.toLowerCase()] ?? match)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function flattenValues(value) {
  if (Array.isArray(value)) return value.map(flattenValues).filter(Boolean).join(' | ');
  if (value && typeof value === 'object') return JSON.stringify(value);
  return value == null ? '' : String(value);
}

function csvEscape(value) {
  const text = flattenValues(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function writeCsv(filePath, rows) {
  if(process.env.JOB_COLLECTOR_NATIVE_STORE==='1'){const {writeNativeChannelRows}=await import('./collector_native_sink.mjs');return writeNativeChannelRows(outputDir,config.task_id||process.env.JOB_COLLECTOR_TASK_ID,rows);}
  const preferred = [
    'platform', 'query_keyword', 'query_city', 'job_id', 'job_name', 'company_id', 'company_name', 'salary',
    'city', 'district', 'experience', 'education', 'employment_type', 'company_nature', 'company_size', 'industry',
    'publish_time', 'refresh_time', 'deadline', 'tags', 'skills', 'job_description', 'address', 'recruiter_name',
    'recruiter_title', 'job_url', 'company_url', 'source_total', 'access_level', 'collected_at',
  ];
  const extra = [...new Set(rows.flatMap((row) => Object.keys(row)))].filter((key) => !preferred.includes(key));
  const columns = [...preferred, ...extra];
  const csv = [columns.join(','), ...rows.map((row) => columns.map((key) => csvEscape(row[key])).join(','))].join('\r\n');
  const stagedPath=`${filePath}.pending-${process.pid}`;
  await fs.writeFile(stagedPath, `\uFEFF${csv}`, 'utf8');
  for(let attempt=0;attempt<4;attempt++) {
    try { await fs.rename(stagedPath,filePath); return; }
    catch(error) {
      if(!['EBUSY','EPERM','EACCES'].includes(error.code))throw error;
      if(attempt<3){await sleep(1000);continue;}
      pendingOutputs.push({filePath,stagedPath,reason:'output_locked'});
      console.error(`输出文件被占用，未覆盖原文件：${filePath}。请关闭 Excel/预览后再导出；本轮数据已保存在 ${stagedPath}`);
      return;
    }
  }
}

function comboFile(platform, keyword, cityName, suffix = 'json') {
  return path.join(rawDir, `${platform}_${safeName(keyword)}_${safeName(cityName)}.${suffix}`);
}

async function collectShixiseng(keyword, city) {
  const yieldWindow=new YieldWindow(discoveredIds.shixiseng,config.lowYield);
  const settings=config.platforms.shixiseng||{};
  const pageLimit=Math.max(1,Number(settings.maxPages)||Infinity);
  const rowLimit=Math.max(1,Number(settings.maxRows)||Infinity);
  const checkpointPath = path.join(checkpointDir, `shixiseng_${safeName(keyword)}_${safeName(city.name)}.json`);
  let saved=await readOwnedCheckpoint(checkpointPath);
  let list=saved.list||[],total=saved.total||0,pages=saved.pages||0;
  const details=saved.details||{};
  for(const [id,detail] of Object.entries(details))if(detail.ok && Object.keys(detail.data||{}).length)shixiDetailCache.set(id,detail);
  const save=()=>writeJsonAtomic(checkpointPath,{task_id:config.task_id,keyword,city,total,pages,list,lastListPage:saved.lastListPage||1,listComplete:saved.listComplete||false,details,low_yield:saved.low_yield||null});
  saved.low_yield=null;
  if(!saved.list) {
    const first = await fetchShixisengList({request,keyword,city,page:1});
    total = Number(first.total || first.data.length);
    pages = Math.ceil(total / Number(first.pageNumber || first.data.length || 20));
    list = [...first.data];saved.lastListPage=1;
    yieldWindow.observe(first.data.map(row=>row.uuid));
    await save();
  }
  for (let page = Number(saved.lastListPage||1)+1; !saved.listComplete && page <= Math.min(pages,pageLimit); page += 1) {
    const pageRows=(await fetchShixisengList({request,keyword,city,page})).data;
    if(!Array.isArray(pageRows))throw Object.assign(new Error('实习僧列表结构异常；不按低收益处理'),{stopChannel:true});
    list.push(...pageRows);
    const probe=yieldWindow.observe(pageRows.map(row=>row.uuid));
    saved.lastListPage=page;await save();
    if(probe.defer){saved.low_yield={...probe,at:new Date().toISOString()};deferredCombos.add(comboKey('shixiseng',keyword,city.name));await save();console.log(`[低收益切换] shixiseng ${keyword}/${city.name}: ${yieldNote(probe)}`);break;}
    if (page % 5 === 0 || page === pages) console.log(`shixiseng list ${keyword}/${city.name}: ${page}/${pages}`);
  }
  const unique = [...new Map(list.map((record) => [record.uuid, record])).values()].slice(0,rowLimit);
  saved.listComplete=Number(saved.lastListPage||1)>=pages;await save();
  const reused=reuseShixiDetails(unique,details,shixiDetailCache);
  if(reused){await save();console.log(`shixiseng cache ${keyword}/${city.name}: 复用 ${reused} 条成功详情，不重复请求`);}
  const pending = unique.filter((record) => !details[record.uuid]?.ok || !Object.keys(details[record.uuid].data||{}).length);
  await mapLimit(pending, config.request.concurrency || 3, async (record, index) => {
    try {
      const {data}=await fetchShixisengDetail({request,uuid:record.uuid});
      if(!data || !Object.keys(data).length)throw new Error('实习僧详情为空，保留待续采，不缓存成功');
      details[record.uuid] = { ok: true, data, error: '' };
      shixiDetailCache.set(record.uuid,details[record.uuid]);
    } catch (error) {
      if(error.stopChannel)throw error;
      details[record.uuid] = { ok: false, data: {}, error: String(error.message || error) };
    }
    await save();
    if ((index + 1) % 25 === 0 || index + 1 === pending.length) {
      console.log(`shixiseng details ${keyword}/${city.name}: ${Object.keys(details).length}/${unique.length}`);
    }
  });
  const raw = unique.map((record) => ({ list: record, detail_status: details[record.uuid]?.ok ? '成功' : `失败：${details[record.uuid]?.error || ''}`, detail: details[record.uuid]?.data || {} }));
  await writeJsonAtomic(comboFile('实习僧', keyword, city.name),{task_id:config.task_id, keyword, city, total, records: raw});
  return normalizeShixi(raw,keyword,city,total);
}

function normalizeShixi(raw,keyword,city,total) {
  return raw.map(({ list: row, detail, detail_status }) => ({
    platform: '实习僧', query_keyword: keyword, query_city: city.name, job_id: row.uuid, job_name: detail.iname || row.name,
    company_id: detail.cuuid || row.c_uuid, company_name: detail.cname || row.cname, salary: detail.salary_desc || `${row.minsalary || row.minsal || ''}-${row.maxsalary || row.maxsal || ''}`,
    city: detail.city || row.city, district: '', experience: '', education: detail.degree || row.degree,
    employment_type: detail.ftype || row.ftype, company_nature: '', company_size: detail.scale || row.scale, industry: detail.industry || row.industry,
    publish_time: '', refresh_time: detail.refresh || row.refresh, deadline: detail.endtime || '', tags: [...(detail.attraction || []), ...(row.c_tags || []), ...(row.i_tags || [])].join(' | '),
    skills: (detail.skills || row.skill || []).join(' | '), job_description: htmlToText(detail.info || detail.job || row.hope_you || ''),
    address: detail.address || '', recruiter_name: '', recruiter_title: '', job_url: detail.url || `https://www.shixiseng.com/intern/${row.uuid}`,
    company_url: row.c_uuid ? `https://www.shixiseng.com/com/${row.c_uuid}` : '', source_total: total, access_level: detail_status==='成功'?'公开接口完整详情':'公开接口列表（详情待续采）',acquisition_mode:'public_json_api',detail_status,collected_at: collectedAt,
  }));
}

async function collectIguopin(keyword, city) {
  const yieldWindow=new YieldWindow(discoveredIds.iguopin,config.lowYield);
  const settings=config.platforms.iguopin||{};
  const pageLimit=Math.max(1,Number(settings.maxPages)||Infinity);
  const rowLimit=Math.max(1,Number(settings.maxRows)||Infinity);
  const endpoint = 'https://gp-api.iguopin.com/api/jobs/v1/recom-job';
  const firstBody = { search: { page: 1, page_size: 20, keyword }, recom: { update_time: true, company_nature: true, hot_job: true } };
  const post = async (page) => parseIguopinPage(await checkedJsonResponse(await request(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://www.iguopin.com', referer: 'https://www.iguopin.com/' },
    body: JSON.stringify({ ...firstBody, search: { ...firstBody.search, page } }),
  }), '国聘'));
  const checkpointPath=path.join(checkpointDir,`iguopin_${safeName(keyword)}_${safeName(city.name)}.json`);
  let saved=await readOwnedCheckpoint(checkpointPath);
  const first = saved.first||await post(1);
  const pages = Math.ceil(Number(first.total || 0) / Number(first.page_size || 20));
  const records = saved.records||[...(first.list||[])];
  const save=()=>writeJsonAtomic(checkpointPath,{task_id:config.task_id,keyword,city,first:{total:first.total,page_size:first.page_size},records,lastPage:saved.lastPage||1,completed:saved.completed||false,low_yield:saved.low_yield||null});
  saved.low_yield=null;
  if(!saved.records)yieldWindow.observe(records.map(row=>row.job_id));
  await save();
  for (let page = Number(saved.lastPage||1)+1; !saved.completed && page <= Math.min(pages,pageLimit); page += 1) {
    const pageRows=(await post(page))?.list;
    if(!Array.isArray(pageRows))throw Object.assign(new Error('国聘列表结构异常；不按低收益处理'),{stopChannel:true});
    records.push(...pageRows);
    const probe=yieldWindow.observe(pageRows.map(row=>row.job_id));
    saved.lastPage=page;await save();
    if(probe.defer){saved.low_yield={...probe,at:new Date().toISOString()};deferredCombos.add(comboKey('iguopin',keyword,city.name));await save();console.log(`[低收益切换] iguopin ${keyword}/${city.name}: ${yieldNote(probe)}`);break;}
    if (page % 5 === 0 || page === pages) console.log(`iguopin ${keyword}/${city.name}: ${page}/${pages}`);
  }
  saved.completed=Number(saved.lastPage||1)>=pages;await save();
  // The quota counts distinct jobs, not repeated search hits. Keep checkpoint
  // records intact so increasing the quota never loses already fetched jobs.
  const filtered=selectIguopinRows(records,city.name,rowLimit);
  await writeJsonAtomic(comboFile('国聘', keyword, city.name),{task_id:config.task_id,keyword,city,total:first.total,records:filtered});
  return normalizeIguopin(filtered,keyword,city,first.total);
}

function normalizeIguopin(filtered,keyword,city,total) {
  return filtered.map((row) => ({
    platform: '国聘', query_keyword: keyword, query_city: city.name, job_id: row.job_id, job_name: row.job_name,
    company_id: row.company_id, company_name: row.company_name, salary: row.is_negotiable ? '面议' : `${row.min_wage || ''}-${row.max_wage || ''}${row.wage_unit_cn || ''}`,
    city: (row.district_list || []).map((item) => item.area_cn).join(' | '), district: '', experience: row.experience_cn,
    education: row.education_cn, employment_type: row.recruitment_type_cn || row.nature_cn, company_nature: row.company_info?.nature_cn,
    company_size: row.company_info?.scale_cn, industry: row.company_info?.industry_cn, publish_time: row.start_time, refresh_time: row.refresh_time || row.update_time,
    deadline: row.end_time, tags: [...(row.job_custom_tags_cn || []), row.department_cn].filter(Boolean).join(' | '), skills: (row.major_cn || []).join(' | '),
    job_description: htmlToText(row.contents), address: (row.company_info?.district_list || []).map((item) => item.address).filter(Boolean).join(' | '),
    recruiter_name: row.contact_user?.name, recruiter_title: '', job_url: `https://www.iguopin.com/job/detail?id=${row.job_id}`,
    company_url: row.company_id ? `https://www.iguopin.com/company?id=${row.company_id}` : '', source_total: total, access_level: '公开接口完整字段', acquisition_mode:'public_json_api', collected_at: collectedAt,
  }));
}

async function collectMohrss(keyword, city) {
  const settings=config.platforms.mohrss||{};
  const taskId=config.task_id||process.env.JOB_COLLECTOR_TASK_ID||null;
  const bound=value=>Number.isFinite(Number(value))&&Number(value)>0?Math.max(1,Math.floor(Number(value))):Infinity;
  const pageLimit=bound(settings.maxPages),rowLimit=bound(settings.maxRows);
  const checkpointPath=path.join(checkpointDir,`mohrss_${safeName(keyword)}_${safeName(city.name)}.json`);
  const rawPath=comboFile('中国公共招聘网',keyword,city.name);
  const searchUrl='http://job.mohrss.gov.cn/cjobs/jobinfolist/listJobinfolist';
  const owned=data=>{
    if((data.task_id??null)!==taskId)throw Object.assign(new Error('公共招聘网断点或原始数据任务 ID 不匹配；拒绝附加'),{code:'TASK_OUTPUT_OWNERSHIP',stopChannel:true});
  };
  const eligible=row=>city.name==='全国'||`${row.aab302||''} ${row.area_||''} ${row.acb202||''}`.includes(city.name);
  let saved={};
  try{saved=JSON.parse(await fs.readFile(checkpointPath,'utf8'));owned(saved);}
  catch(error){if(error.code!=='ENOENT')throw error;}
  if(!saved.records){
    // Older collectors saved one result page without a checkpoint. Reuse its
    // candidates, then request page 1 for authoritative pagination metadata.
    try{const legacy=JSON.parse(await fs.readFile(rawPath,'utf8'));owned(legacy);if(Array.isArray(legacy.records))saved={records:legacy.records,migrated:true};}
    catch(error){if(error.code!=='ENOENT')throw error;}
  }
  if(saved.records&&(!Array.isArray(saved.records)||saved.records.some(row=>!row||typeof row!=='object'||row.acb200==null)))throw Object.assign(new Error('公共招聘网断点 records 结构异常'),{code:'api_schema_changed',stopChannel:true});
  if(saved.keyword!=null&&saved.keyword!==keyword||saved.city?.name&&saved.city.name!==city.name)throw Object.assign(new Error('公共招聘网断点查询条件不匹配'),{code:'TASK_OUTPUT_OWNERSHIP',stopChannel:true});
  if(saved.lastPage!=null&&(!Number.isSafeInteger(Number(saved.lastPage))||Number(saved.lastPage)<0))throw Object.assign(new Error('公共招聘网断点页码无效'),{code:'api_schema_changed',stopChannel:true});
  const records=new Map((saved.records||[]).filter(eligible).map(row=>[String(row.acb200),row]));
  let lastPage=Number(saved.lastPage)||0,total=Number(saved.total)||0,totalPages=Number(saved.totalPages)||0,completed=Boolean(saved.completed),limitReason=null;
  const normalize=()=>[...records.values()].slice(0,rowLimit).map((row) => ({
    platform: '中国公共招聘网', query_keyword: keyword, query_city: city.name, job_id: String(row.acb200), job_name: row.aca112,
    company_id: String(row.aab001 || ''), company_name: row.aab004, salary: row.acb241 || row.acb242 ? `${row.acb241 || ''}-${row.acb242 || ''} 元/月` : '',
    city: row.area_ || row.aab302, district: row.aab302, experience: row.acb240, education: row.acb239,
    employment_type: row.acb228, company_nature: row.aac024, company_size: '', industry: row.aca111_,
    publish_time: row.s_aae397 || row.s_ctime, refresh_time: row.s_uptime || row.s_aae396, deadline: row.s_aae398,
    tags: [row.org_, row.isQualityJob && '优质岗位', row.isSkillJob && '技能岗位', row.isTechnologyJob && '技术岗位'].filter(Boolean).join(' | '),
    skills: row.keyWords, job_description: htmlToText(row.acb22a), address: row.acb202 || row.aae006,
    recruiter_name: row.aae004, recruiter_title: '', job_url: row.ace760 || new URL(`../jobinfolist/cb21/showgw?id=${row.acb200}`, searchUrl).href,
    company_url: new URL(`../jobinfolist/cb21/showdw?id=${row.aab001}`, searchUrl).href, source_total: total,
    access_level: htmlToText(row.acb22a).length>=20?'公开服务端内嵌完整字段':'公开内嵌列表（描述不足）',detail_status:htmlToText(row.acb22a).length>=20?'成功':'列表字段不完整',acquisition_mode:'server_embedded_json', collected_at: collectedAt, contact_phone: row.aae005, source_agency: row.org_,
  }));
  const save=()=>writeJsonAtomic(checkpointPath,{task_id:taskId,keyword,city,total,totalPages,lastPage,completed,records:[...records.values()],limit_reason:limitReason,migrated:Boolean(saved.migrated),acquisition_mode:'server_embedded_json'});
  const saveRaw=()=>writeJsonAtomic(rawPath,{task_id:taskId,keyword,city,total,totalPages,lastPage,completed,records:[...records.values()].slice(0,rowLimit),acquisition_mode:'server_embedded_json'});
  try{
    // Metadata is intentionally recovered for a migrated one-page export even
    // when it already reaches a requested row cap.
    for(let page=lastPage+1;!completed&&page<=pageLimit&&(records.size<rowLimit||lastPage===0);page++){
      const result=await fetchMohrssList({request,keyword,city,page,areaCode:settings.areaCode||city.areaCode||''});
      total=result.total;totalPages=result.totalPages;
      if(result.records.length===0&&total>0&&page<=totalPages)throw Object.assign(new Error('公共招聘网非空结果中出现空分页；保留断点停止'),{code:'api_schema_changed',stopChannel:true});
      let pageTruncated=false;
      for(const row of result.records){
        if(!eligible(row))continue;
        const id=String(row.acb200);
        if(!records.has(id)&&records.size>=rowLimit){pageTruncated=true;break;}
        records.set(id,row);
      }
      // A row limit cutting through a page must leave that page pending, so
      // increasing the limit later cannot skip unprocessed records.
      if(!pageTruncated)lastPage=page;
      completed=!pageTruncated&&(totalPages===0||lastPage>=totalPages);
      limitReason=pageTruncated||records.size>=rowLimit&&!completed?'max_rows':page>=pageLimit&&!completed?'max_pages':null;
      await save();
      console.log(`mohrss ${keyword}/${city.name}: ${records.size}/${total}, page ${page}/${totalPages}`);
      if(pageTruncated||records.size>=rowLimit)break;
    }
    if(!completed&&!limitReason)limitReason=records.size>=rowLimit?'max_rows':lastPage>=pageLimit?'max_pages':null;
    await save();await saveRaw();
    return normalize();
  }catch(error){
    error.partialRows=normalize();
    // A failed page is never advanced. Atomic checkpoints already contain
    // every successful page and remain available when output writing fails.
    try{await save();await saveRaw();}catch(saveError){error.checkpointError=String(saveError.message||saveError);}
    throw error;
  }
}

async function collect51job(keyword, city) {
  // 会话代理：受管浏览器提供 WAF 会话，调用网站接口（非页面 RPA）。
  const {collect51Records}=await import('./job51/collector.mjs');
  const checkpointPath=path.join(checkpointDir, `job51_${safeName(keyword)}_${safeName(city.name)}.json`);
  // Reuse successful exports from the previous collector instead of fetching them again.
  try { await fs.access(checkpointPath); }
  catch(error) {
    if(error.code!=='ENOENT')throw error;
    try {
      const old=JSON.parse(await fs.readFile(comboFile('前程无忧',keyword,city.name),'utf8'));
      if(Array.isArray(old.records))await writeJsonAtomic(checkpointPath,{task_id:config.task_id,records:old.records,total:old.total,completed:old.total===0||old.records.length>=Number(old.total),migrated:true});
    }catch(error){if(error.code!=='ENOENT')throw error;}
  }
  let result;
  try { result=await collect51Records(keyword,city,{checkpointPath,request:config.request,maxPages:config.platforms.job51.maxPages||100,maxRows:Number(config.platforms.job51.maxRows)||Infinity}); }
  catch(error) { error.partialRows=normalize51Records(error.records||[],keyword,city,error.total||0,{htmlToText,collectedAt}); throw error; }
  await writeJsonAtomic(comboFile('前程无忧',keyword,city.name),{task_id:config.task_id,keyword,city,...result});
  return normalize51Records(result.records,keyword,city,result.total,{htmlToText,collectedAt});
}

async function collectZhaopin(keyword, city) {
  // 会话直连：使用本机登录助手保存的本人登录 cookie，深翻页到 count 上限。
  // 匿名公开渠道仍每条件约100条/3页；登录后实测单条件可达约1000条/50页。
  const {loadZhaopinSession, collectZhaopinSession}=await import('./direct_zhaopin_session.mjs');
  const session=await loadZhaopinSession();
  if(!session)throw Object.assign(new Error('智联缺少本人登录会话；请先运行 zhaopin_login_helper.mjs 登录后保存 cookie'),{code:'session_required',stopChannel:true});
  const settings=config.platforms.zhaopin||{};
  const pageLimit=Math.max(1,Number(settings.maxPages)||100);
  const rowLimit=Math.max(1,Number(settings.maxRows)||Infinity);
  const checkpointPath=path.join(checkpointDir,`zhaopin_session_${safeName(keyword)}_${safeName(city.name)}.json`);
  const saved=await readOwnedCheckpoint(checkpointPath);
  const known=new Set((saved.rows||[]).map(row=>String(row.job_id)));
  const result=await collectZhaopinSession(keyword, city, {
    request, session, maxPages:pageLimit, maxRows:rowLimit,
    onPage:p=>{if(p.page%10===0||p.page<=2)console.log(`zhaopin(session) ${keyword}/${city.name}: p${p.page} +${p.added} 累计${p.unique}/${p.total}`);},
  });
  const merged=[...(saved.rows||[])];
  for(const row of result.rows){const id=String(row.job_id);if(!known.has(id)){known.add(id);merged.push(row);}}
  await writeJsonAtomic(checkpointPath,{task_id:config.task_id,keyword,city,total:result.total,rows:merged,completed:result.endReached,acquisition_mode:'session_json_api'});
  await writeJsonAtomic(comboFile('智联招聘',keyword,city.name),{task_id:config.task_id,keyword,city,total:result.total,records:merged});
  return merged.slice(0,rowLimit);
}

async function savedPublicRows(platform,keyword,city) {
  if(!['shixiseng','iguopin'].includes(platform))return [];
  const file=path.join(checkpointDir,`${platform}_${safeName(keyword)}_${safeName(city.name)}.json`);
  let saved;try{saved=JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return [];throw error;}
  if((saved.task_id??null)!==currentTaskId)return [];
  const settings=config.platforms[platform]||{};
  const limit=Math.max(1,Number(settings.maxRows)||Infinity);
  if(platform==='shixiseng') {
    const unique=[...new Map((saved.list||[]).map(record=>[record.uuid,record])).values()].slice(0,limit);
    const raw=unique.map(record=>({list:record,detail:(saved.details||{})[record.uuid]?.data||{},detail_status:saved.details?.[record.uuid]?.ok?'成功':'详情待续采'}));
    return normalizeShixi(raw,keyword,city,saved.total||0);
  }
  const records=[...new Map((saved.records||[]).map(row=>[String(row.job_id),row])).values()];
  const selected=selectIguopinRows(records,city.name,limit);
  return normalizeIguopin(selected,keyword,city,saved.first?.total||0);
}

async function collectJobonlineLimited(keyword,city) {
  assertDirectHttpCollection('jobonline');
  const {collectJobonline}=await import('./browser_public_channels.mjs');
  const checkpointPath=path.join(checkpointDir,`jobonline_${safeName(keyword)}_${safeName(city.name)}.json`);
  const saved=await readOwnedCheckpoint(checkpointPath);
  const retained=saved.records||[];
  const cap=jobonlineBudget?.limit??Math.max(1,Math.min(1000,Number(config.platforms.jobonline.maxRows)||1000));
  const remaining=Math.max(0,cap-discoveredIds.jobonline.size);
  if(!remaining)return retained;
  try {
    const rows=await collectJobonline(keyword,city,{checkpointPath,request:config.request,maxPages:config.platforms.jobonline.maxPages||100,maxRows:new Set(retained.map(row=>String(row.job_id))).size+remaining,maxNewRows:jobonlineBudget?.perRound??1000,yieldWindow:new YieldWindow(discoveredIds.jobonline,config.lowYield),onDefer:()=>deferredCombos.add(comboKey('jobonline',keyword,city.name))});
    for(const row of rows)if(row.job_id)discoveredIds.jobonline.add(String(row.job_id));
    return rows;
  } catch(error) {
    for(const row of error.partialRows||[])if(row.job_id)discoveredIds.jobonline.add(String(row.job_id));
    throw error;
  }
}

async function collectJobonlineHttp(keyword, city) {
  // 就业在线公开搜索接口（SM 加密请求，明文响应）。无服务端分页；按 关键词×城市 扩量。
  const { fetchJobonlinePage, normalizeJobonline } = await import('./direct_jobonline_adapter.mjs');
  const settings = config.platforms.jobonline || {};
  const checkpointPath = path.join(checkpointDir, `jobonline_http_${safeName(keyword)}_${safeName(city.name)}.json`);
  const saved = await readOwnedCheckpoint(checkpointPath);
  const known = new Map((saved.rows || []).map(r => [String(r.job_id), r]));
  // 会话相较完整：每次请求都新密钥；直接请求当前条件。
  const cityCode = /^\d{6}$/.test(String(city.code || '')) ? city : { ...city, code: '' };
  const { list } = await fetchJobonlinePage(request, keyword, cityCode);
  const collectedAt = new Date().toISOString();
  for (const raw of list) {
    try { const row = normalizeJobonline(raw, keyword, city.name, collectedAt); if (!known.has(row.job_id)) known.set(row.job_id, row); }
    catch (error) { if (error.stopChannel) throw error; }
  }
  const rows = [...known.values()].slice(0, Math.max(1, Number(settings.maxRows) || Infinity));
  await writeJsonAtomic(checkpointPath, { task_id: config.task_id, keyword, city, rows, acquisition_mode: 'public_json_api', collected_at: collectedAt });
  await writeJsonAtomic(comboFile('就业在线', keyword, city.name), { task_id: config.task_id, keyword, city, records: rows });
  console.log(`jobonline ${keyword}/${city.name}: ${rows.length}条`);
  return rows;
}

async function collectLiepinLimited(keyword,city) {
  // 猎聘 HTTP 直连：本人过 IP 验证后的会话 cookie（与 51job 会话方案不同，这里为纯 HTTP）。
  const {loadLiepinSession,fetchLiepinPage,normalizeLiepinCard}=await import('./direct_liepin_adapter.mjs');
  const session=await loadLiepinSession();
  if(!session)throw Object.assign(new Error('猎聘缺少本人会话；请先运行 liepin_captcha_helper.mjs 完成 IP 验证'),{code:'session_required',stopChannel:true});
  const settings=config.platforms.liepin||{};
  const pageLimit=Math.max(1,Number(settings.maxPages)||100);
  const rowLimit=Math.max(1,Number(settings.maxRows)||Infinity);
  const checkpointPath=path.join(checkpointDir,`liepin_${safeName(keyword)}_${safeName(city.name)}.json`);
  const saved=await readOwnedCheckpoint(checkpointPath);
  const known=new Map((saved.rows||[]).map(r=>[String(r.job_id),r]));
  let lastPage=Number(saved.lastPage||0);
  const pageSize=40;
  const collectedAt=new Date().toISOString();
  for(let p=lastPage;known.size<rowLimit&&p<pageLimit;p++){
    const result=await fetchLiepinPage(request,keyword,city.code,p,session,pageSize);
    const cards=result.list;
    for(const card of cards){try{const row=normalizeLiepinCard(card,keyword,city.name,collectedAt);if(!known.has(row.job_id))known.set(row.job_id,row);}catch(error){if(error.stopChannel)throw error;}}
    lastPage=p+1;
    await writeJsonAtomic(checkpointPath,{task_id:config.task_id,keyword,city,rows:[...known.values()],lastPage,completed:cards.length<pageSize,acquisition_mode:'session_json_api'});
    console.log(`liepin ${keyword}/${city.name}: 第${p+1}页 +${cards.length} 累计${known.size}`);
    if(cards.length<pageSize)break;
  }
  const rows=[...known.values()].slice(0,rowLimit);
  await writeJsonAtomic(comboFile('猎聘',keyword,city.name),{task_id:config.task_id,keyword,city,records:rows});
  return rows;
}

const collectors = { shixiseng: collectShixiseng, zhaopin: collectZhaopin, job51: collect51job, jobonline: collectJobonlineHttp, iguopin: collectIguopin, mohrss: collectMohrss, liepin:collectLiepinLimited };
const allRows = [];
const manifest = { task_id:config.task_id||process.env.JOB_COLLECTOR_TASK_ID||null,collected_at: collectedAt, config, platforms: {}, note: '无浏览器 HTTP 取数：JSON 接口及已核验公共招聘网页面内嵌数据；不执行页面脚本、不自动回退。未核验直连的渠道暂停，历史数据和断点保留；同站共享限速，访问受限即停。' };
const previousManifest = await fs.readFile(path.join(outputDir,'采集清单.json'),'utf8').then(JSON.parse).catch(()=>null);
if(previousManifest&&previousManifest.task_id!==currentTaskId)throw Error('采集清单任务 ID 不匹配');
if(requestedRound||process.env.JOB_STRUCTURED_ROUND_ONLY==='jobonline')manifest.platforms={...previousManifest?.platforms};
let resourcePaused=false,outputPaused=false;

const outcomes=await runChannels(Object.keys(collectors),Math.max(1,Math.min(2,Number(config.request?.platformConcurrency)||2)),async platform=>{
  const settings = config.platforms[platform];
  if(requestedRound&&!requestedRound.combinations.some(combo=>combo.platform===platform))return;
  if(process.env.JOB_STRUCTURED_ROUND_ONLY==='jobonline'&&platform!=='jobonline')return;
  if(!collectionChannelAvailable(platform)){
    if(!settings?.enabled)return;
    manifest.platforms[platform]={...previousManifest?.platforms?.[platform],rows:previousManifest?.platforms?.[platform]?.rows||0,errors:previousManifest?.platforms?.[platform]?.errors||[],transport_paused:true,pause_reason:collectionChannelPauseReason(platform),retained_history:true};
    console.log(`[纯接口限制] ${platform} 已暂停：${collectionChannelPauseReason(platform)}；不启动浏览器，已有渠道文件和断点保留`);
    if(settings?.enabled){
      try{
        const retained=process.env.JOB_COLLECTOR_NATIVE_STORE==='1'
          ?await (await import('./collector_native_sink.mjs')).readNativeTaskRows(outputDir,currentTaskId,platform)
          :parseChannelCsv(await fs.readFile(path.join(outputDir,`${platform}_标准化数据.csv`),'utf8'));
        allRows.push(...retained);
        manifest.platforms[platform]={...previousManifest?.platforms?.[platform],rows:retained.length,errors:previousManifest?.platforms?.[platform]?.errors||[],transport_paused:true,pause_reason:collectionChannelPauseReason(platform),retained_history:true};
      }catch(error){if(error.code!=='ENOENT')throw error;}
    }
    return;
  }
  if (!settings?.enabled) return;
  let rows = [];
  try {
    if(process.env.JOB_COLLECTOR_NATIVE_STORE==='1'){const {readNativeTaskRows}=await import('./collector_native_sink.mjs');rows=await readNativeTaskRows(outputDir,config.task_id||process.env.JOB_COLLECTOR_TASK_ID,platform);}
    else rows=parseChannelCsv(await fs.readFile(path.join(outputDir,`${platform}_标准化数据.csv`),'utf8')).filter(r=>config.keywords.includes(r.query_keyword));
  }catch(error){if(error.code!=='ENOENT')throw error;}
  if(['jobonline','liepin'].includes(platform))for(const row of rows)if(row.job_id)discoveredIds[platform].add(String(row.job_id));
  if(platform==='jobonline'){
    const targetRemaining=settings.totalMaxRows&&config.taskTargetRows?Math.max(0,Number(config.taskTargetRows)-await otherChannelValidCount(outputDir,'',currentTaskId)):Infinity;
    jobonlineBudget=jobonlineRoundBudget(settings,discoveredIds.jobonline.size,{targetRemaining});
    if(process.env.JOB_JOBONLINE_ROUND_BUDGET){
      const shared=JSON.parse(process.env.JOB_JOBONLINE_ROUND_BUDGET);
      if(shared.task_id!==currentTaskId||!Number.isSafeInteger(shared.limit)||shared.limit<0)throw Error('就业在线共享轮次预算无效');
      jobonlineBudget={...shared,maxNewRows:Math.max(0,shared.limit-discoveredIds.jobonline.size)};
    }
    console.log(`[就业在线轮次预算] 已保存${jobonlineBudget.start}条；本轮最多新增${jobonlineBudget.maxNewRows}条；每轮上限${jobonlineBudget.perRound}条`);
  }
  const blockingErrors = retainedChannelErrors(previousManifest,manifest.task_id,platform,process.env.JOB_COLLECTOR_BLOCKED_POLICY);
  if (blockingErrors.length) console.error(`${platform} 本轮跳过：上轮渠道受阻，保留 ${rows.length} 条已采集数据和断点；不自动重试受阻页面，人工处理后可单独续采`);
  const configuredCombinations=config.keywords.flatMap(keyword=>settings.cities.map(city=>({keyword,city})));
  const combinations=blockingErrors.length?[]:filterCollectionCombinations(requestedRound,platform,configuredCombinations);
  const selectedKeys=new Set(combinations.map(combo=>comboKey(platform,combo.keyword,combo.city.name)));
  // Selective rounds must retain another condition's failure without treating
  // it as a platform-wide login failure or forgetting it on the next round.
  const errors=[...blockingErrors,...(requestedRound?(previousManifest?.platforms?.[platform]?.errors||[]).filter(error=>!blockingErrors.includes(error)&&!selectedKeys.has(comboKey(platform,error.keyword,error.city?.name))):[])];
  const previousRemaining=previousManifest?.task_id===manifest.task_id ? previousManifest.platforms?.[platform]?.scheduling?.remaining||[] : [];
  const priority=new Set(previousRemaining.map(row=>comboKey(platform,row.keyword,row.city.name)));
  combinations.sort((a,b)=>Number(priority.has(comboKey(platform,b.keyword,b.city.name)))-Number(priority.has(comboKey(platform,a.keyword,a.city.name))));
  let lowStreak=0,scheduling=null;
  channel: for (const [comboIndex,{keyword,city}] of combinations.entries()) {
      if(resourcePaused||outputPaused)break channel;
      try {
        await assertCollectorResources(1024**3);
        const result = await collectors[platform](keyword, city);
        rows.push(...result);
        lowStreak=deferredCombos.has(comboKey(platform,keyword,city.name))?lowStreak+1:0;
        if(lowStreak>=3){
          scheduling={reason:'low_yield_deferred',remaining:combinations.slice(comboIndex+1),at:new Date().toISOString()};
          console.log(`[平台让位] ${platform} 连续3个条件低收益，本轮暂缓剩余 ${scheduling.remaining.length} 个条件，释放名额给其他平台；下次优先恢复未处理条件`);
          break channel;
        }
      } catch (error) {
        if(error.partialRows) rows.push(...error.partialRows);
        else rows.push(...await savedPublicRows(platform,keyword,city));
        if(error.code==='RESOURCE_PRESSURE')resourcePaused=true;
        else if(collectionExitCode(error)===42)outputPaused=true;
        const stopChannel=Boolean(error.stopChannel)&&!isConditionScopedStop(error);
        errors.push({ keyword, city, error: String(error.stack || error.message || error), code:error.code||'collection_error', stopChannel });
        console.error(`${platform} failed ${keyword}/${city.name}: ${error.message || error}`);
        if(isConditionScopedStop(error))console.log(`[条件让位] ${platform} ${keyword}/${city.name} 分页停滞；保留该断点，继续其他关键词和城市，不自动重试当前条件`);
        if(stopChannel||outputPaused) { console.error(`${platform} 已停止后续城市请求，已采集数据保留在断点；人工处理后可续采`); break channel; }
      }
  }
  const deduped = [...new Map(rows.map((row) => [`${row.platform}:${row.job_id}`, row])).values()];
  allRows.push(...deduped);
  manifest.platforms[platform] = { rows: deduped.length, errors, scheduling, acquisition:channelAcquisition[platform]||null };
  if(platform==='jobonline'){
    const checkpoints=[];
    for(const {keyword,city} of combinations){
      const saved=await readOwnedCheckpoint(path.join(checkpointDir,`jobonline_${safeName(keyword)}_${safeName(city.name)}.json`));
      // Missing checkpoints represent conditions not reached within this round.
      checkpoints.push(Object.keys(saved).length?saved:{completed:false,nextPageNo:1});
    }
    manifest.platforms[platform].continuation=jobonlineContinuation({budget:jobonlineBudget,size:discoveredIds.jobonline.size,checkpoints,errors,deferred:Boolean(scheduling),maxPages:settings.maxPages||500});
  }
  await writeCsv(path.join(outputDir, `${platform}_标准化数据.csv`), deduped);
  console.log(`${platform} complete: ${deduped.length}`);
  if(pendingOutputs.length)outputPaused=true;
},()=>resourcePaused||outputPaused);
for(const outcome of outcomes)if(outcome.error){
  const error=outcome.error;
  if(error.code==='RESOURCE_PRESSURE')resourcePaused=true;
  if(collectionExitCode(error)===42)outputPaused=true;
  manifest.platforms[outcome.item]={rows:manifest.platforms[outcome.item]?.rows||0,errors:[{error:String(error.stack||error),code:error.code||'collection_error',stopChannel:true}]};
  console.error(`${outcome.item} 独立渠道异常，其他平台继续：${error.message}`);
}

if(resourcePaused||outputPaused){
  await writeJsonAtomic(path.join(outputDir,'采集资源暂停状态.json'),{task_id:config.task_id,paused:true,at:new Date().toISOString(),platforms:manifest.platforms,pending_outputs:pendingOutputs,note:'资源或输出异常；原汇总与未处理渠道文件保持不变，处理后续采'});
  process.exitCode=resourcePaused?43:42;
}else{
// A selective round must not discard other channels from the aggregate export.
if(requestedRound||process.env.JOB_STRUCTURED_ROUND_ONLY==='jobonline')for(const platform of Object.keys(manifest.platforms)){
  if(requestedRound?requestedRound.combinations.some(combo=>combo.platform===platform):platform==='jobonline')continue;
  if(process.env.JOB_COLLECTOR_NATIVE_STORE==='1'){
    const {readNativeTaskRows}=await import('./collector_native_sink.mjs');
    allRows.push(...await readNativeTaskRows(outputDir,currentTaskId,platform));
  }else{
    try{allRows.push(...parseChannelCsv(await fs.readFile(path.join(outputDir,`${platform}_标准化数据.csv`),'utf8')));}
    catch(error){if(error.code!=='ENOENT')throw error;}
  }
}
const allDeduped = [...new Map(allRows.map((row) => [`${row.platform}:${row.job_id}`, row])).values()];
await writeJsonAtomic(path.join(outputDir, '采集清单.json'), { ...manifest, total_rows: allDeduped.length });
await fs.copyFile(configPath, path.join(outputDir, '采集配置.json'));
await writeCsv(path.join(outputDir, '多平台岗位标准化汇总.csv'), allDeduped);
if(pendingOutputs.length)await writeJsonAtomic(path.join(outputDir,'采集清单.json'),{...manifest,total_rows:allDeduped.length,pending_outputs:pendingOutputs});
console.log(JSON.stringify({ outputDir, total: allDeduped.length, platforms: manifest.platforms }));
if(pendingOutputs.length)process.exitCode=42;
else if(Object.values(manifest.platforms).some(p=>p.errors.length||p.transport_paused))process.exitCode=CHANNEL_PARTIAL;
// Exploration may temporarily defer a promising tail. Do not silently drop it:
// revisit once, after other channels/conditions have had a chance to run.
if(deferredCombos.size && !pendingOutputs.length && process.env.JOB_COLLECTOR_YIELD_RECOVERY!=='1') {
  console.log('[低收益补采] 首轮探索结束，自动恢复暂缓断点；本轮不再因重复率提前截断列表，已成功详情继续复用');
  const recovery=spawn(process.execPath,[fileURLToPath(import.meta.url),configPath,outputDir],{env:{...process.env,JOB_COLLECTOR_YIELD_RECOVERY:'1',JOB_COLLECTOR_BLOCKED_POLICY:'skip',...(jobonlineBudget?{JOB_JOBONLINE_ROUND_BUDGET:JSON.stringify({...jobonlineBudget,task_id:currentTaskId})}:{})},windowsHide:true,stdio:'inherit'});
  const code=await new Promise((resolve,reject)=>{recovery.once('error',reject);recovery.once('close',value=>resolve(value??44));});
  process.exitCode=code;
}
}
