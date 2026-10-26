import fs from 'node:fs/promises';
import path from 'node:path';
import { SpreadsheetFile, Workbook } from '@oai/artifact-tool';

const inputPath = path.resolve('work/nowcoder_jobs_data.json');
const outputDir = path.resolve('outputs');
const outputPath = path.join(outputDir, '牛客网_多岗位面经_帖子及评论.xlsx');
const previewPosts = path.resolve('work/preview_jobs_posts.png');
const previewComments = path.resolve('work/preview_jobs_comments.png');
const inspectPath = path.resolve('work/牛客网_多岗位面经_帖子及评论.xlsx.inspect.ndjson');
const data = JSON.parse(await fs.readFile(inputPath, 'utf8'));

const workbook = Workbook.create();
const postsSheet = workbook.worksheets.add('帖子数据');
const commentsSheet = workbook.worksheets.add('评论数据');
const fontName = 'Arial';
const headerFill = '#1F4E78';
const headerFont = '#FFFFFF';
const noteFill = '#EAF2F8';
const borderColor = '#D9E2F3';

function columnName(number) {
  let result = '';
  let value = number;
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function excelDate(iso) {
  return iso ? new Date(iso) : null;
}

function sanitizeText(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/[\uFFFE\uFFFF]/g, '');
}

const postColumns = [
  ['命中岗位', 'matched_keywords', 'text'], ['命中岗位数', 'matched_keyword_count', 'number'], ['检索位置', 'search_positions', 'text'],
  ['分类', 'category', 'text'], ['帖子ID', 'post_id', 'id'], ['UUID', 'uuid', 'id'], ['内容类型编码', 'content_type_code', 'number'],
  ['内容类型', 'content_type', 'text'], ['标题', 'title', 'text'], ['正文', 'content_text', 'text'], ['作者ID', 'author_id', 'id'],
  ['作者昵称', 'author_nickname', 'text'], ['性别', 'author_gender', 'text'], ['作者身份', 'author_identity', 'text'],
  ['学校', 'author_education', 'text'], ['专业类别', 'author_major', 'text'], ['毕业/工作年份', 'author_work_year', 'text'],
  ['IP属地', 'ip_location', 'text'], ['发布时间', 'created_at', 'date'], ['编辑时间', 'edited_at', 'date'], ['展示时间', 'shown_at', 'date'],
  ['是否编辑', 'edited', 'boolean'], ['点赞数', 'like_count', 'number'], ['收藏数', 'collect_count', 'number'],
  ['一级评论数', 'top_level_comment_count', 'number'], ['评论总数', 'total_comment_count', 'number'], ['浏览数', 'view_count', 'number'],
  ['分享数', 'share_count', 'number'], ['话题', 'topics', 'text'], ['图片数', 'image_count', 'number'], ['图片链接', 'image_urls', 'text'],
  ['帖子链接', 'post_url', 'text'], ['详情采集状态', 'detail_status', 'text'], ['评论采集状态', 'comments_status', 'text'], ['采集时间', 'collected_at', 'date'],
];

const commentColumns = [
  ['命中岗位', 'matched_keywords', 'text'], ['评论ID', 'comment_id', 'id'], ['帖子ID', 'post_id', 'id'], ['帖子标题', 'post_title', 'text'],
  ['帖子链接', 'post_url', 'text'], ['父评论ID', 'parent_comment_id', 'id'], ['回复目标评论ID', 'reply_to_comment_id', 'id'],
  ['评论层级', 'comment_level', 'number'], ['评论者ID', 'author_id', 'id'], ['评论者昵称', 'author_nickname', 'text'],
  ['评论者身份', 'author_identity', 'text'], ['被回复用户ID', 'reply_to_user_id', 'id'], ['被回复用户昵称', 'reply_to_nickname', 'text'],
  ['评论内容', 'content_text', 'text'], ['评论时间', 'created_at', 'date'], ['更新时间', 'updated_at', 'date'],
  ['点赞数', 'like_count', 'number'], ['回复数', 'reply_count', 'number'], ['IP属地', 'ip_location', 'text'], ['客户端', 'client_system', 'text'],
  ['是否采纳', 'accepted', 'boolean'], ['是否精彩评论', 'wonderful', 'boolean'], ['是否置顶', 'top_comment', 'boolean'], ['状态码', 'status', 'number'],
];

function valueFor(row, key, type) {
  const value = row[key];
  if (type === 'date') return excelDate(value);
  if (type === 'id') return sanitizeText(value);
  if (type === 'number') return Number(value || 0);
  if (type === 'boolean') return Boolean(value);
  return sanitizeText(value);
}

const statText = data.metadata.search_stats.map((stat) => `${stat.keyword} ${stat.returned_records}条`).join('；');

