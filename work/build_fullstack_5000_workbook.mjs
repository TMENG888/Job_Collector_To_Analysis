import fs from 'node:fs/promises';
import path from 'node:path';
import { SpreadsheetFile, Workbook } from '@oai/artifact-tool';

const mode = process.argv[4] || 'fullstack';
const sharedSources = '智联招聘：https://www.zhaopin.com/\n实习僧：https://www.shixiseng.com/\n国聘：https://www.iguopin.com/\n中国公共招聘网：http://job.mohrss.gov.cn/';
const sharedProtection = '公开渠道（实习僧、国聘、中国公共招聘网）不使用账号；智联招聘使用用户人工登录后的独立本地 Chrome 配置目录，以单并发、随机间隔、正常页面滚动方式采集。未导出 Cookie、访问令牌或账户资料，未破解验证码，也未伪造设备指纹。岗位按“平台 + 岗位ID”去重。';
const metadata = {
  agentdev: {
    title: '智能体开发岗位数据概览', workbookName: '智能体开发岗位_5000条.xlsx',
    jsonName: '智能体开发岗位_5000条_标准化数据.json', previewDir: 'work/agentdev_5000_previews',
    inspectPath: 'work/agentdev_5000_workbook.inspect.ndjson',
    platforms: ['智联招聘', '实习僧', '国聘', '中国公共招聘网'],
    relevance: ['标题直接匹配', '职责直接匹配', '大模型技能匹配', 'AI开发相关匹配'],
    keywords: ['智能体开发', '智能体开发工程师', 'AI Agent开发', 'Agent开发工程师', '大模型智能体开发'],
    note: `${sharedProtection}候选池经严格相关度过滤，仅保留有智能体/Agent直接证据、大模型技能证据或明确AI开发证据的岗位。`,
    sourceText: sharedSources, tableName: 'AgentDevJobsTable',
  },
  bigdata: {
    title: '大数据开发工程师岗位数据概览', workbookName: '大数据开发工程师岗位_5000条.xlsx',
    jsonName: '大数据开发工程师岗位_5000条_标准化数据.json', previewDir: 'work/bigdata_5000_previews',
    inspectPath: 'work/bigdata_5000_workbook.inspect.ndjson',
    platforms: ['智联招聘', '实习僧', '国聘', '中国公共招聘网'],
    relevance: ['标题直接匹配', '职责直接匹配', '大数据技能匹配', '平台关键词匹配'],
    keywords: ['大数据开发工程师', '大数据开发', '数据开发工程师', '大数据工程师', 'Hadoop开发工程师', 'Spark开发工程师'],
    note: `${sharedProtection}候选池先保留标题、职责或技术栈中存在大数据开发、数仓、数据湖、Hadoop、Spark、Flink等直接证据的工程岗位，再补充招聘平台目标关键词返回且岗位标题属于开发或工程方向的记录；后者单独标记为“平台关键词匹配”。`,
    sourceText: sharedSources, tableName: 'BigDataJobsTable',
  },
  crawler: {
    title: '爬虫工程师岗位数据概览', workbookName: '爬虫工程师岗位_5000条.xlsx',
    jsonName: '爬虫工程师岗位_5000条_标准化数据.json', previewDir: 'work/crawler_5000_previews',
    inspectPath: 'work/crawler_5000_workbook.inspect.ndjson',
    platforms: ['智联招聘', '实习僧', '国聘', '中国公共招聘网'],
    relevance: ['标题直接匹配', '职责直接匹配', '采集技术匹配', '平台关键词匹配'],
    keywords: ['爬虫工程师', '爬虫开发工程师', 'Python爬虫工程师', '网络爬虫工程师', '数据采集工程师', '数据抓取工程师'],
    note: `${sharedProtection}候选池先保留标题、职责或技术栈中存在爬虫、网页抓取、数据采集、反爬、Scrapy、Selenium等直接证据的工程岗位，再补充招聘平台目标关键词返回且岗位标题属于开发或工程方向的记录；后者单独标记为“平台关键词匹配”。`,
    sourceText: sharedSources, tableName: 'CrawlerJobsTable',
  },
  fullstack: {
    title: '全栈开发岗位数据概览', workbookName: '全栈开发岗位_5000条.xlsx',
    jsonName: '全栈开发岗位_5000条_标准化数据.json', previewDir: 'work/fullstack_5000_previews',
    inspectPath: 'work/fullstack_5000_workbook.inspect.ndjson',
    platforms: ['智联招聘', '国聘', '中国公共招聘网'],
    relevance: ['标题直接匹配', '职责直接匹配', '前后端技能匹配', '平台关键词匹配'],
    keywords: ['全栈开发', '全栈工程师', 'Web全栈', '前后端开发'],
    note: `${sharedProtection}相关度分级便于筛选：前三档有标题、职责或前后端技术词证据；“平台关键词匹配”为招聘平台对查询词返回的结果。`,
    sourceText: sharedSources, tableName: 'FullStackJobsTable',
  },
};
const meta = metadata[mode];
if (!meta) throw new Error(`未知工作簿模式：${mode}`);
const sourceDir = path.resolve(process.argv[2] || 'C:/Users/YS-Insight/Desktop/全栈开发岗位5000条_2026-09-25');
const outputPath = path.resolve(process.argv[3] || 'outputs/fullstack_5000_20260925/全栈开发岗位_5000条.xlsx');
const desktopPath = path.join(sourceDir, meta.workbookName);
const previewDir = path.resolve(meta.previewDir);
const rows = JSON.parse(await fs.readFile(path.join(sourceDir, meta.jsonName), 'utf8'));
const quality = JSON.parse(await fs.readFile(path.join(sourceDir, '数据质量报告.json'), 'utf8'));

