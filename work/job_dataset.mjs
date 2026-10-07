import fs from 'node:fs/promises';
import path from 'node:path';
import { Workbook, SpreadsheetFile, FileBlob } from '@oai/artifact-tool';

export const jobColumnAliases = {
  record_no: '序号', relevance_level: '相关度分级', relevance_evidence: '相关度依据', platform: '平台',
  query_keyword: '查询关键词', query_city: '查询城市', job_id: '岗位ID', job_name: '岗位名称',
  company_id: '公司ID', company_name: '公司名称', salary: '薪资', city: '工作城市', district: '区县',
  experience: '经验要求', education: '学历要求', employment_type: '用工类型', company_nature: '公司性质',
  company_size: '公司规模', industry: '行业', publish_time: '发布时间', refresh_time: '刷新时间', deadline: '截止时间',
  tags: '福利/标签', skills: '技能', job_description: '岗位描述', address: '工作地址', recruiter_name: '招聘者',
  recruiter_title: '招聘者职务', job_url: '岗位链接', company_url: '公司链接', source_total: '来源查询总量',
  access_level: '采集字段级别', collected_at: '采集时间', contact_phone: '联系电话', source_agency: '来源机构',
};

export async function readJobDataset(inputFile, requestedSheet = '岗位数据') {
  const ext = path.extname(inputFile).toLowerCase();
  if (!['.xlsx', '.csv'].includes(ext)) throw new Error('仅支持 XLSX 或 UTF-8 标准化 CSV 数据');
  const before = await fs.stat(inputFile);
  const workbook = ext === '.csv'
    ? await Workbook.fromCSV((await fs.readFile(inputFile, 'utf8')).replace(/^\uFEFF/, ''), { sheetName: '岗位数据' })
    : await SpreadsheetFile.importXlsx(await FileBlob.load(inputFile));
  const after = await fs.stat(inputFile);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('采集数据正在更新，请稍后重试；本轮未读取混合版本');
  const names = workbook.worksheets.items.map(s => s.name);
  const sheet = workbook.worksheets.getItem(names.includes(requestedSheet) ? requestedSheet : names.includes('岗位数据') ? '岗位数据' : names[0]);
  const values = sheet.getUsedRange(true).values;
  if (!values?.length) throw new Error('数据文件为空');
  const headers = values[0].map(v => { const name = String(v ?? '').trim(); return jobColumnAliases[name] || name; });
  if (new Set(headers).size !== headers.length) throw new Error('映射后存在重复字段名，请整理输入数据');
  for (const field of ['岗位名称', '岗位描述']) if (!headers.includes(field)) throw new Error(`数据缺少字段：${field}`);
  const rows = values.slice(1).map((r, i) => ({ row_no: i + 2, ...Object.fromEntries(headers.map((h, c) => [h, r[c] ?? ''])) }))
    .filter(r => headers.some(h => String(r[h] ?? '').trim()));
  return { sheetName: sheet.name, headers, rows, source: { format: ext.slice(1), size: after.size, modified_at: after.mtime.toISOString() } };
}