function formatSheet(sheet, title, columns, rows, tableName, widths, wrappedColumns, freezeColumns) {
  sheet.showGridLines = false;
  sheet.tabColor = '#1F4E78';
  sheet.getRange('A1').values = [[title]];
  sheet.getRange('A1').format.font = { name: fontName, size: 14, bold: true, color: '#1F2937' };
  sheet.getRange('A2').values = [['来源']];
  sheet.getRange('B2').values = [[data.metadata.search_url_template]];
  sheet.getRange('A3').values = [['范围说明']];
  sheet.getRange('B3').values = [[`${data.metadata.note} 本表${rows.length.toLocaleString('zh-CN')}条记录，采集时间：${data.metadata.collected_at}`]];
  sheet.getRange('A4').values = [['关键词返回量']];
  sheet.getRange('B4').values = [[statText]];
  sheet.getRange('A2:A4').format = {
    fill: noteFill, font: { name: fontName, size: 10, bold: true, color: '#1F4E78' }, verticalAlignment: 'center',
  };
  sheet.getRange('B2:B4').format = {
    fill: noteFill, font: { name: fontName, size: 10, italic: true, color: '#374151' }, verticalAlignment: 'center', wrapText: false,
  };
  sheet.getRange('A2:B4').format.borders = { preset: 'outside', style: 'thin', color: borderColor };

  const headerRow = 6;
  const matrix = [columns.map(([label]) => label), ...rows.map((row) => columns.map(([, key, type]) => valueFor(row, key, type)))];
  const dataRange = sheet.getRangeByIndexes(headerRow - 1, 0, matrix.length, columns.length);
  dataRange.values = matrix;
  dataRange.format.font = { name: fontName, size: 10, color: '#1F2937' };
  dataRange.format.verticalAlignment = 'center';

  const headerRange = sheet.getRangeByIndexes(headerRow - 1, 0, 1, columns.length);
  headerRange.format = {
    fill: headerFill, font: { name: fontName, size: 10, bold: true, color: headerFont }, horizontalAlignment: 'center',
    verticalAlignment: 'center', wrapText: true, borders: { preset: 'all', style: 'thin', color: '#FFFFFF' },
  };
  headerRange.format.rowHeight = 30;

  const bodyRange = sheet.getRangeByIndexes(headerRow, 0, rows.length, columns.length);
  bodyRange.format.borders = { insideHorizontal: { style: 'thin', color: '#E5E7EB' }, bottom: { style: 'thin', color: '#E5E7EB' } };
  bodyRange.format.rowHeight = title.includes('帖子') ? 54 : 40;

  columns.forEach(([, , type], index) => {
    const columnRange = sheet.getRangeByIndexes(headerRow, index, rows.length, 1);
    if (type === 'date') columnRange.format.numberFormat = 'yyyy-mm-dd hh:mm:ss';
    if (type === 'number') columnRange.format.numberFormat = '#,##0';
    if (type === 'id') {
      const key = columns[index][1];
      columnRange.formulas = rows.map((row) => {
        const value = sanitizeText(row[key]).replaceAll('"', '""');
        return [`="${value}"`];
      });
      columnRange.format.numberFormat = '@';
    }
    if (type === 'boolean') columnRange.format.horizontalAlignment = 'center';
  });

  for (const index of wrappedColumns) {
    const columnRange = sheet.getRangeByIndexes(headerRow, index, rows.length, 1);
    columnRange.format.wrapText = true;
    columnRange.format.verticalAlignment = 'top';
  }

  widths.forEach((width, index) => {
    sheet.getRangeByIndexes(0, index, rows.length + headerRow, 1).format.columnWidth = width;
  });
  sheet.getRange('A1:A4').format.columnWidth = Math.max(widths[0] || 10, 14);
  sheet.getRange('B2:B4').format.columnWidth = Math.max(widths[1] || 10, 40);

  const endRow = headerRow + rows.length;
  const endCol = columnName(columns.length);
  const table = sheet.tables.add(`A${headerRow}:${endCol}${endRow}`, true, tableName);
  table.style = 'TableStyleMedium2';
  table.showBandedColumns = false;
  table.showFilterButton = true;
  sheet.freezePanes.freezeRows(headerRow);
  sheet.freezePanes.freezeColumns(freezeColumns);
}

formatSheet(
  postsSheet, '牛客网多岗位面经帖子数据', postColumns, data.posts, 'NowcoderJobPosts',
  [30, 11, 45, 9, 20, 34, 12, 10, 34, 80, 18, 18, 8, 28, 18, 16, 14, 10, 20, 20, 20, 10, 10, 10, 12, 10, 10, 10, 28, 10, 42, 42, 14, 18, 20],
  [0, 2, 8, 9, 13, 28, 30, 31, 33], 4,
);

formatSheet(
  commentsSheet, '牛客网多岗位面经评论数据', commentColumns, data.comments, 'NowcoderJobComments',
  [30, 18, 20, 34, 42, 18, 20, 10, 18, 18, 26, 18, 18, 70, 20, 20, 10, 10, 10, 16, 10, 12, 10, 10],
  [0, 3, 4, 9, 10, 12, 13], 4,
);

workbook.recalculate();

const inspections = [];
inspections.push((await workbook.inspect({
  kind: 'table', range: '帖子数据!A1:L14', include: 'values,formulas', tableMaxRows: 14, tableMaxCols: 12, maxChars: 12000,
})).ndjson);
inspections.push((await workbook.inspect({
  kind: 'table', range: '评论数据!A1:N14', include: 'values,formulas', tableMaxRows: 14, tableMaxCols: 14, maxChars: 12000,
})).ndjson);
inspections.push((await workbook.inspect({
  kind: 'match', searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!',
  options: { useRegex: true, maxResults: 100 }, summary: 'final formula error scan',
})).ndjson);
await fs.writeFile(inspectPath, inspections.join('\n'), 'utf8');
console.log(inspections.join('\n'));

const postsPreview = await workbook.render({ sheetName: '帖子数据', range: 'A1:L16', scale: 1, format: 'png' });
await fs.writeFile(previewPosts, new Uint8Array(await postsPreview.arrayBuffer()));
const commentsPreview = await workbook.render({ sheetName: '评论数据', range: 'A1:N18', scale: 1, format: 'png' });
await fs.writeFile(previewComments, new Uint8Array(await commentsPreview.arrayBuffer()));

await fs.mkdir(outputDir, { recursive: true });
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);
console.log(JSON.stringify({ outputPath, posts: data.posts.length, comments: data.comments.length, previewPosts, previewComments, inspectPath }));
