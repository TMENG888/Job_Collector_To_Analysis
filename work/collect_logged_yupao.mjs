import fs from 'node:fs/promises';
import path from 'node:path';
import {openContext} from './browser_public_channels.mjs';
import {assertListPage} from './list_page_guard.mjs';
import {writeAtomic,writeJsonAtomic} from './collector_storage.mjs';
import {createManualSearchSession} from './manual_search_session.mjs';

const outputDir = path.resolve(process.argv[2] || 'outputs');
const configPath = process.argv[3] ? path.resolve(process.argv[3]) : null;
if (!configPath) throw new Error('用法: collect_logged_yupao.mjs <输出目录> <鱼泡配置.json>');
const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
const rawDir = path.join(outputDir, '原始数据');
const checkpointDir = path.join(outputDir, '断点数据', '鱼泡直聘');
await fs.mkdir(rawDir, { recursive: true });
await fs.mkdir(checkpointDir, { recursive: true });

const keywords = config.keywords || [];
const cities = config.cities || [{ name: '全国' }];
const maxPagesPerCombo = Math.max(1, Number(config.maxPagesPerCombo || 20));
const detailLimitPerCombo = Math.max(0, Number(config.detailLimitPerCombo ?? 120));
const minimumIntervalMs = Math.max(1000, Number(config.minimumIntervalMs || 2200));
const jitterMs = Math.max(0, Number(config.jitterMs || 1400));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pause = () => sleep(minimumIntervalMs + Math.floor(Math.random() * (jitterMs + 1)));
const safeName = (value) => String(value).replace(/[\\/:*?"<>|]/g, '_');

function csvEscape(value) {
  const text = value == null ? '' : Array.isArray(value) ? value.join(' | ') : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const columns = [
  'platform', 'query_keyword', 'query_city', 'job_id', 'job_name', 'company_id', 'company_name', 'salary',
  'city', 'district', 'experience', 'education', 'employment_type', 'company_nature', 'company_size', 'industry',
  'publish_time', 'refresh_time', 'deadline', 'tags', 'skills', 'job_description', 'address', 'recruiter_name',
  'recruiter_title', 'job_url', 'company_url', 'source_total', 'access_level', 'collected_at',
];

async function writeCsv(filePath, rows) {
  const csv = [columns.join(','), ...rows.map((row) => columns.map((key) => csvEscape(row[key])).join(','))].join('\r\n');
  await writeAtomic(filePath, `\uFEFF${csv}`);
}

function jobId(record) {
  return String(record?.jobId || record?.job_id || record?.id || record?.jobInfo?.jobId || '');
}

function findJobRecords(value, results = [], seen = new Set(), depth = 0) {
  if (!value || depth > 8 || typeof value !== 'object' || seen.has(value)) return results;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === 'object' && jobId(item) && (
        item.title || item.jobName || item.detail || item.seo || item.showTags || item.jobBizId
      )) results.push(item);
      else findJobRecords(item, results, seen, depth + 1);
    }
  } else {
    for (const child of Object.values(value)) findJobRecords(child, results, seen, depth + 1);
  }
  return results;
}

function findNumber(value, keys, depth = 0, seen = new Set()) {
  if (!value || typeof value !== 'object' || depth > 5 || seen.has(value)) return 0;
  seen.add(value);
  for (const key of keys) {
    const result = value[key];
    if (Number.isFinite(Number(result)) && Number(result) >= 0) return Number(result);
  }
  for (const child of Object.values(value)) {
    const found = findNumber(child, keys, depth + 1, seen);
    if (found) return found;
  }
  return 0;
}

function byKey(value, keys, depth = 0, seen = new Set()) {
  if (value == null || typeof value !== 'object' || depth > 7 || seen.has(value)) return '';
  seen.add(value);
  for (const key of keys) {
    const found = value[key];
    if (found != null && found !== '' && typeof found !== 'object') return String(found);
  }
  for (const child of Object.values(value)) {
    const found = byKey(child, keys, depth + 1, seen);
    if (found) return found;
  }
  return '';
}

