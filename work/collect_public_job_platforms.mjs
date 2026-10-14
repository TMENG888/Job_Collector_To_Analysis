import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import { chromium } from 'playwright';
import { collectJobonline } from './browser_public_channels.mjs';
import {collect51Records} from './job51/collector.mjs';
import {normalize51Records} from './job51/normalizer.mjs';
import { parseChannelCsv } from './public_channel_csv.mjs';
import {assertCollectorResources} from './collector_resources.mjs';
import {writeJsonAtomic} from './collector_storage.mjs';
import {CHANNEL_PARTIAL,boundedFetch,collectionExitCode} from './collection_policy.mjs';
import {collectionChannelAvailable} from './channel_availability.mjs';
import {retainedChannelErrors} from './task_collection_config.mjs';
import {runChannels,loadShixiDetailCache,reuseShixiDetails} from './collection_concurrency.mjs';
import {YieldWindow,yieldNote} from './collection_yield.mjs';

const configPath = path.resolve(process.argv[2] || 'work/job_collect_config.json');
const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
if(process.env.JOB_COLLECTOR_YIELD_RECOVERY==='1')config.lowYield={...config.lowYield,enabled:false};
const outputDir = path.resolve(process.argv[3] || 'outputs/public');
const rawDir = path.join(outputDir, '原始数据');
const checkpointDir = path.join(outputDir, '断点数据');
await fs.mkdir(rawDir, { recursive: true });
await fs.mkdir(checkpointDir, { recursive: true });

const collectedAt = new Date().toISOString();
const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pendingOutputs = [];
const rateQueues = new Map();
const shixiDetailCache=await loadShixiDetailCache(checkpointDir,config.task_id);
const discoveredIds={shixiseng:new Set(),iguopin:new Set(),jobonline:new Set()};
const deferredCombos=new Set();
const comboKey=(platform,keyword,city)=>JSON.stringify([platform,keyword,city]);
for(const name of await fs.readdir(checkpointDir)) {
  const platform=name.startsWith('shixiseng_')?'shixiseng':name.startsWith('iguopin_')?'iguopin':name.startsWith('jobonline_')?'jobonline':null;
  if(!platform || !name.endsWith('.json'))continue;
  const saved=JSON.parse(await fs.readFile(path.join(checkpointDir,name),'utf8'));
  if(saved.task_id!==config.task_id)continue;
  for(const row of saved.list||saved.records||[]) {
    const id=platform==='shixiseng'?row.uuid:row.job_id;
    if(id!=null && String(id)!=='')discoveredIds[platform].add(String(id));
  }
}