function xmlSafe(value) {
  if (value == null) return '';
  if (typeof value !== 'string') return value;
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '$1');
}

function excelValue(value, key) {
  const safe = xmlSafe(value);
  if (['job_id', 'company_id', 'contact_phone'].includes(key) && safe !== '') return String(safe);
  return safe;
}

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

const wb = Workbook.create();
const summary = wb.worksheets.add('概览');
const data = wb.worksheets.add('岗位数据');
summary.tabColor = '#1F4E78';
data.tabColor = '#5B9BD5';
summary.showGridLines = false;
data.showGridLines = false;

const fontFamily = 'Arial';
summary.getRange('A1:Q28').format.font = { name: fontFamily, size: 10, color: '#1F2937' };
summary.getRange('A2:H2').merge();
summary.getRange('A2').values = [[meta.title]];
summary.getRange('A2').format.font = { name: fontFamily, size: 16, bold: true, color: '#163A5F' };
summary.getRange('A3:Q3').format.borders = { bottom: { style: 'thin', color: '#9FBAD0' } };

summary.getRange('A4').values = [['岗位总数']];
summary.getRange('B4').formulas = [[`=COUNTA('岗位数据'!$G$2:$G$${rows.length + 1})`]];
summary.getRange('D4').values = [['唯一键']];
summary.getRange('E4').values = [['平台 + 岗位ID']];
summary.getRange('G4').values = [['采集日期']];
summary.getRange('H4').values = [[new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())]];
summary.getRange('A4:H4').format.verticalAlignment = 'center';
for (const address of ['A4', 'D4', 'G4']) summary.getRange(address).format.font = { name: fontFamily, size: 10, bold: true, color: '#526579' };
for (const address of ['B4', 'E4', 'H4']) {
  summary.getRange(address).format.fill = '#EAF2F8';
  summary.getRange(address).format.font = { name: fontFamily, size: 12, bold: true, color: '#163A5F' };
  summary.getRange(address).format.horizontalAlignment = 'center';
}
summary.getRange('B4').format.numberFormat = '#,##0';

summary.getRange('A7:B7').values = [['平台', '岗位数']];
const platforms = meta.platforms;
const platformEnd = 7 + platforms.length;
summary.getRange(`A8:A${platformEnd}`).values = platforms.map((v) => [v]);
summary.getRange('B8').formulas = [[`=COUNTIFS('岗位数据'!$D$2:$D$${rows.length + 1},A8)`]];
summary.getRange(`B8:B${platformEnd}`).fillDown();

summary.getRange('D7:E7').values = [['相关度分级', '岗位数']];
const relevance = meta.relevance;
const relevanceEnd = 7 + relevance.length;
summary.getRange(`D8:D${relevanceEnd}`).values = relevance.map((v) => [v]);
summary.getRange('E8').formulas = [[`=COUNTIFS('岗位数据'!$B$2:$B$${rows.length + 1},D8)`]];
summary.getRange(`E8:E${relevanceEnd}`).fillDown();

summary.getRange('G7:H7').values = [['查询关键词', '岗位数']];
const keywords = meta.keywords;
const keywordEnd = 7 + keywords.length;
summary.getRange(`G8:G${keywordEnd}`).values = keywords.map((v) => [v]);
summary.getRange('H8').formulas = [[`=COUNTIFS('岗位数据'!$E$2:$E$${rows.length + 1},G8)`]];
summary.getRange(`H8:H${keywordEnd}`).fillDown();

