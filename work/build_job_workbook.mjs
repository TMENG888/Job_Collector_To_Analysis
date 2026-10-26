import fs from 'node:fs/promises';
import path from 'node:path';
import { SpreadsheetFile, Workbook } from '@oai/artifact-tool';

const sourceCsv = path.resolve(process.argv[2] || 'C:/Users/YS-Insight/Desktop/多平台招聘数据采集_2026-09-24/多平台岗位标准化汇总.csv');
const outputPath = path.resolve(process.argv[3] || 'outputs/01a0c301-3327-78f3-8f50-225080224319/多平台招聘岗位数据_2026-09-24.xlsx');
const previewDir = path.resolve(process.argv[4] || 'work/workbook_previews');
const csvText = await fs.readFile(sourceCsv, 'utf8');
const csvWorkbook = await Workbook.fromCSV(csvText, { sheetName: '岗位数据' });
const csvSheet = csvWorkbook.worksheets.getItem('岗位数据');
const raw = csvSheet.getUsedRange().values;
if (!raw?.length || raw.length < 2) throw new Error('CSV 中没有岗位数据');

const headerMap = {
  platform: '平台', query_keyword: '查询关键词', query_city: '查询城市', job_id: '岗位ID', job_name: '岗位名称',
  company_id: '公司ID', company_name: '公司名称', salary: '薪资', city: '城市', district: '区县', experience: '经验要求',
  education: '学历要求', employment_type: '用工类型', company_nature: '企业性质', company_size: '企业规模', industry: '行业',
  publish_time: '发布时间', refresh_time: '刷新时间', deadline: '截止时间', tags: '岗位标签', skills: '技能关键词',
  job_description: '完整岗位描述', address: '工作地址', recruiter_name: '招聘者', recruiter_title: '招聘者职位',
  job_url: '岗位链接', company_url: '公司链接', source_total: '来源结果总数', access_level: '采集完整度', collected_at: '采集时间',
};
const englishHeaders = raw[0].map((value) => String(value).replace(/^\uFEFF/, ''));
const matrix = [englishHeaders.map((key) => headerMap[key] || key), ...raw.slice(1)];
const rowCount = matrix.length - 1;
const dataEndRow = rowCount + 1;
const counts = new Map();
for (const row of raw.slice(1)) counts.set(String(row[0] || ''), (counts.get(String(row[0] || '')) || 0) + 1);

const platforms = [
  ['BOSS直聘', 'boss', '需人工登录/安全验证', 'https://www.zhipin.com/'],
  ['实习僧', 'shixiseng', '公开页面及详情完整', 'https://www.shixiseng.com/'],
  ['猎聘', 'liepin', '需人工登录/安全验证', 'https://www.liepin.com/'],
  ['智联招聘', 'zhaopin', '完整结果需人工登录', 'https://www.zhaopin.com/'],
  ['前程无忧', 'job51', '页面会话列表完整字段', 'https://we.51job.com/'],
  ['国聘', 'iguopin', '公开接口完整字段', 'https://www.iguopin.com/'],
  ['中国公共招聘网', 'mohrss', '公开页面内嵌完整字段', 'http://job.mohrss.gov.cn/'],
];

const workbook = Workbook.create();
const overview = workbook.worksheets.add('采集概览');
const data = workbook.worksheets.add('岗位数据');
const status = workbook.worksheets.add('采集状态');
overview.showGridLines = false;
data.showGridLines = false;
status.showGridLines = false;
overview.tabColor = '#1F4E78';
status.tabColor = '#5B9BD5';

const fontName = 'Arial';
const titleFormat = { font: { name: fontName, size: 15, bold: true, color: '#1F1F1F' } };
const headerFormat = {
  fill: '#1F4E78',
  font: { name: fontName, size: 10, bold: true, color: '#FFFFFF' },
  horizontalAlignment: 'center', verticalAlignment: 'center', wrapText: true,
  borders: { preset: 'inside', style: 'thin', color: '#FFFFFF' },
};
const bodyFont = { name: fontName, size: 9, color: '#262626' };