function safeName(value) {
  return String(value).replace(/[\\/:*?"<>|]/g, '_');
}

async function rateLimit(origin) {
  const state=rateQueues.get(origin)||{queue:Promise.resolve(),nextAt:0};
  rateQueues.set(origin,state);
  let release;
  const previous = state.queue;
  state.queue = new Promise((resolve) => { release = resolve; });
  await previous;
  const wait = Math.max(0, state.nextAt - Date.now()) + Math.floor(Math.random() * (config.request.jitterMs || 0));
  if (wait) await sleep(wait);
  state.nextAt = Date.now() + (config.request.minimumIntervalMs || 300);
  release();
}

async function request(url, options = {}) {
  return boundedFetch(url,{...options,headers:{'user-agent':userAgent,'accept-language':'zh-CN,zh;q=0.9',...options.headers}},
    {attempts:config.request.attempts,before:()=>rateLimit(new URL(url).origin)});
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

function parseNuxt(html) {
  const match = html.match(/<script[^>]*>\s*(window\.__NUXT__=[\s\S]*?)<\/script>/i);
  if (!match) throw new Error('未找到页面内嵌数据');
  const sandbox = { window: {} };
  vm.runInNewContext(match[1], sandbox, { timeout: 1200 });
  return sandbox.window.__NUXT__;
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
  const base = `https://www.shixiseng.com/interns?keyword=${encodeURIComponent(keyword)}&city=${encodeURIComponent(city.code || city.name)}&type=intern`;
  const checkpointPath = path.join(checkpointDir, `shixiseng_${safeName(keyword)}_${safeName(city.name)}.json`);
  let saved={};
  try{saved=JSON.parse(await fs.readFile(checkpointPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  let list=saved.list||[],total=saved.total||0,pages=saved.pages||0;
  const details=saved.details||{};
  for(const [id,detail] of Object.entries(details))if(detail.ok && Object.keys(detail.data||{}).length)shixiDetailCache.set(id,detail);
  const save=()=>writeJsonAtomic(checkpointPath,{task_id:config.task_id,keyword,city,total,pages,list,lastListPage:saved.lastListPage||1,listComplete:saved.listComplete||false,details,low_yield:saved.low_yield||null});
  saved.low_yield=null;
  if(!saved.list) {
    const first = parseNuxt(await (await request(base)).text()).data[0].interns;
    total = Number(first.total || first.data.length);
    pages = Math.ceil(total / Number(first.pageNumber || first.data.length || 20));
    list = [...first.data];saved.lastListPage=1;
    yieldWindow.observe(first.data.map(row=>row.uuid));
    await save();
  }
  for (let page = Number(saved.lastListPage||1)+1; !saved.listComplete && page <= Math.min(pages,pageLimit); page += 1) {
    const nuxt = parseNuxt(await (await request(`${base}&page=${page}`)).text());
    const pageRows=nuxt.data?.[0]?.interns?.data;
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
      const nuxt = parseNuxt(await (await request(`https://www.shixiseng.com/intern/${record.uuid}`)).text());
      const data=nuxt.data?.[0]?.msg;
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
  return raw.map(({ list: row, detail, detail_status }) => ({
    platform: '实习僧', query_keyword: keyword, query_city: city.name, job_id: row.uuid, job_name: detail.iname || row.name,
    company_id: detail.cuuid || row.c_uuid, company_name: detail.cname || row.cname, salary: detail.salary_desc || `${row.minsalary || row.minsal || ''}-${row.maxsalary || row.maxsal || ''}`,
    city: detail.city || row.city, district: '', experience: '', education: detail.degree || row.degree,
    employment_type: detail.ftype || row.ftype, company_nature: '', company_size: detail.scale || row.scale, industry: detail.industry || row.industry,
    publish_time: '', refresh_time: detail.refresh || row.refresh, deadline: detail.endtime || '', tags: [...(detail.attraction || []), ...(row.c_tags || []), ...(row.i_tags || [])].join(' | '),
    skills: (detail.skills || row.skill || []).join(' | '), job_description: htmlToText(detail.info || detail.job || row.hope_you || ''),
    address: detail.address || '', recruiter_name: '', recruiter_title: '', job_url: detail.url || `https://www.shixiseng.com/intern/${row.uuid}`,
    company_url: row.c_uuid ? `https://www.shixiseng.com/com/${row.c_uuid}` : '', source_total: total, access_level: detail_status==='成功'?'公开完整详情':'公开列表（详情待续采）',detail_status,collected_at: collectedAt,
  }));
}

async function collectIguopin(keyword, city) {
  const yieldWindow=new YieldWindow(discoveredIds.iguopin,config.lowYield);
  const settings=config.platforms.iguopin||{};
  const pageLimit=Math.max(1,Number(settings.maxPages)||Infinity);
  const rowLimit=Math.max(1,Number(settings.maxRows)||Infinity);
  const endpoint = 'https://gp-api.iguopin.com/api/jobs/v1/recom-job';
  const firstBody = { search: { page: 1, page_size: 20, keyword }, recom: { update_time: true, company_nature: true, hot_job: true } };
  const post = async (page) => (await (await request(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://www.iguopin.com', referer: 'https://www.iguopin.com/' },
    body: JSON.stringify({ ...firstBody, search: { ...firstBody.search, page } }),
  })).json()).data;
  const checkpointPath=path.join(checkpointDir,`iguopin_${safeName(keyword)}_${safeName(city.name)}.json`);
  let saved={};
  try{saved=JSON.parse(await fs.readFile(checkpointPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
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
  const filtered = (city.name === '全国' ? records : records.filter((row) => (row.district_list || []).some((item) => String(item.area_cn || '').includes(city.name)))).slice(0,rowLimit);
  await writeJsonAtomic(comboFile('国聘', keyword, city.name),{task_id:config.task_id,keyword,city,total:first.total,records:filtered});
  return filtered.map((row) => ({
    platform: '国聘', query_keyword: keyword, query_city: city.name, job_id: row.job_id, job_name: row.job_name,
    company_id: row.company_id, company_name: row.company_name, salary: row.is_negotiable ? '面议' : `${row.min_wage || ''}-${row.max_wage || ''}${row.wage_unit_cn || ''}`,
    city: (row.district_list || []).map((item) => item.area_cn).join(' | '), district: '', experience: row.experience_cn,
    education: row.education_cn, employment_type: row.recruitment_type_cn || row.nature_cn, company_nature: row.company_info?.nature_cn,
    company_size: row.company_info?.scale_cn, industry: row.company_info?.industry_cn, publish_time: row.start_time, refresh_time: row.refresh_time || row.update_time,
    deadline: row.end_time, tags: [...(row.job_custom_tags_cn || []), row.department_cn].filter(Boolean).join(' | '), skills: (row.major_cn || []).join(' | '),
    job_description: htmlToText(row.contents), address: (row.company_info?.district_list || []).map((item) => item.address).filter(Boolean).join(' | '),
    recruiter_name: row.contact_user?.name, recruiter_title: '', job_url: `https://www.iguopin.com/job/detail?id=${row.job_id}`,
    company_url: row.company_id ? `https://www.iguopin.com/company?id=${row.company_id}` : '', source_total: first.total, access_level: '公开接口完整字段', collected_at: collectedAt,
  }));
}

async function collectMohrss(keyword, city) {
  const searchUrl = `http://job.mohrss.gov.cn/cjobs/jobinfolist/listJobinfolist?acb332=&AREA=&AREA_name=&ACA111=&ACA111_name=&workType=&workTypeName=&textfield=${encodeURIComponent(keyword)}`;
  const html = await (await request(searchUrl)).text();
  // 岗位数据由页面脚本从隐藏字段 findjoblist 渲染；该字段已经包含完整描述、薪资、联系人和来源链接。
  const encoded = (html.match(/<input[^>]+id=["']findjoblist["'][^>]+value=["']([^"']*)["'][^>]*>/i) || [])[1] || '';
  const decoded = encoded
    .replace(/&#0*34;/gi, '"').replace(/&#0*39;/gi, "'")
    .replace(/&quot;/gi, '"').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
  if (!decoded) throw new Error('未找到页面内嵌岗位数据 findjoblist');
  const records = JSON.parse(decoded);
  const unique = [...new Map(records.map((row) => [String(row.acb200), row])).values()];
  const filtered = city.name === '全国' ? unique : unique.filter((row) => `${row.aab302 || ''} ${row.area_ || ''} ${row.acb202 || ''}`.includes(city.name));
  await writeJsonAtomic(comboFile('中国公共招聘网', keyword, city.name),{task_id:config.task_id,keyword,city,total:unique.length,records:filtered});
  console.log(`mohrss ${keyword}/${city.name}: ${filtered.length}/${unique.length}`);
  return filtered.map((row) => ({
    platform: '中国公共招聘网', query_keyword: keyword, query_city: city.name, job_id: String(row.acb200), job_name: row.aca112,
    company_id: String(row.aab001 || ''), company_name: row.aab004, salary: row.acb241 || row.acb242 ? `${row.acb241 || ''}-${row.acb242 || ''} 元/月` : '',
    city: row.area_ || row.aab302, district: row.aab302, experience: row.acb240, education: row.acb239,
    employment_type: row.acb228, company_nature: row.aac024, company_size: '', industry: row.aca111_,
    publish_time: row.s_aae397 || row.s_ctime, refresh_time: row.s_uptime || row.s_aae396, deadline: row.s_aae398,
    tags: [row.org_, row.isQualityJob && '优质岗位', row.isSkillJob && '技能岗位', row.isTechnologyJob && '技术岗位'].filter(Boolean).join(' | '),
    skills: row.keyWords, job_description: htmlToText(row.acb22a), address: row.acb202 || row.aae006,
    recruiter_name: row.aae004, recruiter_title: '', job_url: row.ace760 || new URL(`../jobinfolist/cb21/showgw?id=${row.acb200}`, searchUrl).href,
    company_url: new URL(`../jobinfolist/cb21/showdw?id=${row.aab001}`, searchUrl).href, source_total: unique.length,
    access_level: '公开页面内嵌完整字段', collected_at: collectedAt, contact_phone: row.aae005, source_agency: row.org_,
  }));
}

async function collect51job(keyword, city) {
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
  try { result=await collect51Records(keyword,city,{checkpointPath,request:config.request,maxPages:config.platforms.job51.maxPages||100}); }
  catch(error) { error.partialRows=normalize51Records(error.records||[],keyword,city,error.total||0,{htmlToText,collectedAt}); throw error; }
  await writeJsonAtomic(comboFile('前程无忧',keyword,city.name),{task_id:config.task_id,keyword,city,...result});
  return normalize51Records(result.records,keyword,city,result.total,{htmlToText,collectedAt});
}

async function collectZhaopin(keyword, city) {
  const searchUrl = `https://www.zhaopin.com/jobs?jl=${encodeURIComponent(city.code)}&kw=${encodeURIComponent(keyword)}`;
  const html = await (await request(searchUrl)).text();
  const match = html.match(/__INITIAL_STATE__\s*=\s*([\s\S]*?);?\s*<\/script>/i);
  if (!match) throw new Error('未找到智联页面内嵌数据 __INITIAL_STATE__');
  const state = JSON.parse(match[1].replace(/;$/, ''));
  const records = state.positionList || [];
  await fs.writeFile(comboFile('智联招聘', keyword, city.name), JSON.stringify({ keyword, city, visible_total: records.length, has_more: state.hasMore, records }, null, 2), 'utf8');
  return records.map((row) => {
    const detail = row.jobDetailData?.position || {};
    const staff = row.jobDetailData?.staff || row.staffCard || {};
    const location = detail.workLocation || {};
    const tagValues = [
      ...(row.showSkillTags || []).map((item) => item.tag),
      ...(row.welfareLabel || []).map((item) => item.value || item.name || item),
      ...(row.commercialLabel || []).map((item) => item.typeName),
    ].filter(Boolean);
    const skillValues = [
      ...(row.jobSkillTags || []).map((item) => item.tagName || item.name || item),
      ...(row.skillLabel || []).map((item) => item.value || item.name || item),
      ...(row.jobKeyword?.keywords || []).map((item) => item.itemValue),
    ].filter(Boolean);
    return {
      platform: '智联招聘', query_keyword: keyword, query_city: city.name, job_id: row.number || String(row.jobId || ''), job_name: row.name,
      company_id: row.companyNumber, company_name: row.companyName, salary: row.salary60 || row.salaryReal,
      city: row.workCity, district: row.cityDistrict, experience: row.workingExp, education: row.education,
      employment_type: row.workType, company_nature: row.propertyName || row.property, company_size: row.companySize, industry: row.industryName,
      publish_time: row.publishTime, refresh_time: detail.date?.positionUpdateTime || detail.date?.positionUpdateTimeText || '', deadline: detail.date?.dateEnd || '',
      tags: [...new Set(tagValues)].join(' | '), skills: [...new Set(skillValues)].join(' | '),
      job_description: htmlToText(detail.desc?.description || row.jobDescription || ''), address: location.workAddress || location.address || '',
      recruiter_name: staff.staffName || '', recruiter_title: staff.hrJob || '', job_url: row.positionUrl || row.positionURL,
      company_url: row.companyUrl, source_total: records.length, access_level: '匿名首屏完整字段（登录后可继续分页）', collected_at: collectedAt,
    };
  });
}

const collectors = { shixiseng: collectShixiseng, zhaopin: collectZhaopin, job51: collect51job, jobonline: (keyword,city)=>collectJobonline(keyword,city,{checkpointPath:path.join(checkpointDir,`jobonline_${safeName(keyword)}_${safeName(city.name)}.json`),request:config.request,maxPages:config.platforms.jobonline.maxPages||10,maxRows:config.platforms.jobonline.maxRows||100,yieldWindow:new YieldWindow(discoveredIds.jobonline,config.lowYield),onDefer:()=>deferredCombos.add(comboKey('jobonline',keyword,city.name))}), iguopin: collectIguopin, mohrss: collectMohrss };
const allRows = [];
const manifest = { task_id:config.task_id||process.env.JOB_COLLECTOR_TASK_ID||null,collected_at: collectedAt, config, platforms: {}, note: '公开数据采集；未绕过验证码或安全验证。BOSS、猎聘和完整智联数据需人工登录后继续。' };
const previousManifest = await fs.readFile(path.join(outputDir,'采集清单.json'),'utf8').then(JSON.parse).catch(()=>null);
let resourcePaused=false,outputPaused=false;

const outcomes=await runChannels(Object.keys(collectors),Math.max(1,Math.min(4,Number(config.request?.platformConcurrency)||2)),async platform=>{
  const settings = config.platforms[platform];
  if(!collectionChannelAvailable(platform)){
    console.log(`${platform} 已撤下：跳过网站请求，已有渠道文件和断点保留`);
    if(settings?.enabled){
      try{
        const retained=parseChannelCsv(await fs.readFile(path.join(outputDir,`${platform}_标准化数据.csv`),'utf8')).filter(row=>config.keywords.includes(row.query_keyword));
        allRows.push(...retained);
        manifest.platforms[platform]={rows:retained.length,errors:[],retired:true,retained_history:true};
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
  const errors = retainedChannelErrors(previousManifest,manifest.task_id,platform,process.env.JOB_COLLECTOR_BLOCKED_POLICY);
  if (errors.length) console.error(`${platform} 本轮跳过：上轮渠道受阻，保留 ${rows.length} 条已采集数据和断点；不自动重试受阻页面，人工处理后可单独续采`);
  const combinations=(errors.length?[]:config.keywords).flatMap(keyword=>settings.cities.map(city=>({keyword,city})));
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
        if(error.code==='RESOURCE_PRESSURE')resourcePaused=true;
        else if(collectionExitCode(error)===42)outputPaused=true;
        errors.push({ keyword, city, error: String(error.stack || error.message || error), code:error.code||'collection_error', stopChannel:Boolean(error.stopChannel) });
        console.error(`${platform} failed ${keyword}/${city.name}: ${error.message || error}`);
        if(error.stopChannel||outputPaused) { console.error(`${platform} 已停止后续城市请求，已采集数据保留在断点；人工处理后可续采`); break channel; }
      }
  }
  const deduped = [...new Map(rows.map((row) => [`${row.platform}:${row.job_id}`, row])).values()];
  allRows.push(...deduped);
  manifest.platforms[platform] = { rows: deduped.length, errors, scheduling };
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
const allDeduped = [...new Map(allRows.map((row) => [`${row.platform}:${row.job_id}`, row])).values()];
await writeJsonAtomic(path.join(outputDir, '采集清单.json'), { ...manifest, total_rows: allDeduped.length });
await fs.copyFile(configPath, path.join(outputDir, '采集配置.json'));
await writeCsv(path.join(outputDir, '多平台岗位标准化汇总.csv'), allDeduped);
if(pendingOutputs.length)await writeJsonAtomic(path.join(outputDir,'采集清单.json'),{...manifest,total_rows:allDeduped.length,pending_outputs:pendingOutputs});
console.log(JSON.stringify({ outputDir, total: allDeduped.length, platforms: manifest.platforms }));
if(pendingOutputs.length)process.exitCode=42;
else if(Object.values(manifest.platforms).some(p=>p.errors.length))process.exitCode=CHANNEL_PARTIAL;
// Exploration may temporarily defer a promising tail. Do not silently drop it:
// revisit once, after other channels/conditions have had a chance to run.
if(deferredCombos.size && !pendingOutputs.length && process.env.JOB_COLLECTOR_YIELD_RECOVERY!=='1') {
  console.log('[低收益补采] 首轮探索结束，自动恢复暂缓断点；本轮不再因重复率提前截断列表，已成功详情继续复用');
  const recovery=spawn(process.execPath,[fileURLToPath(import.meta.url),configPath,outputDir],{env:{...process.env,JOB_COLLECTOR_YIELD_RECOVERY:'1',JOB_COLLECTOR_BLOCKED_POLICY:'skip'},windowsHide:true,stdio:'inherit'});
  const code=await new Promise((resolve,reject)=>{recovery.once('error',reject);recovery.once('close',value=>resolve(value??44));});
  process.exitCode=code;
}
}