for (const rangeAddress of ['A7:B7', 'D7:E7', 'G7:H7', 'A14:B14', 'D14:F14']) {
  summary.getRange(rangeAddress).format = {
    fill: '#1F4E78', font: { name: fontFamily, size: 10, bold: true, color: '#FFFFFF' },
    horizontalAlignment: 'center', verticalAlignment: 'center',
  };
}
summary.getRange(`A7:B${platformEnd}`).format.borders = { preset: 'outside', style: 'thin', color: '#B8C7D4' };
summary.getRange(`D7:E${relevanceEnd}`).format.borders = { preset: 'outside', style: 'thin', color: '#B8C7D4' };
summary.getRange(`G7:H${keywordEnd}`).format.borders = { preset: 'outside', style: 'thin', color: '#B8C7D4' };
summary.getRange(`B8:B${platformEnd}`).format.numberFormat = '#,##0';
summary.getRange(`E8:E${relevanceEnd}`).format.numberFormat = '#,##0';
summary.getRange(`H8:H${keywordEnd}`).format.numberFormat = '#,##0';

summary.getRange('A14:B14').values = [['查询城市', '岗位数']];
const cities = ['全国', '北京', '天津', '上海', '重庆', '南京', '苏州', '杭州', '武汉', '广州', '深圳', '成都', '西安'];
summary.getRange('A15:A27').values = cities.map((v) => [v]);
summary.getRange('B15').formulas = [[`=COUNTIFS('岗位数据'!$F$2:$F$${rows.length + 1},A15)`]];
summary.getRange('B15:B27').fillDown();
summary.getRange('A14:B27').format.borders = { preset: 'outside', style: 'thin', color: '#B8C7D4' };
summary.getRange('B15:B27').format.numberFormat = '#,##0';

summary.getRange('D14:F14').values = [['关键字段', '已填充', '完整率']];
const completenessRows = [
  ['岗位ID', 'G'], ['岗位名称', 'H'], ['公司名称', 'J'], ['工作城市', 'L'], ['岗位链接', 'AC'], ['岗位描述', 'Y'],
];
summary.getRange('D15:D20').values = completenessRows.map(([label]) => [label]);
summary.getRange('E15:E20').formulas = completenessRows.map(([, col]) => [`=COUNTA('岗位数据'!$${col}$2:$${col}$${rows.length + 1})`]);
summary.getRange('F15').formulas = [['=E15/$B$4']];
summary.getRange('F15:F20').fillDown();
summary.getRange('D14:F20').format.borders = { preset: 'outside', style: 'thin', color: '#B8C7D4' };
summary.getRange('E15:E20').format.numberFormat = '#,##0';
summary.getRange('F15:F20').format.numberFormat = '0.0%';

summary.getRange('H14:Q14').merge();
summary.getRange('H14').values = [['采集说明与账号保护']];
summary.getRange('H14:Q14').format = {
  fill: '#EAF2F8', font: { name: fontFamily, size: 10, bold: true, color: '#163A5F' },
  verticalAlignment: 'center',
};
summary.getRange('H15:Q20').merge();
summary.getRange('H15').values = [[meta.note]];
summary.getRange('H15:Q20').format.wrapText = true;
summary.getRange('H15:Q20').format.verticalAlignment = 'top';
summary.getRange('H15:Q20').format.fill = '#F7FAFC';
summary.getRange('H15:Q20').format.borders = { preset: 'outside', style: 'thin', color: '#CFD8E3' };

summary.getRange('H22:Q22').merge();
summary.getRange('H22').values = [['数据来源']];
summary.getRange('H22:Q22').format = {
  fill: '#EAF2F8', font: { name: fontFamily, size: 10, bold: true, color: '#163A5F' },
};
summary.getRange('H23:Q25').merge();
summary.getRange('H23').values = [[meta.sourceText]];
summary.getRange('H23:Q25').format.wrapText = true;
summary.getRange('H23:Q25').format.verticalAlignment = 'top';
summary.getRange('H23:Q25').format.borders = { preset: 'outside', style: 'thin', color: '#CFD8E3' };

const chart = summary.charts.add('bar', summary.getRange(`A7:B${platformEnd}`));
chart.title = '各平台岗位数';
chart.titleTextStyle.typeface = fontFamily;
chart.titleTextStyle.fontSize = 12;
chart.hasLegend = false;
chart.xAxis = { axisType: 'textAxis', textStyle: { typeface: fontFamily, fontSize: 10 } };
chart.yAxis = { numberFormatCode: '#,##0', numberFormatSourceLinked: false, textStyle: { typeface: fontFamily, fontSize: 10 } };
chart.setPosition('J4', 'Q12');