function collectNamedValues(value, names = [], depth = 0, seen = new Set()) {
  if (value == null || depth > 7 || seen.has(value)) return names;
  if (typeof value !== 'object') return names;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectNamedValues(item, names, depth + 1, seen);
  } else {
    for (const key of ['name', 'label', 'tagName', 'title']) {
      if (typeof value[key] === 'string' && value[key].trim()) names.push(value[key].trim());
    }
    for (const child of Object.values(value)) collectNamedValues(child, names, depth + 1, seen);
  }
  return names;
}

function htmlToText(value) {
  return String(value || '').replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/(p|li|div)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function normalize(record, detailEntry, keyword, cityName, sourceTotal, collectedAt) {
  const detail = detailEntry?.data || {};
  const joined = { record, detail };
  const id = jobId(record) || byKey(detail, ['jobId', 'id']);
  const bizId = String(record.jobBizId || byKey(detail, ['jobBizId', 'bizId']) || '');
  const tagsRaw = Array.isArray(record.showTags) ? record.showTags : [];
  const salaryTag = tagsRaw.find((item) => Number(item?.type) === 1)?.name || '';
  const tagNames = [...new Set([
    ...tagsRaw.map((item) => item?.name),
    ...collectNamedValues(record.occV2 || []),
    ...collectNamedValues(detail.showTags || []),
  ].filter(Boolean))];
  const company = detail.companyInfo || record.companyInfo || {};
  const recall = detail.recallAddress || record.recallAddress || {};
  const description = htmlToText(
    detail.detail || detail.jobDetail || detail.description || detail.content || detail.seo?.detail
    || record.detail || record.seo?.detail || detailEntry?.page_text || ''
  );
  const title = detail.title || detail.jobName || detail.seo?.title || record.title || record.jobName || record.seo?.title || '';
  const address = byKey(recall, ['address', 'fullAddress']) || byKey(detail, ['address', 'workAddress']) || record.address || '';
  const pagePath = bizId ? `/zhaogong/${encodeURIComponent(id)}/${encodeURIComponent(bizId)}.html` : `/zhaogong/${encodeURIComponent(id)}.html`;
  return {
    platform: '鱼泡直聘', query_keyword: keyword, query_city: cityName, job_id: id, job_name: title,
    company_id: byKey(company, ['companyId', 'enterpriseId', 'id']),
    company_name: byKey(company, ['companyName', 'enterpriseName', 'name']) || byKey(joined, ['companyName', 'enterpriseName']),
    salary: byKey(joined, ['salaryDesc', 'salaryText', 'salary']) || salaryTag,
    city: byKey(recall, ['cityName']) || byKey(joined, ['cityName', 'workCity']) || cityName,
    district: byKey(recall, ['countyName', 'districtName']) || byKey(joined, ['countyName', 'districtName']),
    experience: byKey(joined, ['experienceName', 'workExperience', 'experience']),
    education: byKey(joined, ['educationName', 'degreeName', 'education']),
    employment_type: byKey(joined, ['recruitTypeName', 'jobTypeName', 'employmentType']),
    company_nature: byKey(company, ['companyNature', 'natureName']), company_size: byKey(company, ['companySize', 'scaleName']),
    industry: byKey(company, ['industryName', 'industry']) || collectNamedValues(record.occV2 || []).slice(0, 3).join(' | '),
    publish_time: byKey(joined, ['publishTime', 'createTime', 'showDate']),
    refresh_time: byKey(joined, ['updateTime', 'sortTime', 'activeDate']), deadline: byKey(joined, ['endTime', 'deadline']),
    tags: tagNames.join(' | '), skills: collectNamedValues(detail.occV2 || record.occV2 || []).join(' | '),
    job_description: description, address,
    recruiter_name: byKey(joined, ['userName', 'recruiterName', 'bossName']), recruiter_title: byKey(joined, ['bossPosition', 'recruiterTitle']),
    job_url: `https://www.yupao.com${pagePath}`,
    company_url: byKey(company, ['companyUrl', 'enterpriseUrl']), source_total: sourceTotal,
    access_level: detailEntry?.ok ? '人工验证会话详情字段' : '人工验证会话列表字段', collected_at: collectedAt,
  };
}

async function verifyPage(page) {
  await manualSession.guard({keyword:activeState?.keyword,city:activeState?.city,combo:activeCombo,detailUrl:activeCombo?.detailUrl});
  return assertListPage(page);
}
async function navigateYupao(url) {
  try {await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});}
  catch(error) {
    if(page.isClosed())throw error;
    console.log('[导航异常] '+error.message+'；保留当前浏览器供人工检查，不自动重试');
    await verifyPage(page);
  }
}

