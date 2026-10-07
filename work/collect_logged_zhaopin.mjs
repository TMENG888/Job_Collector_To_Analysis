import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import {openContext} from './browser_public_channels.mjs';

const outputDir = path.resolve(process.argv[2] || 'outputs');
const keyword = process.argv[3] || '智能体开发';
const cityName = process.argv[4] || '广州';
const cityCode = process.argv[5] || '763';
const rawDir = path.join(outputDir, '原始数据');
await fs.mkdir(rawDir, { recursive: true });

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const profileDir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'CodexJobCollectorProfilesV2', 'zhaopin');
const port = 9233;
const collectedAt = new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const columns = ['platform','query_keyword','query_city','job_id','job_name','company_id','company_name','salary','city','district','experience','education','employment_type','company_nature','company_size','industry','publish_time','refresh_time','deadline','tags','skills','job_description','address','recruiter_name','recruiter_title','job_url','company_url','source_total','access_level','collected_at'];
  const csv = [columns.join(','), ...rows.map((row) => columns.map((key) => csvEscape(row[key])).join(','))].join('\r\n');
  await fs.writeFile(filePath, `\uFEFF${csv}`, 'utf8');
}

const context = await openContext('zhaopin');
const page = context.pages()[0] || await context.newPage();
const records = new Map();
let total = 0;
let endPage = false;
let lastPageIndex = 1;

page.on('response', async (response) => {
  if (!response.url().includes('/c/i/search/positions') || response.status() !== 200) return;
  try {
    const body = await response.json();
    const data = body.data || {};
    total = Number(data.count || total || 0);
    endPage = Number(data.isEndPage) === 1;
    const postData = response.request().postDataJSON?.() || {};
    lastPageIndex = Math.max(lastPageIndex, Number(postData.pageIndex || 0));
    for (const row of data.list || []) records.set(row.number || String(row.jobId), row);
  } catch {}
});

const searchUrl = `https://www.zhaopin.com/jobs?jl=${encodeURIComponent(cityCode)}&kw=${encodeURIComponent(keyword)}`;
await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
await sleep(5000);
const initialState = await page.evaluate(() => window.__INITIAL_STATE__ || null).catch(() => null);
for (const row of initialState?.positionList || []) records.set(row.number || String(row.jobId), row);
total = Number(initialState?.positionCount || total || 0);

let stagnant = 0;
for (let attempt = 0; attempt < 30 && !endPage && (!total || records.size < total); attempt += 1) {
  const before = records.size;
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
  await page.mouse.wheel(0, 1800).catch(() => {});
  await sleep(1800 + Math.floor(Math.random() * 700));
  if (records.size === before) stagnant += 1; else stagnant = 0;
  console.log(`智联分页：已采集 ${records.size}/${total || '?'}，最近页 ${lastPageIndex}`);
  if (stagnant >= 4) break;
}

const rawRecords = [...records.values()];
await fs.writeFile(path.join(rawDir, `智联招聘_${keyword}_${cityName}_登录完整.json`), JSON.stringify({ keyword, city: { name: cityName, code: cityCode }, total, records: rawRecords }, null, 2), 'utf8');
const rows = rawRecords.map((row) => {
  const detail = row.jobDetailData?.position || {};
  const staff = row.jobDetailData?.staff || row.staffCard || {};
  const location = detail.workLocation || {};
  const tagValues = [...(row.showSkillTags || []).map((item) => item.tag), ...(row.welfareLabel || []).map((item) => item.value || item.name || item), ...(row.commercialLabel || []).map((item) => item.typeName)].filter(Boolean);
  const skillValues = [...(row.jobSkillTags || []).map((item) => item.name || item.value || item), ...(row.skillLabel || []).map((item) => item.value || item.name || item), ...(row.jobKeyword?.keywords || []).map((item) => item.itemValue)].filter(Boolean);
  return {
    platform: '智联招聘', query_keyword: keyword, query_city: cityName, job_id: row.number || String(row.jobId || ''), job_name: row.name,
    company_id: row.companyNumber, company_name: row.companyName, salary: row.salary60 || row.salaryReal, city: row.workCity, district: row.cityDistrict,
    experience: row.workingExp, education: row.education, employment_type: row.workType, company_nature: row.propertyName || row.property,
    company_size: row.companySize, industry: row.industryName, publish_time: row.publishTime, refresh_time: detail.date?.positionUpdateTime || detail.date?.positionUpdateTimeText || '',
    deadline: detail.date?.dateEnd || '', tags: [...new Set(tagValues)].join(' | '), skills: [...new Set(skillValues)].join(' | '),
    job_description: htmlToText(detail.desc?.description || row.jobDescription || ''), address: location.workAddress || location.address || '',
    recruiter_name: staff.staffName || '', recruiter_title: staff.hrJob || '', job_url: row.positionUrl || row.positionURL,
    company_url: row.companyUrl, source_total: total, access_level: '登录会话完整分页字段', collected_at: collectedAt,
  };
});
await writeCsv(path.join(outputDir, 'zhaopin_标准化数据.csv'), rows);
console.log(JSON.stringify({ platform: '智联招聘', total, collected: rows.length, outputDir }));
await context.close();
