// 轮次采集配置构建器：把任务「公开渠道配置.json」升格为采集脚本可用的运行配置。
// 采集脚本的 argv[2] 默认指向 work/job_collect_config.json（智能体开发模板，且被别的任务改写），
// 直接依赖它会让智联轮次撞上「采集轮次条件超出已配置关键词或城市」白名单闸门。
// 用法：node build_round_config.mjs <taskId> <outConfigPath>
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const [taskId, outConfigPath] = process.argv.slice(2);
if (!taskId || !outConfigPath) throw Error('用法：node build_round_config.mjs <taskId> <outConfigPath>');

const sourcePath = path.join(root, 'ui_data', 'tasks', taskId, '公开渠道配置.json');
const templatePath = path.join(root, 'work', 'job_collect_config.json');

const source = JSON.parse(await fs.readFile(sourcePath, 'utf8'));
let template = {};
try { template = JSON.parse(await fs.readFile(templatePath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }

const config = { ...template, ...source };
config.task_id = taskId;
config.platforms = {};
for (const [platform, settings] of Object.entries({ ...(template.platforms || {}), ...(source.platforms || {}) })) {
  config.platforms[platform] = { ...(template.platforms?.[platform] || {}), ...settings };
}
config.keywords = source.keywords || template.keywords;
config.request = { ...(template.request || {}), ...(source.request || {}) };

// 牛客岗位通道不使用关键词/城市坐标轴，单平台轮次里会因「不能复用其他岗位的牛客岗位断点」把自己标成 blocked，
// 与本轮无关却污染退出码；只有轮次确实包含牛客时才开启。
// 关键：没有轮次文本（全渠道构建）时必须沿用任务配置里的 enabled，而不是一律压成 false——
// 否则「构建 → 运行单通道轮次」两步之间开关被清零，牛客会静默返回 disabled：零请求、断点不动、退出码 0，
// 表现成「渠道没坏但永远不跑」的假正常。这是 cities 被 taskJobSettings 一并清空的直接上游。
const roundText = process.env.JOB_COLLECTION_ROUND || '';
let roundPlatforms = null;
try {
  const parsed = JSON.parse(roundText);
  if (Array.isArray(parsed?.combinations)) roundPlatforms = new Set(parsed.combinations.map(combo => combo?.platform).filter(Boolean));
} catch { /* 非 JSON 轮次：按全渠道处理 */ }
for (const platform of ['nowcoder']) {
  if (config.platforms[platform] && roundPlatforms) {
    config.platforms[platform] = { ...config.platforms[platform], enabled: roundPlatforms.has(platform) };
  }
}

if (!Array.isArray(config.keywords) || !config.keywords.length) throw Error(`${sourcePath} 缺少 keywords，无法构建轮次配置`);
if (!config.platforms.zhaopin?.cities?.length) throw Error(`${sourcePath} 缺少 platforms.zhaopin.cities`);

await fs.mkdir(path.dirname(outConfigPath), { recursive: true });
await fs.writeFile(outConfigPath, JSON.stringify(config, null, 2), 'utf8');
console.log(`轮次配置: ${outConfigPath}`);
console.log(`task_id: ${config.task_id}`);
console.log(`关键词(${config.keywords.length}): ${config.keywords.join(' | ')}`);
console.log(`智联城市(${config.platforms.zhaopin.cities.length}): ${config.platforms.zhaopin.cities.map(city => `${city.name}/${city.code}`).join(', ')}`);
console.log(`牛客岗位通道: ${config.platforms.nowcoder?.enabled ? '开启' : '关闭（本轮不含牛客）'}`);