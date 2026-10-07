import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import {openContext} from './browser_public_channels.mjs';

const outputDir = path.resolve(process.argv[2] || 'outputs');
const keyword = process.argv[3] || '智能体开发';
const cityName = process.argv[4] || '全国';
const rawDir = path.join(outputDir, '原始数据');
await fs.mkdir(rawDir, { recursive: true });
const collectedAt = new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function csvEscape(value) {
  const text = value == null ? '' : Array.isArray(value) ? value.join(' | ') : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
async function writeCsv(filePath, rows) {
  const columns = ['platform','query_keyword','query_city','job_id','job_name','company_id','company_name','salary','city','district','experience','education','employment_type','company_nature','company_size','industry','publish_time','refresh_time','deadline','tags','skills','job_description','address','recruiter_name','recruiter_title','job_url','company_url','source_total','access_level','collected_at'];
  const csv = [columns.join(','), ...rows.map((row) => columns.map((key) => csvEscape(row[key])).join(','))].join('\r\n');
  await fs.writeFile(filePath, `\uFEFF${csv}`, 'utf8');
}

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const profileDir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'CodexJobCollectorProfilesV2', 'liepin');
const port = 9232;
const context = await openContext('liepin');
const page = context.pages()[0] || await context.newPage();
const records = new Map();
let totalCounts = 0;
let totalPage = 1;

for (let pageNo = 0; pageNo < totalPage; pageNo += 1) {
  const responsePromise = page.waitForResponse((response) => response.url().includes('com.liepin.searchfront4c.pc-search-job') && !response.url().includes('cond-init') && response.status() === 200, { timeout: 45000 });
  const url = `https://www.liepin.com/zhaopin/?key=${encodeURIComponent(keyword)}&curPage=${pageNo}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  const response = await responsePromise;
  const body = await response.json();
  const data = body.data?.data || {};
  const pagination = body.data?.pagination || {};
  totalCounts = Number(pagination.totalCounts || totalCounts || 0);
  totalPage = Math.min(Number(pagination.totalPage || 1), 50);
  for (const card of data.jobCardList || []) {
    const id = card.job?.jobId;
    if (id) records.set(String(id), card);
  }
  console.log(`猎聘列表：${pageNo + 1}/${totalPage}，去重 ${records.size}/${totalCounts}`);
  await sleep(700 + Math.floor(Math.random() * 500));
}

const cards = [...records.values()];
await fs.writeFile(path.join(rawDir, `猎聘_${keyword}_${cityName}_登录列表.json`), JSON.stringify({ keyword, city: cityName, total: totalCounts, records: cards }, null, 2), 'utf8');
const rows = cards.map((card) => {
  const job = card.job || {};
  const comp = card.comp || {};
  const recruiter = card.recruiter || {};
  const labels = (job.labels || []).map((item) => item.label || item.name || item).filter(Boolean);
  return {
    platform: '猎聘', query_keyword: keyword, query_city: cityName, job_id: job.jobId, job_name: job.title,
    company_id: comp.compId, company_name: comp.compName, salary: job.salary, city: job.dq, district: '', experience: job.requireWorkYears,
    education: job.requireEduLevel, employment_type: job.jobKind, company_nature: '', company_size: comp.compScale, industry: comp.compIndustry,
    publish_time: '', refresh_time: job.refreshTime, deadline: '', tags: labels.join(' | '), skills: '', job_description: '', address: job.dq,
    recruiter_name: recruiter.recruiterName, recruiter_title: '', job_url: job.link || job.pcOuterLink, company_url: comp.link,
    source_total: totalCounts, access_level: '登录列表完整字段；详情受短信二次验证限制', collected_at: collectedAt,
  };
});
await writeCsv(path.join(outputDir, 'liepin_标准化数据.csv'), rows);
console.log(JSON.stringify({ platform: '猎聘', total: totalCounts, collected: rows.length, detail_status: '待人工短信二次验证', outputDir }));
await context.close();