summary.getRange('A1:Q27').format.verticalAlignment = 'center';
summary.getRange('A2').format.font = { name: fontFamily, size: 16, bold: true, color: '#163A5F' };
summary.getRange('A1:A27').format.columnWidth = 15;
summary.getRange('B1:B27').format.columnWidth = 12;
summary.getRange('C1:C27').format.columnWidth = 3;
summary.getRange('D1:D27').format.columnWidth = 18;
summary.getRange('E1:E27').format.columnWidth = 12;
summary.getRange('F1:F27').format.columnWidth = 12;
summary.getRange('G1:G27').format.columnWidth = 16;
summary.getRange('H1:Q27').format.columnWidth = 11;
summary.getRange('A2:Q2').format.rowHeight = 28;
summary.getRange('A15:Q20').format.rowHeight = 22;

const matrix = [headers, ...rows.map((row) => columns.map((key) => excelValue(row[key], key)))];
data.getRange(`G1:G${matrix.length}`).format.numberFormat = '@';
data.getRange(`I1:I${matrix.length}`).format.numberFormat = '@';
data.getRange(`AH1:AH${matrix.length}`).format.numberFormat = '@';
data.getRangeByIndexes(0, 0, matrix.length, headers.length).values = matrix;
data.getRange(`A1:AI${matrix.length}`).format.font = { name: fontFamily, size: 9, color: '#1F2937' };
data.getRange('A1:AI1').format = {
  fill: '#1F4E78', font: { name: fontFamily, size: 9, bold: true, color: '#FFFFFF' },
  horizontalAlignment: 'center', verticalAlignment: 'center', wrapText: true,
};
data.getRange(`A2:A${matrix.length}`).format.numberFormat = '#,##0';
data.getRange(`AE2:AE${matrix.length}`).format.numberFormat = '#,##0';
data.getRange(`G2:G${matrix.length}`).format.numberFormat = '@';
data.getRange(`I2:I${matrix.length}`).format.numberFormat = '@';
data.getRange(`AH2:AH${matrix.length}`).format.numberFormat = '@';
data.getRange(`A2:AI${matrix.length}`).format.verticalAlignment = 'top';
data.getRange(`A2:AI${matrix.length}`).format.rowHeight = 18;
data.freezePanes.freezeRows(1);
data.freezePanes.freezeColumns(6);
const table = data.tables.add(`A1:AI${matrix.length}`, true, meta.tableName);
table.style = 'TableStyleMedium2';
table.showFilterButton = true;

const widths = {
  A: 9, B: 16, C: 26, D: 14, E: 14, F: 12, G: 20, H: 28, I: 20, J: 28, K: 14, L: 16, M: 12,
  N: 13, O: 12, P: 12, Q: 14, R: 14, S: 22, T: 18, U: 18, V: 16, W: 36, X: 30, Y: 70, Z: 40,
  AA: 14, AB: 16, AC: 42, AD: 42, AE: 13, AF: 24, AG: 24, AH: 16, AI: 24,
};
for (const [col, width] of Object.entries(widths)) data.getRange(`${col}1:${col}${matrix.length}`).format.columnWidth = width;
data.getRange(`Y2:Y${matrix.length}`).format.wrapText = false;

wb.recalculate();
const summaryInspect = await wb.inspect({ kind: 'table', range: '概览!A1:Q27', include: 'values,formulas', tableMaxRows: 30, tableMaxCols: 18, maxChars: 15000 });
const dataInspect = await wb.inspect({ kind: 'table', range: '岗位数据!A1:K8', include: 'values,formulas', tableMaxRows: 8, tableMaxCols: 11, maxChars: 12000 });
const errorInspect = await wb.inspect({
  kind: 'match', searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!',
  options: { useRegex: true, maxResults: 300 }, summary: 'final formula error scan', maxChars: 8000,
});
await fs.writeFile(meta.inspectPath, `${summaryInspect.ndjson}\n${dataInspect.ndjson}\n${errorInspect.ndjson}`, 'utf8');

await fs.mkdir(previewDir, { recursive: true });
const summaryPreview = await wb.render({ sheetName: '概览', range: 'A1:Q27', scale: 1.3, format: 'png' });
await fs.writeFile(path.join(previewDir, '概览.png'), new Uint8Array(await summaryPreview.arrayBuffer()));
const dataPreview = await wb.render({ sheetName: '岗位数据', range: 'A1:K18', scale: 1.2, format: 'png' });
await fs.writeFile(path.join(previewDir, '岗位数据.png'), new Uint8Array(await dataPreview.arrayBuffer()));

await fs.mkdir(path.dirname(outputPath), { recursive: true });
const output = await SpreadsheetFile.exportXlsx(wb);
await output.save(outputPath);
await fs.copyFile(outputPath, desktopPath);

console.log(JSON.stringify({ outputPath, desktopPath, rows: rows.length, columns: headers.length, quality }, null, 2));
