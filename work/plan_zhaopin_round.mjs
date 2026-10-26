// 依据断点文件的 completed 标记，生成「只含未完成条件」的采集轮次文件。
// 断点是唯一事实源：collectZhaopin 每次都从第 1 页重放并合并旧行，completed=true 才说明已翻到末页。
import fs from 'node:fs/promises';
import path from 'node:path';

const outputDir = process.argv[2];
const outFile = process.argv[3];
if (!outputDir || !outFile) throw Error('用法：node plan_zhaopin_round.mjs <outputDir> <outRound.json>');

const taskPath = path.join(outputDir, '任务归属.json');
const owner = JSON.parse(await fs.readFile(taskPath, 'utf8'));
const taskId = owner?.owner?.task_id || owner?.task_id;
if (!taskId) throw Error('任务归属文件缺少 task_id');

const config = JSON.parse(await fs.readFile(path.join(outputDir, '采集配置.json'), 'utf8'));
const settings = config.platforms.zhaopin;
if (!settings?.enabled) throw Error('智联渠道未启用');
const keywords = config.keywords || [];
const cities = settings.cities || [];
if (!keywords.length || !cities.length) throw Error('关键词或城市为空，拒绝生成轮次');

const safeName = value => String(value).replace(/[\\/:*?"<>|]/g, '_');
const checkpointDir = path.join(outputDir, '断点数据');

const done = [];
const todo = [];
for (const keyword of keywords) {
  for (const city of cities) {
    const file = path.join(checkpointDir, `zhaopin_session_${safeName(keyword)}_${safeName(city.name)}.json`);
    const saved = await fs.readFile(file, 'utf8').then(JSON.parse).catch(() => null);
    const rows = saved?.rows?.length || 0;
    if (saved?.completed === true) done.push({ keyword, city: city.name, rows, total: saved.total ?? null });
    else todo.push({ platform: 'zhaopin', keyword, city: { name: city.name, code: city.code }, rows, total: saved?.total ?? null });
  }
}

const round = { task_id: taskId, combinations: todo.map(({ platform, keyword, city }) => ({ platform, keyword, city })) };
await fs.writeFile(outFile, JSON.stringify(round, null, 2), 'utf8');

console.log(`已完成条件 ${done.length} 个：${done.map(row => `${row.keyword}/${row.city}(${row.rows})`).join('、') || '无'}`);
console.log(`待采条件 ${todo.length} 个：${todo.map(row => `${row.keyword}/${row.city}(已有${row.rows})`).join('、') || '无'}`);
console.log(`轮次文件已写入 ${outFile}`);