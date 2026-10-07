import fs from 'node:fs/promises';
import path from 'node:path';
import { SpreadsheetFile, Workbook } from '@oai/artifact-tool';

const outputDir = path.resolve(process.argv[2] || '.');
const profilePath = path.resolve(process.argv[3] || path.join(outputDir, '岗位配置.json'));
const profile = JSON.parse(await fs.readFile(profilePath, 'utf8'));
const rows = JSON.parse(await fs.readFile(path.join(outputDir, '最终合并数据.json'), 'utf8'));
const quality = JSON.parse(await fs.readFile(path.join(outputDir, '数据质量报告.json'), 'utf8'));
const manifestPath = path.join(outputDir, '最终交付清单.json');
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
if(!profile.task_id || quality.task_id!==profile.task_id || manifest.task_id!==profile.task_id || rows.some(row=>row.task_id!==profile.task_id))throw new Error('交付文件任务归属不一致，拒绝导出其他任务数据');
const label = String(profile.label || '岗位');
const safeLabel = label.replace(/[\\/:*?"<>|]/g, '_');
const workbookName = `${safeLabel}岗位_${rows.length}条.xlsx`;
const workbookPath = path.join(outputDir, workbookName);

const columns = [
  'record_no', 'relevance_level', 'relevance_evidence', 'platform', 'query_keyword', 'query_city', 'job_id', 'job_name',
  'company_id', 'company_name', 'salary', 'city', 'district', 'experience', 'education', 'employment_type',
  'company_nature', 'company_size', 'industry', 'publish_time', 'refresh_time', 'deadline', 'tags', 'skills',
  'job_description', 'address', 'recruiter_name', 'recruiter_title', 'job_url', 'company_url', 'source_total',
  'access_level', 'collected_at', 'contact_phone', 'source_agency',
];
const headers = [
  '序号', '相关度分级', '相关度依据', '平台', '查询关键词', '查询城市', '岗位ID', '岗位名称', '公司ID', '公司名称',
  '薪资', '工作城市', '区县', '经验要求', '学历要求', '用工类型', '公司性质', '公司规模', '行业', '发布时间',
  '刷新时间', '截止时间', '福利/标签', '技能', '岗位描述', '工作地址', '招聘者', '招聘者职务', '岗位链接', '公司链接',
  '来源查询总量', '采集字段级别', '采集时间', '联系电话', '来源机构',
];

function clean(value, key) {
  if (value == null) return '';
  const result = String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '$1');
  if (key === 'record_no' || key === 'source_total') return Number(result) || 0;
  return result;
}

const wb = Workbook.create();
const summary = wb.worksheets.add('概览');
const data = wb.worksheets.add('岗位数据');
summary.showGridLines = false;
data.showGridLines = false;
summary.tabColor = '#0F766E';
data.tabColor = '#2563EB';

summary.getRange('A1:Q28').format.font = { name: 'Microsoft YaHei', size: 10, color: '#243143' };
summary.getRange('A2:Q2').merge();
summary.getRange('A2').values = [[`${label}岗位数据概览`]];
summary.getRange('A2').format = {
  fill: '#0F766E', font: { name: 'Microsoft YaHei', size: 18, bold: true, color: '#FFFFFF' },
  verticalAlignment: 'center', horizontalAlignment: 'left',
};
summary.getRange('A2:Q2').format.rowHeight = 34;

summary.getRange('A4:H4').values = [[
  '最终岗位数', rows.length, '', '目标数量', Number(profile.target_rows || rows.length), '', '是否达标', quality.target_reached ? '已达标' : '未达标',
]];
for (const address of ['A4', 'D4', 'G4']) summary.getRange(address).format.font = { name: 'Microsoft YaHei', size: 10, bold: true, color: '#526579' };
for (const address of ['B4', 'E4', 'H4']) {
  summary.getRange(address).format.fill = '#DDF4EF';
  summary.getRange(address).format.font = { name: 'Microsoft YaHei', size: 12, bold: true, color: '#0F5C56' };
  summary.getRange(address).format.horizontalAlignment = 'center';
}

const platformEntries = Object.entries(quality.platform_counts || {});
summary.getRange('A7:B7').values = [['平台', '岗位数']];
if (platformEntries.length) summary.getRangeByIndexes(7, 0, platformEntries.length, 2).values = platformEntries;

const relevanceEntries = Object.entries(quality.relevance_level_counts || {});
summary.getRange('D7:E7').values = [['相关度分级', '岗位数']];
if (relevanceEntries.length) summary.getRangeByIndexes(7, 3, relevanceEntries.length, 2).values = relevanceEntries;

const keywordEntries = Object.entries(quality.query_keyword_counts || {}).slice(0, 12);
summary.getRange('G7:H7').values = [['查询关键词', '岗位数']];
if (keywordEntries.length) summary.getRangeByIndexes(7, 6, keywordEntries.length, 2).values = keywordEntries;

for (const rangeAddress of ['A7:B7', 'D7:E7', 'G7:H7', 'A15:B15', 'D15:F15']) {
  summary.getRange(rangeAddress).format = {
    fill: '#155E75', font: { name: 'Microsoft YaHei', size: 10, bold: true, color: '#FFFFFF' },
    horizontalAlignment: 'center', verticalAlignment: 'center',
  };
}

const cityEntries = Object.entries(quality.query_city_counts || {}).slice(0, 12);
summary.getRange('A15:B15').values = [['查询城市', '岗位数']];
if (cityEntries.length) summary.getRangeByIndexes(15, 0, cityEntries.length, 2).values = cityEntries;

summary.getRange('D15:F15').values = [['关键字段', '已填充', '完整率']];
const completenessLabels = { job_id: '岗位ID', job_name: '岗位名称', company_name: '公司名称', city: '工作城市', job_url: '岗位链接', job_description: '岗位描述' };
const completeness = Object.entries(quality.field_completeness || {}).map(([key, value]) => [completenessLabels[key] || key, value.filled, value.rate]);
if (completeness.length) summary.getRangeByIndexes(15, 3, completeness.length, 3).values = completeness;
summary.getRange('F16:F24').format.numberFormat = '0.0%';

summary.getRange('J7:Q7').merge();
summary.getRange('J7').values = [['任务说明']];
summary.getRange('J7:Q7').format = { fill: '#155E75', font: { name: 'Microsoft YaHei', size: 10, bold: true, color: '#FFFFFF' } };
summary.getRange('J8:Q14').merge();
summary.getRange('J8').values = [[
  `岗位：${label}\n目标：${profile.target_rows || rows.length} 条\n关键词：${(profile.keywords || []).join('、')}\n` +
  '去重键：平台 + 岗位ID。相关度按标题、职责、技术栈、平台关键词依次排序。',
]];
summary.getRange('J8:Q14').format.wrapText = true;
summary.getRange('J8:Q14').format.verticalAlignment = 'top';
summary.getRange('J8:Q14').format.fill = '#F0FDFA';

summary.getRange('J16:Q16').merge();
summary.getRange('J16').values = [['账号与风控保护']];
summary.getRange('J16:Q16').format = { fill: '#155E75', font: { name: 'Microsoft YaHei', size: 10, bold: true, color: '#FFFFFF' } };
summary.getRange('J17:Q23').merge();
summary.getRange('J17').values = [[quality.account_protection || '登录态仅保存在本机独立Chrome配置目录，不导出Cookie或令牌。']];
summary.getRange('J17:Q23').format.wrapText = true;
summary.getRange('J17:Q23').format.verticalAlignment = 'top';
summary.getRange('J17:Q23').format.fill = '#F8FAFC';

for (const col of ['A', 'B', 'D', 'E', 'F', 'G', 'H']) summary.getRange(`${col}1:${col}28`).format.columnWidth = col === 'G' ? 24 : 15;
summary.getRange('C1:C28').format.columnWidth = 3;
summary.getRange('I1:I28').format.columnWidth = 3;
summary.getRange('J1:Q28').format.columnWidth = 11;
summary.getRange('A1:Q28').format.verticalAlignment = 'center';

const matrix = [headers, ...rows.map((row) => columns.map((key) => clean(row[key], key)))];
data.getRangeByIndexes(0, 0, matrix.length, headers.length).values = matrix;
data.getRange(`A1:AI${matrix.length}`).format.font = { name: 'Microsoft YaHei', size: 9, color: '#1F2937' };
data.getRange('A1:AI1').format = {
  fill: '#155E75', font: { name: 'Microsoft YaHei', size: 9, bold: true, color: '#FFFFFF' },
  horizontalAlignment: 'center', verticalAlignment: 'center', wrapText: true,
};
data.getRange(`G1:G${matrix.length}`).format.numberFormat = '@';
data.getRange(`I1:I${matrix.length}`).format.numberFormat = '@';
data.getRange(`AH1:AH${matrix.length}`).format.numberFormat = '@';
data.getRange(`A2:AI${matrix.length}`).format.verticalAlignment = 'top';
data.getRange(`A2:AI${matrix.length}`).format.rowHeight = 18;
data.freezePanes.freezeRows(1);
data.freezePanes.freezeColumns(6);
if (rows.length) {
  const table = data.tables.add(`A1:AI${matrix.length}`, true, `Jobs_${Date.now()}`);
  table.style = 'TableStyleMedium4';
  table.showFilterButton = true;
}
const widths = { A: 9, B: 16, C: 26, D: 14, E: 16, F: 12, G: 20, H: 28, I: 20, J: 28, K: 14, L: 16, M: 12, N: 13, O: 12, P: 12, Q: 14, R: 14, S: 22, T: 18, U: 18, V: 16, W: 34, X: 28, Y: 68, Z: 38, AA: 14, AB: 16, AC: 42, AD: 42, AE: 13, AF: 24, AG: 24, AH: 16, AI: 24 };
for (const [col, width] of Object.entries(widths)) data.getRange(`${col}1:${col}${matrix.length}`).format.columnWidth = width;

wb.recalculate();
const output = await SpreadsheetFile.exportXlsx(wb);
await output.save(workbookPath);
manifest.workbook = workbookName;
await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
console.log(JSON.stringify({ ok: true, workbook: workbookPath, rows: rows.length, columns: headers.length }));