async function saveCheckpoint(filePath, state) {
  await writeJsonAtomic(filePath,state);
}

let context;
try {context=await openContext('yupao',{headless:false});}
catch(error){console.error(error.message);process.exit(error.code==='RESOURCE_PRESSURE'?43:42);}
let page;
try {page=context.pages()[0] || await context.newPage();}
catch(error){await context.close().catch(()=>{});console.error(error.message);process.exit(42);}
page.setDefaultTimeout(18000);
const manualSession=await createManualSearchSession(outputDir,process.env.JOB_COLLECTOR_TASK_ID||config.task_id||'',page,{platform:'yupao',instanceId:context.managedSession?.session_id});
let activeCombo = null;
let activeState=null,activeCheckpoint=null;
const requestOwners=new WeakMap();
page.on('request',request=>{if(activeCombo)requestOwners.set(request,{combo:activeCombo,ready:activeCombo.searchReady,detailTarget:activeCombo.detailTargetId});});

page.on('response', async (response) => {
  if (!activeCombo) return;
  const combo=activeCombo;
  const detailTarget=combo.detailTargetId;
  const owner=requestOwners.get(response.request());
  if(owner?.combo!==combo || owner.detailTarget!==detailTarget)return;
  const url = response.url();
  const isList = ['/job/v3/list/job/list', '/job/v3/list/job/pc/card', '/job/v2/search/job/search'].some((part) => url.includes(part));
  const isDetail = ['/job/v3/detail/info', '/job/v3/detail/infoSeo', '/job/v2/job/info', '/job/v2/job/infoSeo'].some((part) => url.includes(part));
  if (!isList && !isDetail) return;
  if(isList && (!owner.ready || detailTarget))return;
  try {
    if(response.status()!==200)throw new Error(`鱼泡接口 HTTP ${response.status()}`);
    const body = await response.json();
    if(activeCombo!==combo || combo.detailTargetId!==detailTarget)return;
    if (isList) {
      if(body?.code!=null && ![0,200,'0','200'].includes(body.code))throw new Error('鱼泡职位接口业务错误：'+String(body.msg||body.message||body.code));
      const records=findJobRecords(body);
      const data=body?.data;
      const list=data?.list ?? data?.records ?? data?.items;
      const total=data?.total ?? data?.totalCount ?? data?.count;
      const empty=Array.isArray(list)&&list.length===0&&total!=null&&Number(total)===0;
      if(!records.length&&!empty)throw new Error('鱼泡未取得可识别的列表响应，不能判定无岗位');
      combo.explicitEmpty=empty&&combo.records.size===0;
      for (const record of records) {
        const id = jobId(record);
        if (id) activeCombo.records.set(id, record);
      }
      activeCombo.total = Math.max(activeCombo.total, findNumber(body, ['total', 'totalCount', 'count']));
      activeCombo.responseCount += 1;
    }
    if (isDetail && activeCombo.detailTargetId) {
      activeCombo.detailResponse = body?.data || body;
    }
  } catch(error) {if(activeCombo===combo)combo.responseError=error.message;}
});

async function selectCityAndSearch(keyword, city) {
  const searchUrl = `https://www.yupao.com/zhaogong/a1c0/?keywords=${encodeURIComponent(keyword)}`;
  await navigateYupao(searchUrl);
  await sleep(5500);
  await verifyPage(page);

  if (city.name && city.name !== '全国') {
    const cityTrigger = page.locator('.adfhc').first();
    if (await cityTrigger.isVisible().catch(() => false)) {
      await cityTrigger.click();
      await sleep(800);
      const option = page.getByText(city.name, { exact: true }).last();
      if (await option.isVisible().catch(() => false)) {
        await option.click();
        await sleep(2200);
        await verifyPage(page);
      } else throw new Error(`鱼泡城市选项 ${city.name} 不可用，已暂停，避免把全国推荐职位标为该城市`);
    } else throw new Error('鱼泡城市选择控件不可用，需检查页面结构后续采');
  }

  const input = page.locator('input[placeholder*="搜索职位"], input[placeholder*="职位、公司"]').first();
  if (await input.isVisible().catch(() => false)) {
    await input.fill(keyword);
    activeCombo.searchReady=true;
    const button = page.getByText('搜索', { exact: true }).last();
    if (await button.isVisible().catch(() => false)) await button.click();
    else await input.press('Enter');
    await sleep(4800);
    await verifyPage(page);
  } else throw new Error('鱼泡搜索输入框不可用，未执行关键词检索；不能采集默认推荐职位');
}

