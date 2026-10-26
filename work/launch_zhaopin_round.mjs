// 智联轮次启动器：把轮次 JSON 读成环境变量后启动采集，避免 PowerShell 引号/换行破坏 JSON。
// 用法：node launch_zhaopin_round.mjs <roundJson> [logTag]
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const [roundJson, logTag] = process.argv.slice(2);
if (!roundJson) throw Error('用法：node launch_zhaopin_round.mjs <roundJson> [logTag]');

const roundText = await fs.readFile(roundJson, 'utf8');
const parsed = JSON.parse(roundText);
const platform = parsed.combinations?.[0]?.platform;
if (!platform) throw Error('轮次文件缺少 combinations[].platform');
if (parsed.combinations.some(c => c.platform !== platform)) throw Error('轮次文件混入了多个平台的组合，拒绝启动');
// 生产任务数据目录：采集脚本自带的 argv 默认值指向旧的桌面目录，缺少归属标记会被 assertTaskOutputOwnership 拦下。
const outputDir = parsed.outputDir || process.env.JOB_TASK_OUTPUT_DIR || 'D:/岗位采集数据/任务数据/1792837186878-爬虫岗位采集';
const taskId = parsed.taskId || '1792837186878-爬虫岗位采集';

// 轮次必须自带配置：argv[2] 默认的 work/job_collect_config.json 是「智能体开发」模板，
// 关键词/城市白名单与爬虫任务不一致，会让每个组合都被 filterCollectionCombinations 拒绝。
const configPath = path.join(root, 'tmp', `round_config_${taskId}.json`);
const build = spawn(process.execPath, [path.join(root, 'work', 'build_round_config.mjs'), taskId, configPath], {
  cwd: root,
  env: { ...process.env, JOB_COLLECTION_ROUND: roundText },
  stdio: 'inherit', windowsHide: true,
});
const buildCode = await new Promise((resolve, reject) => { build.once('error', reject); build.once('close', code => resolve(code ?? 1)); });
if (buildCode !== 0) throw Error(`轮次配置构建失败，退出码 ${buildCode}`);
const label = `${logTag || platform}-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
const logPath = path.join(root, 'tmp', `${label}.log`);
const runningLogPath = path.join(root, 'tmp', `${label}.running.log`);

console.log(`平台: ${platform}`);
console.log(`组合数: ${parsed.combinations.length}`);
console.log(`输出目录: ${outputDir}`);
console.log(`日志: ${logPath}`);

const env = {
  ...process.env,
  JOB_COLLECTOR_TASK_ID: taskId,
  JOB_COLLECTOR_NATIVE_STORE: '1',
  JOB_COLLECTOR_BLOCKED_POLICY: 'retry',
  JOB_COLLECTION_ROUND: roundText,
  JOB_STRUCTURED_ROUND_ONLY: platform,
  NODE_OPTIONS: process.env.NODE_OPTIONS || '',
};
const lines = [];
const child = spawn(process.execPath, [path.join(root, 'work', 'collect_public_job_platforms.mjs'), configPath, outputDir], {
  cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
const guard = setTimeout(() => {
  lines.push(`[${new Date().toISOString()}] 守护线：轮次运行超过 150 分钟，强制结束进程`);
  child.kill();
}, 150 * 60 * 1000);
const collect = chunk => {
  const text = chunk.toString();
  lines.push(text);
  process.stdout.write(text);
};
child.stdout.on('data', collect);
child.stderr.on('data', collect);
child.on('exit', async (code, signal) => {
  clearTimeout(guard);
  lines.push(`[${new Date().toISOString()}] EXIT=${code} SIGNAL=${signal || '-'}\n`);
  await fs.writeFile(logPath, lines.join(''), 'utf8');
  await fs.rm(runningLogPath, { force: true });
  console.log(`\n轮次结束：EXIT=${code} 日志=${logPath}`);
});
await fs.writeFile(runningLogPath, JSON.stringify({ platform, outputDir, startedAt: new Date().toISOString(), combinations: parsed.combinations.length }, null, 2), 'utf8');