// 概览
overview.getRange('A2:H2').merge();
overview.getRange('A2').values = [['多平台招聘岗位采集概览']];
overview.getRange('A2:H2').format = titleFormat;
overview.getRange('A3:H3').format.borders = { bottom: { style: 'thin', color: '#9EADBA' } };
overview.getRange('A5:B8').values = [
  ['统计项', '结果'],
  ['当前已采集岗位', rowCount],
  ['已完成平台', 4],
  ['待人工登录平台', 3],
];
overview.getRange('A5:B5').format = headerFormat;
overview.getRange('A6:B8').format.font = bodyFont;
overview.getRange('B6:B8').format.numberFormat = '#,##0';
overview.getRange('A10:B17').values = [
  ['平台', '岗位数'],
  ...platforms.map(([name]) => [name, counts.get(name) || 0]),
];
overview.getRange('A10:B10').format = headerFormat;
overview.getRange('A11:B17').format.font = bodyFont;
overview.getRange('B11:B17').format.numberFormat = '#,##0';
overview.getRange('A19:H21').values = [
  ['范围说明', '本文件当前包含公开可访问平台的数据；智联已含匿名首屏 20 条完整字段，BOSS直聘、猎聘及智联更多结果等待人工登录后增量补采。', '', '', '', '', '', ''],
  ['采集口径', '按“关键词 × 城市”组合分页采集，并在平台允许的公开范围内获取详情字段。平台接口存在可见结果上限。', '', '', '', '', '', ''],
  ['安全说明', '未自动破解验证码、未伪造设备指纹，登录会话保存在本机独立浏览器配置中，不在工作簿中保存 Cookie。', '', '', '', '', '', ''],
];
overview.getRange('A19:A21').format = { fill: '#D9EAF7', font: { name: fontName, size: 9, bold: true, color: '#1F4E78' } };
overview.getRange('B19:H21').merge(true);
overview.getRange('B19:H21').format = { font: bodyFont, wrapText: true, verticalAlignment: 'center' };
overview.getRange('A1:H24').format.verticalAlignment = 'center';
overview.getRange('A:A').format.columnWidth = 18;
overview.getRange('B:B').format.columnWidth = 21;
overview.getRange('C:H').format.columnWidth = 12;
overview.getRange('19:21').format.rowHeight = 34;
const chart = overview.charts.add('bar', overview.getRange('A10:B17'));
chart.title = '各平台已采集岗位数';
chart.titleTextStyle.typeface = fontName;
chart.titleTextStyle.fontSize = 12;
chart.hasLegend = false;
chart.xAxis = { axisType: 'textAxis', textStyle: { typeface: fontName, fontSize: 9 } };
chart.yAxis = { numberFormatCode: '#,##0', numberFormatSourceLinked: false, textStyle: { typeface: fontName, fontSize: 9 } };
chart.setPosition('D5', 'K17');

// 岗位明细
data.getRangeByIndexes(0, 0, matrix.length, matrix[0].length).values = matrix;
data.getRangeByIndexes(0, 0, 1, matrix[0].length).format = headerFormat;
data.getRangeByIndexes(1, 0, rowCount, matrix[0].length).format.font = bodyFont;
data.getRangeByIndexes(1, 0, rowCount, matrix[0].length).format.verticalAlignment = 'top';
data.getRangeByIndexes(1, 0, rowCount, matrix[0].length).format.wrapText = false;
data.freezePanes.freezeRows(1);
data.freezePanes.freezeColumns(5);
const jobTable = data.tables.add(`A1:AD${dataEndRow}`, true, 'JobDataTable');
jobTable.style = 'TableStyleMedium2';
jobTable.showBandedRows = true;
jobTable.showFilterButton = true;
data.getRange('A:A').format.columnWidth = 13;
data.getRange('B:C').format.columnWidth = 14;
data.getRange('D:D').format.columnWidth = 18;
data.getRange('E:E').format.columnWidth = 28;
data.getRange('F:F').format.columnWidth = 18;
data.getRange('G:G').format.columnWidth = 26;
data.getRange('H:H').format.columnWidth = 16;
data.getRange('I:J').format.columnWidth = 13;
data.getRange('K:P').format.columnWidth = 15;
data.getRange('Q:S').format.columnWidth = 15;
data.getRange('T:U').format.columnWidth = 25;
data.getRange('V:V').format.columnWidth = 58;
data.getRange('W:W').format.columnWidth = 34;
data.getRange('X:Y').format.columnWidth = 18;
data.getRange('Z:AA').format.columnWidth = 42;
data.getRange('AB:AB').format.columnWidth = 15;
data.getRange('AC:AC').format.columnWidth = 24;
data.getRange('AD:AD').format.columnWidth = 24;
data.getRange(`AD2:AD${dataEndRow}`).format.numberFormat = 'yyyy-mm-dd hh:mm:ss';
data.getRange('1:1').format.rowHeight = 30;
data.getRange(`2:${dataEndRow}`).format.rowHeight = 20;

