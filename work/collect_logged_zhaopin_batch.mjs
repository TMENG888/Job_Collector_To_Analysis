import fs from 'node:fs/promises';
import path from 'node:path';
import {openContext,blockedReason} from './browser_public_channels.mjs';
import {assertCollectorResources} from './collector_resources.mjs';
import {writeAtomic,writeJsonAtomic} from './collector_storage.mjs';
import {zhaopinCheckpoint} from './zhaopin_checkpoint.mjs';
import {assertListPage,parseZhaopinList} from './list_page_guard.mjs';
import {createManualSearchSession} from './manual_search_session.mjs';

const outputDir = path.resolve(process.argv[2] || 'outputs');
const targetUnique = Number(process.argv[3] || 3934);
const batchConfigPath = process.argv[4] ? path.resolve(process.argv[4]) : null;
const batchConfig = batchConfigPath ? JSON.parse(await fs.readFile(batchConfigPath, 'utf8')) : {};
const rawDir = path.join(outputDir, '原始数据');
const checkpointDir = path.join(outputDir, '断点数据', '智联招聘');
await fs.mkdir(rawDir, { recursive: true });
await fs.mkdir(checkpointDir, { recursive: true });

const keywords = batchConfig.keywords || ['全栈开发', '全栈工程师', 'Web全栈', '前后端开发'];
const cities = batchConfig.cities || [
  { name: '北京', code: '530' }, { name: '天津', code: '531' }, { name: '上海', code: '538' },
  { name: '重庆', code: '551' }, { name: '南京', code: '635' }, { name: '苏州', code: '639' },
  { name: '杭州', code: '653' }, { name: '武汉', code: '736' }, { name: '广州', code: '763' },
  { name: '深圳', code: '765' }, { name: '成都', code: '801' }, { name: '西安', code: '854' },
];
const columns = [
  'platform', 'query_keyword', 'query_city', 'job_id', 'job_name', 'company_id', 'company_name', 'salary',
  'city', 'district', 'experience', 'education', 'employment_type', 'company_nature', 'company_size', 'industry',
  'publish_time', 'refresh_time', 'deadline', 'tags', 'skills', 'job_description', 'address', 'recruiter_name',
  'recruiter_title', 'job_url', 'company_url', 'source_total', 'access_level', 'collected_at',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const safeName = (value) => String(value).replace(/[\\/:*?"<>|]/g, '_');

function htmlToText(value) {
  return String(value || '').replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/(p|li|div)>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function csvEscape(value) {
  const text = value == null ? '' : Array.isArray(value) ? value.join(' | ') : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function writeCsv(filePath, rows) {
  const csv = [columns.join(','), ...rows.map((row) => columns.map((key) => csvEscape(row[key])).join(','))].join('\r\n');
  await writeAtomic(filePath, `\uFEFF${csv}`);
}

function normalize(row, keyword, cityName, sourceTotal, collectedAt) {
  const detail = row.jobDetailData?.position || {};
  const staff = row.jobDetailData?.staff || row.staffCard || {};
  const location = detail.workLocation || {};
  const tagValues = [
    ...(row.showSkillTags || []).map((item) => item.tag),
    ...(row.welfareLabel || []).map((item) => item.value || item.name || item),
    ...(row.commercialLabel || []).map((item) => item.typeName),
  ].filter(Boolean);
  const skillValues = [
    ...(row.jobSkillTags || []).map((item) => item.tagName || item.name || item.value || item),
    ...(row.skillLabel || []).map((item) => item.value || item.name || item),
    ...(row.jobKeyword?.keywords || []).map((item) => item.itemValue),
  ].filter(Boolean);
  return {
    platform: '智联招聘', query_keyword: keyword, query_city: cityName,
    job_id: row.number || String(row.jobId || ''), job_name: row.name,
    company_id: row.companyNumber, company_name: row.companyName,
    salary: row.salary60 || row.salaryReal, city: row.workCity, district: row.cityDistrict,
    experience: row.workingExp, education: row.education, employment_type: row.workType,
    company_nature: row.propertyName || row.property, company_size: row.companySize, industry: row.industryName,
    publish_time: row.publishTime, refresh_time: detail.date?.positionUpdateTime || detail.date?.positionUpdateTimeText || '',
    deadline: detail.date?.dateEnd || '', tags: [...new Set(tagValues)].join(' | '),
    skills: [...new Set(skillValues)].join(' | '),
    job_description: htmlToText(detail.desc?.description || row.jobDescription || ''),
    address: location.workAddress || location.address || '', recruiter_name: staff.staffName || '',
    recruiter_title: staff.hrJob || '', job_url: row.positionUrl || row.positionURL,
    company_url: row.companyUrl, source_total: sourceTotal,
    access_level: '人工登录会话正常页面分页字段', collected_at: collectedAt,
  };
}

async function loadExisting() {
  const combined = new Map();
  const files = await fs.readdir(checkpointDir).catch(() => []);
  for (const file of files.filter((name) => name.endsWith('.json'))) {
    try {
      const data = JSON.parse(await fs.readFile(path.join(checkpointDir, file), 'utf8'));
      for (const row of data.records || []) {
        const id = row.number || String(row.jobId || '');
        if (id) combined.set(id, { raw: row, keyword: data.keyword, cityName: data.city?.name, total: data.total, collectedAt: data.collected_at });
      }
    } catch {}
  }
  return combined;
}

const existing = await loadExisting();
console.log(`智联断点载入：${existing.size}/${targetUnique}`);
if (existing.size >= targetUnique) {
  const rows = [...existing.values()].slice(0, targetUnique).map((item) => normalize(item.raw, item.keyword, item.cityName, item.total, item.collectedAt));
  await writeCsv(path.join(outputDir, 'zhaopin_标准化数据.csv'), rows);
  console.log(JSON.stringify({ platform: '智联招聘', collected: rows.length, resumed: true, outputDir }));
  process.exit(0);
}

let context;
try { context = await openContext('zhaopin',{headless:false}); }
catch(error) { console.error(error.message); process.exit(error.code==='RESOURCE_PRESSURE'?43:42); }
let page;
try { page = context.pages()[0] || await context.newPage(); }
catch(error) { await context.close().catch(()=>{}); console.error(error.message); process.exit(42); }
page.setDefaultTimeout(20000);
const manualSession=await createManualSearchSession(outputDir,process.env.JOB_COLLECTOR_TASK_ID||batchConfig.task_id||'',page,{instanceId:context.managedSession?.session_id});
let active = null;
let checkpointFailure = null;
let pendingCheckpoint = Promise.resolve();
async function flushCheckpoint(current) {
  await writeJsonAtomic(path.join(checkpointDir,`${safeName(current.keyword)}_${safeName(current.city.name)}.json`),zhaopinCheckpoint(current));
}
function persistPage(current) {
  pendingCheckpoint=pendingCheckpoint.then(()=>flushCheckpoint(current)).catch(e=>{checkpointFailure=e;});
}

const requestOwners=new WeakMap();
page.on('request',request=>{if(active)requestOwners.set(request,active.token);});
page.on('response', async (response) => {
  if (!active || !response.url().includes('/c/i/search/positions')) return;
  const token = active.token;
  if(requestOwners.get(response.request())!==token)return;
  try {
    if(response.status()!==200)throw new Error(`智联职位接口 HTTP ${response.status()}`);
    const body = await response.json();
    if (!active || active.token !== token) return;
    const parsed=parseZhaopinList(body);
    const data = body.data;
    active.validResponse=true;
    active.explicitEmpty=parsed.explicitEmpty && active.records.size===0;
    active.total = parsed.total;
    active.endPage = parsed.endPage;
    const postData = response.request().postDataJSON?.() || {};
    active.lastPageIndex = Math.max(active.lastPageIndex, Number(postData.pageIndex || 0));
    for (const row of data.list || []) {
      const id = row.number || String(row.jobId || '');
      if (id) active.records.set(id, row);
    }
    persistPage(active);
  } catch(error) {if(active?.token===token)active.responseError=error.message;}
});

try {
  outer: for (const keyword of keywords) {
    for (const city of cities) {
      if (existing.size >= targetUnique) break outer;
      await assertCollectorResources();
      const checkpointPath = path.join(checkpointDir, `${safeName(keyword)}_${safeName(city.name)}.json`);
      let savedCheckpoint = null;
      try {
        savedCheckpoint = JSON.parse(await fs.readFile(checkpointPath, 'utf8'));
        const savedRows = Array.isArray(savedCheckpoint.records) ? savedCheckpoint.records.length : 0;
        const savedTotal = Number(savedCheckpoint.total || 0);
        // Older versions marked every non-empty checkpoint complete. Trust only
        // evidence that the result set was actually exhausted.
        const actuallyComplete = savedCheckpoint.end_page === true
          || (savedTotal > 0 && savedRows >= savedTotal)
          || ['end_page', 'total_reached','confirmed_empty'].includes(savedCheckpoint.completion_reason);
        if (actuallyComplete) {
          console.log(`智联跳过已穷尽：${keyword}/${city.name}，${savedRows} 条`);
          continue;
        }
      } catch {}

      const current = {
        token: `${Date.now()}_${Math.random()}`, keyword, city,
        records: new Map((savedCheckpoint?.records || []).map((row) => [row.number || String(row.jobId || ''), row]).filter(([id]) => id)),
        total: Number(savedCheckpoint?.total || 0), endPage: false,
        lastPageIndex: Number(savedCheckpoint?.last_page_index || 1),
        validResponse:false,explicitEmpty:false,responseError:'',
      };
      const resumeSize = current.records.size;
      active = current;
      const searchUrl = `https://www.zhaopin.com/jobs?jl=${encodeURIComponent(city.code)}&kw=${encodeURIComponent(keyword)}`;
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(4800 + Math.floor(Math.random() * 1200));
      await manualSession.guard(current);
      const initialState = await page.evaluate(() => {
        if(window.__INITIAL_STATE__)return window.__INITIAL_STATE__;
        // Some pages store JSON only in an inline assignment; never eval site code.
        const script=[...document.querySelectorAll('script')].find(s=>s.textContent.includes('__INITIAL_STATE__='));
        try{return JSON.parse(script.textContent.split('__INITIAL_STATE__=')[1].replace(/;\s*$/,''));}catch{return null;}
      }).catch(() => null);
      for (const row of initialState?.positionList || []) {
        const id = row.number || String(row.jobId || '');
        if (id) current.records.set(id, row);
      }
      if(initialState?.positionList?.length)current.validResponse=true;
      current.total = Number(initialState?.positionCount || current.total || 0);
      persistPage(current);

      let stagnant = 0;
      for (let attempt = 0; attempt < 80 && !current.explicitEmpty && !current.endPage && (!current.total || current.records.size < current.total); attempt += 1) {
        await manualSession.guard(current);
        if(current.responseError)throw new Error(current.responseError);
        if(checkpointFailure)throw checkpointFailure;
        if(attempt%3===0)await assertCollectorResources();
        const prompt=await page.locator('.geetest_panel, .verify-wrap, .captcha-dialog, .login-dialog').filter({visible:true}).allInnerTexts();
        const reason=blockedReason(prompt.join('\n'));
        if(reason)await manualSession.guard(current,reason);
        const before = current.records.size;
        await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })).catch(() => {});
        await sleep(500 + Math.floor(Math.random() * 350));
        await page.mouse.wheel(0, 1600 + Math.floor(Math.random() * 500)).catch(() => {});
        await sleep(1500 + Math.floor(Math.random() * 900));
        stagnant = current.records.size === before ? stagnant + 1 : 0;
        if ((attempt + 1) % 3 === 0 || current.endPage) {
          console.log(`智联 ${keyword}/${city.name}: ${current.records.size}/${current.total || '?'}，页 ${current.lastPageIndex}`);
        }
        if (stagnant >= 6) break;
      }
      await manualSession.guard(current);
      if(current.responseError)throw new Error(current.responseError);
      if(!current.validResponse)throw new Error(`智联 ${keyword}/${city.name} 未收到有效职位响应，不能将 0/? 或历史缓存判定为采集完成`);
      if(!current.explicitEmpty && !current.endPage && !(current.total>0&&current.records.size>=current.total))
        throw new Error(`智联 ${keyword}/${city.name} 列表停滞且未确认采集穷尽，已保留断点`);

      const collectedAt = new Date().toISOString();
      await pendingCheckpoint;
      if(checkpointFailure)throw checkpointFailure;
      const rawRecords = [...current.records.values()];
      const totalReached = current.total > 0 && rawRecords.length >= current.total;
      const completed = current.explicitEmpty || current.endPage || totalReached;
      const completionReason = current.explicitEmpty ? 'confirmed_empty' : current.endPage ? 'end_page' : totalReached ? 'total_reached' : 'stagnant_or_page_limit';
      await writeJsonAtomic(checkpointPath, {
        keyword, city, total: current.total, complete: completed, end_page: current.endPage,
        completion_reason: completionReason, last_page_index: current.lastPageIndex,
        resumed_from: resumeSize, new_records: Math.max(0, rawRecords.length - resumeSize),
        collected_at: collectedAt, records: rawRecords,
      });
      await writeJsonAtomic(path.join(rawDir, `智联招聘_${safeName(keyword)}_${safeName(city.name)}_登录完整.json`), {
        keyword, city, total: current.total, collected_at: collectedAt, records: rawRecords,
      });

      for (const row of rawRecords) {
        const id = row.number || String(row.jobId || '');
        if (id && !existing.has(id)) existing.set(id, { raw: row, keyword, cityName: city.name, total: current.total, collectedAt });
      }
      const snapshot = [...existing.values()].slice(0, targetUnique).map((item) => normalize(item.raw, item.keyword, item.cityName, item.total, item.collectedAt));
      await writeCsv(path.join(outputDir, 'zhaopin_标准化数据.csv'), snapshot);
      console.log(`智联合并进度：${existing.size}/${targetUnique}（本组合 ${rawRecords.length} 条）`);
      active = null;
      if (existing.size >= targetUnique) break outer;
      await sleep(4200 + Math.floor(Math.random() * 2400));
    }
  }
} catch(error) {
  await pendingCheckpoint;
  if(active)await flushCheckpoint(active).catch(e=>console.error('断点保存失败：'+e.message));
  await writeJsonAtomic(path.join(outputDir,'智联招聘_暂停原因.json'),{keyword:active?.keyword,city:active?.city,stage:'列表采集',reason:error.message,url:page.url(),updated_at:new Date().toISOString()}).catch(()=>{});
  console.error(error.message);
  process.exitCode=error.code==='RESOURCE_PRESSURE'?43:42;
} finally {
  active = null;
  await manualSession.close().catch(()=>{});
  await context.close().catch(() => {});
}

if(!process.exitCode){
const finalRows = [...existing.values()].slice(0, targetUnique).map((item) => normalize(item.raw, item.keyword, item.cityName, item.total, item.collectedAt));
await writeCsv(path.join(outputDir, 'zhaopin_标准化数据.csv'), finalRows);
await writeJsonAtomic(path.join(outputDir, '智联招聘_采集状态.json'), {
  target_unique: targetUnique, collected_unique: existing.size, output_rows: finalRows.length,
  completed: finalRows.length >= targetUnique, updated_at: new Date().toISOString(),
});
console.log(JSON.stringify({ platform: '智联招聘', target: targetUnique, unique: existing.size, outputRows: finalRows.length, outputDir }));
}
