import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { chromium } from 'playwright';
import { collect51Records, collectJobonline } from './browser_public_channels.mjs';
import { parseChannelCsv } from './public_channel_csv.mjs';
import {assertCollectorResources} from './collector_resources.mjs';
import {writeJsonAtomic} from './collector_storage.mjs';

const configPath = path.resolve(process.argv[2] || 'work/job_collect_config.json');
const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
const outputDir = path.resolve(process.argv[3] || 'outputs');
const rawDir = path.join(outputDir, '原始数据');
const checkpointDir = path.join(outputDir, '断点数据');
await fs.mkdir(rawDir, { recursive: true });
await fs.mkdir(checkpointDir, { recursive: true });

const collectedAt = new Date().toISOString();
const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pendingOutputs = [];
let requestQueue = Promise.resolve();
let nextRequestAt = 0;

function safeName(value) {
  return String(value).replace(/[\\/:*?"<>|]/g, '_');
}

async function rateLimit() {
  let release;
  const previous = requestQueue;
  requestQueue = new Promise((resolve) => { release = resolve; });
  await previous;
  const wait = Math.max(0, nextRequestAt - Date.now()) + Math.floor(Math.random() * (config.request.jitterMs || 0));
  if (wait) await sleep(wait);
  nextRequestAt = Date.now() + (config.request.minimumIntervalMs || 300);
  release();
}

async function request(url, options = {}) {
  let lastError;
  for (let attempt = 1; attempt <= (config.request.attempts || 4); attempt += 1) {
    try {
      await rateLimit();
      const response = await fetch(url, {
        ...options,
        headers: {
          'user-agent': userAgent,
          'accept-language': 'zh-CN,zh;q=0.9',
          ...(options.headers || {}),
        },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < (config.request.attempts || 4)) await sleep(600 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 300));
    }
  }
  throw lastError;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
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
  const base = `https://www.shixiseng.com/interns?keyword=${encodeURIComponent(keyword)}&city=${encodeURIComponent(city.code || city.name)}&type=intern`;
  const first = parseNuxt(await (await request(base)).text()).data[0].interns;
  const total = Number(first.total || first.data.length);
  const pageSize = Number(first.pageNumber || first.data.length || 20);
  const pages = Math.ceil(total / pageSize);
  const list = [...first.data];
  for (let page = 2; page <= pages; page += 1) {
    const nuxt = parseNuxt(await (await request(`${base}&page=${page}`)).text());
    list.push(...(nuxt.data?.[0]?.interns?.data || []));
    if (page % 5 === 0 || page === pages) console.log(`shixiseng list ${keyword}/${city.name}: ${page}/${pages}`);
  }
  const unique = [...new Map(list.map((record) => [record.uuid, record])).values()];
  const checkpointPath = path.join(checkpointDir, `shixiseng_${safeName(keyword)}_${safeName(city.name)}.json`);
  let details = {};
  try { details = JSON.parse(await fs.readFile(checkpointPath, 'utf8')).details || {}; } catch {}
  const pending = unique.filter((record) => !details[record.uuid]);
  await mapLimit(pending, config.request.concurrency || 3, async (record, index) => {
    try {
      const nuxt = parseNuxt(await (await request(`https://www.shixiseng.com/intern/${record.uuid}`)).text());
      details[record.uuid] = { ok: true, data: nuxt.data?.[0]?.msg || {}, error: '' };
    } catch (error) {
      details[record.uuid] = { ok: false, data: {}, error: String(error.message || error) };
    }
    if ((index + 1) % 25 === 0 || index + 1 === pending.length) {
      await fs.writeFile(checkpointPath, JSON.stringify({ keyword, city, details }, null, 2), 'utf8');
      console.log(`shixiseng details ${keyword}/${city.name}: ${Object.keys(details).length}/${unique.length}`);
    }
  });
  const raw = unique.map((record) => ({ list: record, detail_status: details[record.uuid]?.ok ? '成功' : `失败：${details[record.uuid]?.error || ''}`, detail: details[record.uuid]?.data || {} }));
  await fs.writeFile(comboFile('实习僧', keyword, city.name), JSON.stringify({ keyword, city, total, records: raw }, null, 2), 'utf8');
  return raw.map(({ list: row, detail }) => ({
    platform: '实习僧', query_keyword: keyword, query_city: city.name, job_id: row.uuid, job_name: detail.iname || row.name,
    company_id: detail.cuuid || row.c_uuid, company_name: detail.cname || row.cname, salary: detail.salary_desc || `${row.minsalary || row.minsal || ''}-${row.maxsalary || row.maxsal || ''}`,
    city: detail.city || row.city, district: '', experience: '', education: detail.degree || row.degree,
    employment_type: detail.ftype || row.ftype, company_nature: '', company_size: detail.scale || row.scale, industry: detail.industry || row.industry,
    publish_time: '', refresh_time: detail.refresh || row.refresh, deadline: detail.endtime || '', tags: [...(detail.attraction || []), ...(row.c_tags || []), ...(row.i_tags || [])].join(' | '),
    skills: (detail.skills || row.skill || []).join(' | '), job_description: htmlToText(detail.info || detail.job || row.hope_you || ''),
    address: detail.address || '', recruiter_name: '', recruiter_title: '', job_url: detail.url || `https://www.shixiseng.com/intern/${row.uuid}`,
    company_url: row.c_uuid ? `https://www.shixiseng.com/com/${row.c_uuid}` : '', source_total: total, access_level: '公开完整详情', collected_at: collectedAt,
  }));
}

async function collectIguopin(keyword, city) {
  const endpoint = 'https://gp-api.iguopin.com/api/jobs/v1/recom-job';
  const firstBody = { search: { page: 1, page_size: 20, keyword }, recom: { update_time: true, company_nature: true, hot_job: true } };
  const post = async (page) => (await (await request(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://www.iguopin.com', referer: 'https://www.iguopin.com/' },
    body: JSON.stringify({ ...firstBody, search: { ...firstBody.search, page } }),
  })).json()).data;
  const first = await post(1);
  const pages = Math.ceil(Number(first.total || 0) / Number(first.page_size || 20));
  const records = [...(first.list || [])];
  for (let page = 2; page <= pages; page += 1) {
    records.push(...((await post(page)).list || []));
    if (page % 5 === 0 || page === pages) console.log(`iguopin ${keyword}/${city.name}: ${page}/${pages}`);
  }
  const filtered = city.name === '全国' ? records : records.filter((row) => (row.district_list || []).some((item) => String(item.area_cn || '').includes(city.name)));
  await fs.writeFile(comboFile('国聘', keyword, city.name), JSON.stringify({ keyword, city, total: first.total, records: filtered }, null, 2), 'utf8');
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
  await fs.writeFile(comboFile('中国公共招聘网', keyword, city.name), JSON.stringify({ keyword, city, total: unique.length, records: filtered }, null, 2), 'utf8');
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
      if(Array.isArray(old.records))await fs.writeFile(checkpointPath,JSON.stringify({records:old.records,total:old.total,completed:true,migrated:true},null,2),'utf8');
    }catch(error){if(error.code!=='ENOENT')throw error;}
  }
  let result;
  try { result=await collect51Records(keyword,city,{checkpointPath,request:config.request}); }
  catch(error) { error.partialRows=normalize51(error.records||[],keyword,city,error.total||0); throw error; }
  await fs.writeFile(comboFile('前程无忧',keyword,city.name),JSON.stringify({keyword,city,...result},null,2),'utf8');
  return normalize51(result.records,keyword,city,result.total);
}
function normalize51(unique,keyword,city,total) {
  return unique.map((row) => ({
    platform: '前程无忧', query_keyword: keyword, query_city: city.name, job_id: String(row.jobId), job_name: row.jobName,
    company_id: row.encCoId, company_name: row.fullCompanyName || row.companyName, salary: row.provideSalaryString,
    city: row.jobAreaLevelDetail?.cityString || row.jobAreaString, district: row.jobAreaLevelDetail?.districtString || '', experience: row.workYearString,
    education: row.degreeString, employment_type: row.isIntern ? '实习' : row.jobType, company_nature: row.companyTypeString,
    company_size: row.companySizeString, industry: row.companyIndustryType1Str || row.industryType1Str, publish_time: row.issueDateString,
    refresh_time: row.updateDateTime || row.confirmDateString, deadline: '', tags: (row.jobTags || []).join(' | '),
    skills: (row.sesameLabelList || []).map((item) => item.label || item.name || item).join(' | '), job_description: htmlToText(row.jobDescribe),
    address: row.address || row.jobAreaString, recruiter_name: row.hrName, recruiter_title: row.hrPosition, job_url: row.jobHref,
    company_url: row.encCoId ? `https://jobs.51job.com/all/co${row.encCoId}.html` : '', source_total: total, access_level: '页面会话完整列表字段', collected_at: collectedAt,
  }));
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

const collectors = { shixiseng: collectShixiseng, zhaopin: collectZhaopin, job51: collect51job, jobonline: (keyword,city)=>collectJobonline(keyword,city,{checkpointPath:path.join(checkpointDir,`jobonline_${safeName(keyword)}_${safeName(city.name)}.json`),request:config.request,maxPages:config.platforms.jobonline.maxPages||10,maxRows:config.platforms.jobonline.maxRows||100}), iguopin: collectIguopin, mohrss: collectMohrss };
const allRows = [];
const manifest = { task_id:config.task_id||process.env.JOB_COLLECTOR_TASK_ID||null,collected_at: collectedAt, config, platforms: {}, note: '公开数据采集；未绕过验证码或安全验证。BOSS、猎聘和完整智联数据需人工登录后继续。' };
let resourcePaused=false;

for (const platform of Object.keys(collectors)) {
  const settings = config.platforms[platform];
  if (!settings?.enabled) continue;
  let rows = [];
  try {
    rows=parseChannelCsv(await fs.readFile(path.join(outputDir,`${platform}_标准化数据.csv`),'utf8')).filter(r=>config.keywords.includes(r.query_keyword));
  }catch(error){if(error.code!=='ENOENT')throw error;}
  const errors = [];
  channel: for (const keyword of config.keywords) {
    for (const city of settings.cities) {
      try {
        await assertCollectorResources(1024**3);
        const result = await collectors[platform](keyword, city);
        rows.push(...result);
      } catch (error) {
        if(error.partialRows) rows.push(...error.partialRows);
        if(error.code==='RESOURCE_PRESSURE')resourcePaused=true;
        errors.push({ keyword, city, error: String(error.stack || error.message || error), code:error.code||'collection_error', stopChannel:Boolean(error.stopChannel) });
        console.error(`${platform} failed ${keyword}/${city.name}: ${error.message || error}`);
        if(error.stopChannel) { console.error(`${platform} 已停止后续城市请求，已采集数据保留在断点；人工处理后可续采`); break channel; }
      }
    }
  }
  const deduped = [...new Map(rows.map((row) => [`${row.platform}:${row.job_id}`, row])).values()];
  allRows.push(...deduped);
  manifest.platforms[platform] = { rows: deduped.length, errors };
  await writeCsv(path.join(outputDir, `${platform}_标准化数据.csv`), deduped);
  console.log(`${platform} complete: ${deduped.length}`);
  if(resourcePaused)break;
}

if(resourcePaused){
  await writeJsonAtomic(path.join(outputDir,'采集资源暂停状态.json'),{paused:true,at:new Date().toISOString(),platforms:manifest.platforms,note:'系统资源不足；原汇总与未处理渠道文件保持不变，释放资源后续采'});
  process.exitCode=43;
}else{
const allDeduped = [...new Map(allRows.map((row) => [`${row.platform}:${row.job_id}`, row])).values()];
await fs.writeFile(path.join(outputDir, '采集清单.json'), JSON.stringify({ ...manifest, total_rows: allDeduped.length }, null, 2), 'utf8');
await fs.copyFile(configPath, path.join(outputDir, '采集配置.json'));
await writeCsv(path.join(outputDir, '多平台岗位标准化汇总.csv'), allDeduped);
if(pendingOutputs.length)await fs.writeFile(path.join(outputDir,'采集清单.json'),JSON.stringify({...manifest,total_rows:allDeduped.length,pending_outputs:pendingOutputs},null,2),'utf8');
console.log(JSON.stringify({ outputDir, total: allDeduped.length, platforms: manifest.platforms }));
if(pendingOutputs.length||Object.values(manifest.platforms).some(p=>p.errors.some(e=>e.stopChannel)))process.exitCode=42;
}