// 采集状态
status.getRange('A2:F2').merge();
status.getRange('A2').values = [['平台采集状态与限制']];
status.getRange('A2:F2').format = titleFormat;
status.getRange('A3:F3').format.borders = { bottom: { style: 'thin', color: '#9EADBA' } };
status.getRange('A5:F12').values = [
  ['平台', '状态', '已采集岗位', '查询范围', '访问方式/限制', '平台主页'],
  ['BOSS直聘', '等待人工登录', 0, '智能体开发 × 广州', '当前 IP 触发安全验证', 'https://www.zhipin.com/'],
  ['实习僧', '已完成', counts.get('实习僧') || 0, '智能体开发 × 全国', '41 个列表页；逐岗位详情', 'https://www.shixiseng.com/'],
  ['猎聘', '等待人工登录', 0, '智能体开发 × 全国', '安全中心验证码', 'https://www.liepin.com/'],
  ['智联招聘', '已采集首屏，待登录扩展', counts.get('智联招聘') || 0, '智能体开发 × 广州', '匿名首屏 20 条含完整详情；更多分页需登录', 'https://www.zhaopin.com/'],
  ['前程无忧', '已完成', counts.get('前程无忧') || 0, '智能体开发 × 广州', '搜索接口最多展示 1,000 条，本次去重后数量见左侧', 'https://we.51job.com/'],
  ['国聘', '已完成', counts.get('国聘') || 0, '智能体开发 × 全国', '公开接口最多展示 400 条，本次去重后数量见左侧', 'https://www.iguopin.com/'],
  ['中国公共招聘网', '已完成', counts.get('中国公共招聘网') || 0, '智能体开发 × 全国', '页面内嵌完整字段', 'http://job.mohrss.gov.cn/'],
];
status.getRange('A5:F5').format = headerFormat;
status.getRange('A6:F12').format = { font: bodyFont, verticalAlignment: 'top', wrapText: true };
status.getRange('C6:C12').format.numberFormat = '#,##0';
status.getRange('A14:F16').values = [
  ['复用方式', '修改采集配置中的 keywords 和各平台 cities 数组即可执行职位关键词 × 城市笛卡尔积。', '', '', '', ''],
  ['登录会话', 'BOSS直聘、猎聘、智联采用可见 Chrome 人工登录，关闭浏览器后复用本机持久化配置。', '', '', '', ''],
  ['合规边界', '遇到验证码或安全验证时暂停并由用户完成，不自动破解，不绕过网站访问控制。', '', '', '', ''],
];
status.getRange('A14:A16').format = { fill: '#D9EAF7', font: { name: fontName, size: 9, bold: true, color: '#1F4E78' } };
status.getRange('B14:F16').merge(true);
status.getRange('B14:F16').format = { font: bodyFont, wrapText: true, verticalAlignment: 'center' };
status.getRange('A:A').format.columnWidth = 18;
status.getRange('B:B').format.columnWidth = 18;
status.getRange('C:C').format.columnWidth = 14;
status.getRange('D:D').format.columnWidth = 24;
status.getRange('E:E').format.columnWidth = 52;
status.getRange('F:F').format.columnWidth = 34;
status.getRange('6:12').format.rowHeight = 36;
status.getRange('14:16').format.rowHeight = 34;
status.freezePanes.freezeRows(5);
status.getRange('B6:B12').conditionalFormats.add('containsText', { text: '等待', format: { fill: '#FCE4D6', font: { bold: true, color: '#C00000' } } });
status.getRange('B6:B12').conditionalFormats.add('containsText', { text: '已完成', format: { fill: '#E2F0D9', font: { bold: true, color: '#375623' } } });

workbook.recalculate();
const summaryCheck = await workbook.inspect({ kind: 'table', sheetId: '采集概览', range: 'A5:H21', include: 'values,formulas', tableMaxRows: 25, tableMaxCols: 10, maxChars: 7000 });
const statusCheck = await workbook.inspect({ kind: 'table', sheetId: '采集状态', range: 'A5:F16', include: 'values,formulas', tableMaxRows: 20, tableMaxCols: 8, maxChars: 7000 });
const errorCheck = await workbook.inspect({ kind: 'match', searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!', options: { useRegex: true, maxResults: 300 }, summary: 'final formula error scan', maxChars: 4000 });
console.log(summaryCheck.ndjson);
console.log(statusCheck.ndjson);
console.log(errorCheck.ndjson);

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.mkdir(previewDir, { recursive: true });
for (const [sheetName, range] of [['采集概览', 'A1:K24'], ['岗位数据', 'A1:AD24'], ['采集状态', 'A1:F18']]) {
  const preview = await workbook.render({ sheetName, range, scale: 1, format: 'png' });
  await fs.writeFile(path.join(previewDir, `${sheetName}.png`), new Uint8Array(await preview.arrayBuffer()));
}
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);
console.log(JSON.stringify({ outputPath, previewDir, rowCount, platforms: Object.fromEntries(counts) }));