async function collectList(keyword, city, state, checkpointPath) {
  const combo = {
    records: new Map((state.records || []).map((record) => [jobId(record), record]).filter(([id]) => id)),
    total: Number(state.total || 0), responseCount: 0, detailTargetId: '', detailResponse: null,
    searchReady:false,explicitEmpty:false,responseError:'',
  };
  activeCombo = combo;
  await selectCityAndSearch(keyword, city);
  if (!combo.records.size) {
    const body = await verifyPage(page);
    if (/登录[，,、\s]*查看更多职位|登录注册后可以/.test(body)) {
      throw new Error('鱼泡当前会话未获得完整职位列表。请在控制台点击“打开鱼泡验证/登录”，完成人工验证和登录后再续爬。');
    }
  }
  let stagnant = 0;
  for (let pageNo = 1; pageNo <= maxPagesPerCombo; pageNo += 1) {
    if(combo.responseError)throw new Error(combo.responseError);
    if(combo.explicitEmpty)break;
    const before = combo.records.size;
    const next = page.locator('.ant-pagination-next:not(.ant-pagination-disabled), button:has-text("下一页"), a:has-text("下一页")').first();
    if (pageNo > 1 && await next.isVisible().catch(() => false)) await next.click().catch(() => {});
    else {
      await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })).catch(() => {});
      await page.mouse.wheel(0, 1900).catch(() => {});
    }
    await pause();
    await verifyPage(page);
    stagnant = combo.records.size === before ? stagnant + 1 : 0;
    state.records = [...combo.records.values()];
    state.total = combo.total;
    state.list_pages_attempted = pageNo;
    state.updated_at = new Date().toISOString();
    await saveCheckpoint(checkpointPath, state);
    console.log(`鱼泡 ${keyword}/${city.name}: 列表 ${combo.records.size}/${combo.total || '?'}，交互轮次 ${pageNo}`);
    if (stagnant >= 3 || (combo.total > 0 && combo.records.size >= combo.total)) break;
  }
  state.list_complete = combo.responseCount>0 && (combo.explicitEmpty || (combo.total>0&&combo.records.size>=combo.total));
  state.completion_reason=combo.explicitEmpty?'confirmed_empty':state.list_complete?'total_reached':'in_progress';
  await saveCheckpoint(checkpointPath, state);
  if(combo.responseError)throw new Error(combo.responseError);
  if (!state.list_complete)throw new Error(`鱼泡 ${keyword}/${city.name} 未收到有效响应或未确认列表穷尽，已保存断点；不能把缓存或停滞判定为完成`);
  return combo;
}

async function collectDetails(keyword, city, state, checkpointPath, combo) {
  const details = state.details || {};
  const records = [...combo.records.values()];
  const limit = detailLimitPerCombo === 0 ? records.length : Math.min(records.length, detailLimitPerCombo);
  const pending = records.slice(0, limit).filter((record) => !details[jobId(record)]);
  for (let index = 0; index < pending.length; index += 1) {
    const record = pending[index];
    const id = jobId(record);
    const bizId = String(record.jobBizId || '');
    const detailUrl = bizId
      ? `https://www.yupao.com/zhaogong/${encodeURIComponent(id)}/${encodeURIComponent(bizId)}.html`
      : `https://www.yupao.com/zhaogong/${encodeURIComponent(id)}.html`;
    combo.detailTargetId = id;
    combo.detailUrl=detailUrl;
    combo.detailResponse = null;
    try {
      await navigateYupao(detailUrl);
      await pause();
      const pageText = await verifyPage(page);
      details[id] = { ok: true, data: combo.detailResponse || {}, page_text: pageText.slice(0, 30000), url: page.url(), error: '' };
    } catch (error) {
      if (error.code==='USER_ACTION_REQUIRED') {
        state.details = details;
        await saveCheckpoint(checkpointPath, state);
        throw error;
      }
      details[id] = { ok: false, data: {}, page_text: '', url: detailUrl, error: String(error.message || error) };
    }
    if ((index + 1) % 10 === 0 || index + 1 === pending.length) {
      state.details = details;
      state.updated_at = new Date().toISOString();
      await saveCheckpoint(checkpointPath, state);
      console.log(`鱼泡 ${keyword}/${city.name}: 详情 ${Object.keys(details).length}/${limit}`);
    }
  }
  state.details = details;
  state.complete = state.list_complete && Object.keys(details).length >= limit;
  await saveCheckpoint(checkpointPath, state);
}

async function loadAllRows() {
  const rows = [];
  const files = (await fs.readdir(checkpointDir)).filter((name) => name.endsWith('.json'));
  for (const name of files) {
    try {
      const state = JSON.parse(await fs.readFile(path.join(checkpointDir, name), 'utf8'));
      const collectedAt = state.collected_at || state.updated_at || new Date().toISOString();
      for (const record of state.records || []) {
        const id = jobId(record);
        if (!id) continue;
        rows.push(normalize(record, state.details?.[id], state.keyword, state.city?.name || '全国', state.total, collectedAt));
      }
    } catch {}
  }
  return [...new Map(rows.map((row) => [`${row.platform}:${row.job_id}`, row])).values()];
}

try {
  for (const keyword of keywords) {
    for (const city of cities) {
      const checkpointPath = path.join(checkpointDir, `${safeName(keyword)}_${safeName(city.name)}.json`);
      let state = { keyword, city, total: 0, records: [], details: {}, list_complete: false, complete: false, collected_at: new Date().toISOString() };
      try { state = { ...state, ...JSON.parse(await fs.readFile(checkpointPath, 'utf8')) }; } catch {}
      if (state.complete && ['confirmed_empty','total_reached'].includes(state.completion_reason)) {
        console.log(`鱼泡跳过已完成：${keyword}/${city.name}，${state.records?.length || 0} 条`);
        continue;
      }
      activeState=state;activeCheckpoint=checkpointPath;
      const combo = await collectList(keyword, city, state, checkpointPath);
      await collectDetails(keyword, city, state, checkpointPath, combo);
      const rows = await loadAllRows();
      await writeCsv(path.join(outputDir, 'yupao_标准化数据.csv'), rows);
      await writeJsonAtomic(path.join(rawDir, `鱼泡直聘_${safeName(keyword)}_${safeName(city.name)}_登录会话.json`),state);
      console.log(`鱼泡合并进度：${rows.length} 条唯一岗位`);
      await pause();
    }
  }
} catch(error) {
  if(activeState){
    if(activeCombo){activeState.records=[...activeCombo.records.values()];activeState.total=activeCombo.total;}
    activeState.complete=false;activeState.pause_reason=error.message;
    await saveCheckpoint(activeCheckpoint,activeState).catch(e=>console.error('断点保存失败：'+e.message));
  }
  await writeJsonAtomic(path.join(outputDir,'鱼泡直聘_暂停原因.json'),{task_id:process.env.JOB_COLLECTOR_TASK_ID||config.task_id||'',keyword:activeState?.keyword,city:activeState?.city,stage:activeCombo?.detailTargetId?'详情采集':'列表采集',reason:error.message,url:page.url(),updated_at:new Date().toISOString()}).catch(()=>{});
  console.error(error.message);process.exitCode=error.code==='RESOURCE_PRESSURE'?43:42;
} finally {
  try {
  activeCombo = null;
  const rows = await loadAllRows();
  if (rows.length) await writeCsv(path.join(outputDir, 'yupao_标准化数据.csv'), rows);
  await writeJsonAtomic(path.join(outputDir, '鱼泡直聘_采集状态.json'), {
    rows: rows.length, updated_at: new Date().toISOString(), paused:Boolean(process.exitCode),
    note: '人工验证浏览器会话；未自动破解滑块，未复制站点签名算法。',
  });
  } catch(error){console.error(error.message);process.exitCode=42;}
  finally {await manualSession.close().catch(()=>{});await context.close().catch(() => {});}
}

const finalRows = await loadAllRows();
console.log(JSON.stringify({ platform: '鱼泡直聘', rows: finalRows.length, paused:Boolean(process.exitCode), outputDir }));
