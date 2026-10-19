import http from 'node:http';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { taskInsightSource } from '../work/task-insight-source.mjs';
import { resolveInsightSourceRole } from '../work/insight-source-role.mjs';
import { bossCities } from '../work/boss_page_adapter.mjs';
import {assertCollectorResources,nativeCrashMessage} from '../work/collector_resources.mjs';
import {ownedReport,isolatedDirectory,isolateLegacyTask,assertTaskOutputOwnership} from '../work/task_dataset_scope.mjs';
import {snapshotTaskOutput,inspectTaskBackup,restoreTaskBackup} from '../work/task_output_backup.mjs';
import {writeJsonAtomic,writeAtomic} from '../work/collector_storage.mjs';
import {createHash} from 'node:crypto';
import {sessionFileName} from '../work/manual_search_session.mjs';
import {stageDisposition} from '../work/collection_policy.mjs';
import {deliverPartial} from '../work/partial_delivery.mjs';
import {otherChannelValidCount} from '../work/task_collection_target.mjs';
import {collectionChannelAvailable,collectionChannelPauseReason,assertDirectHttpCollection,retiredCollectionChannels} from '../work/channel_availability.mjs';
import {collectionTransportPolicy} from '../work/channel_acquisition.mjs';
import {liveCollectionMetrics} from '../work/live_collection_metrics.mjs';
import {synchronizePublicKeywords} from '../work/task_collection_config.mjs';
import {updateUnifiedDataset} from '../work/unified_collection_store.mjs';
import {createKnowledgeAssistantStore} from '../work/job_decision_assistant.mjs';
import {knowledgeStore} from '../work/job_knowledge_store.mjs';
import {createKnowledgeHandler} from '../work/job_knowledge_http.mjs';
import {nativeTaskCounts} from '../work/collector_native_sink.mjs';
import {createAssistantHandler} from '../work/job_assistant_http.mjs';
import {createAssistantCredentialStore} from '../work/job_assistant_credentials.mjs';
import {createAssistantSessionStore} from '../work/job_assistant_sessions.mjs';
import {assistantSessionDirectory} from '../work/job_assistant_storage.mjs';
import {createCollectionControl} from '../work/job_assistant_collection.mjs';
import {zhaopinCities,jobonlineCities} from '../work/collection_cities.mjs';
import {liepinCities} from '../work/liepin_cities.mjs';
import {channelAcquisition,collectionPolicyFor,collectionMode,HYBRID_MODE} from '../work/channel_acquisition.mjs';
import {prepareStructuredCollection} from '../work/structured_collection_plan.mjs';
import {runAdaptiveCollection} from '../work/collection_search_queue.mjs';
import {PipelineRuns} from '../work/pipeline_runs.mjs';
import {collectionStopMessage} from '../work/jobonline_pagination_health.mjs';
import {collectionGoal,untilExhausted,goalText,collectionOutcome} from '../work/collection_goal.mjs';
import {migrateLegacyCollectionGoals} from '../work/legacy_collection_goal.mjs';
import {createInsightSupervised,createInsightSupervisedHandler} from '../work/insight-supervised.mjs';
import {selectManualRole} from '../work/insight-role-selection.mjs';
import {roleFamilies} from '../work/job_knowledge_schema.mjs';
import {roleClassifier} from '../work/role-classifier-registry.mjs';
import {createBrowserWorkspace} from '../work/job-browser-workspace.mjs';
import {createBrowserScreening} from '../work/job-browser-screening.mjs';
import {createSemanticCloud,createSemanticCloudHandler} from '../work/insight-semantic-cloud.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const publicDir = path.join(here, 'public');
const dataDir = process.env.JOB_UI_DATA_DIR ? path.resolve(process.env.JOB_UI_DATA_DIR) : path.join(root, 'ui_data');
const taskDataDir = path.join(dataDir, 'tasks');
const logDir = path.join(dataDir, 'logs');
const tasksPath = path.join(dataDir, 'tasks.json');
// Collectors may still read existing sessions; interactive login management is retired.
const platformStatusPath = path.join(dataDir, 'platform_sessions', '登录会话状态.json');
const taskBackupRoot=path.resolve(process.env.JOB_TASK_BACKUP_ROOT||(process.env.JOB_UI_DATA_DIR?path.join(dataDir,'task_backups'):path.join(os.homedir(),'.job-collector','task-backups')));
const taskOutputRoot=path.resolve(process.env.JOB_TASK_OUTPUT_ROOT||(process.env.JOB_UI_DATA_DIR?path.join(dataDir,'task_outputs'):process.platform==='win32'&&fsSync.existsSync('D:/')?'D:/岗位采集数据':path.join(dataDir,'task_outputs')));
const insightDataDir = path.join(dataDir, 'insights');
const insightStatePath = path.join(insightDataDir, 'state.json');
const insightConfigPath = path.join(insightDataDir, 'config.json');
const insightReportPath = path.join(insightDataDir, '岗位市场洞察.json');
const insightLogPath = path.join(insightDataDir, 'analysis.log');
const knowledge=knowledgeStore(dataDir);
const insightSupervised=createInsightSupervised(dataDir);
const classifierScope=inputFile=>{
  const source=resolveInsightSourceRole({inputFile},tasks);
  return {inputFile,role:selectManualRole(roleFamilies,source.role)?.name||source.role};
};
const handleInsightClassifier=createInsightSupervisedHandler(insightSupervised,classifierScope);
const semanticCloud=createSemanticCloud(dataDir,{supervised:insightSupervised,scope:classifierScope});
const handleSemanticCloud=createSemanticCloudHandler(semanticCloud);
const handleKnowledge=createKnowledgeHandler(dataDir);
const insightDatasetRoot = path.resolve(process.env.JOB_INSIGHT_DATASET_ROOT || path.join(root, 'outputs'));
const host = '127.0.0.1';
const port = Number(process.env.JOB_UI_PORT || process.argv[2] || 8765);
const browserWorkspace=createBrowserWorkspace(dataDir,{screening:createBrowserScreening({supervised:insightSupervised})});
const handleJobAssistant = createAssistantHandler(createKnowledgeAssistantStore(dataDir,{readOnly:true}),createAssistantCredentialStore(path.join(dataDir,'assistant_private','model.json')),{repository:createAssistantSessionStore(await assistantSessionDirectory(dataDir)),collectionControl:createCollectionControl({baseUrl:`http://${host}:${port}`,storageDir:dataDir,dataDiskDir:path.dirname(knowledge.filename),getCities:()=>Object.keys(zhaopinCities)})});
const latestExports=new Map();
const active = new Map();
const pipelineRuns=new PipelineRuns();
let startingBoss = false;
let activeInsight = null;
const rowCountCache = new Map();
const startingStages = new Set();

function consoleUrl() { return `http://${host}:${port}`; }

function openBrowser() {
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/d', '/c', 'start', '', consoleUrl()], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
    return;
  }
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(command, [consoleUrl()], { detached: true, stdio: 'ignore' }).unref();
}

function existingConsoleIsReady() {
  return new Promise((resolve) => {
    const request = http.get(`${consoleUrl()}/api/state`, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        if (body.length < 64_000) body += chunk;
      });
      response.on('end', () => {
        try {
          const state = JSON.parse(body);
          resolve(response.statusCode === 200 && typeof state.version === 'string');
        } catch {
          resolve(false);
        }
      });
    });
    request.setTimeout(2500, () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

await fs.mkdir(taskDataDir, { recursive: true });
await fs.mkdir(logDir, { recursive: true });
await fs.mkdir(insightDataDir, { recursive: true });

const job51Cities = {
  '全国': '000000', '北京': '010000', '上海': '020000', '广州': '030200', '深圳': '040000',
  '天津': '050000', '重庆': '060000', '南京': '070200', '苏州': '070300', '杭州': '080200',
  '成都': '090200', '武汉': '180200', '西安': '200200',
};

function now() { return new Date().toISOString(); }
function safeName(value) { return String(value || '').replace(/[\\/:*?"<>|]/g, '_').trim(); }
function splitTerms(value) {
  if (Array.isArray(value)) return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
  return [...new Set(String(value || '').split(/[\n,，;；]+/).map((item) => item.trim()).filter(Boolean))];
}
function taskById(tasks, id) { return tasks.find((task) => task.id === id && !task.archived); }

async function loadTasks() {
  try {
    const tasks = JSON.parse(await fs.readFile(tasksPath, 'utf8'));
    let changed = false;
    for (const task of tasks) {
      if (task.status === 'running' || task.status === 'stopping') {
        task.status = 'paused';
        task.message = '控制台曾退出，可从原目录续爬';
        changed = true;
      }
    }
    if (changed) await saveTasks(tasks);
    return tasks;
  } catch { return []; }
}

async function saveTasks(tasks) {
  const temp = `${tasksPath}.tmp`;
  await fs.writeFile(temp, JSON.stringify(tasks, null, 2), 'utf8');
  await fs.rename(temp, tasksPath);
}

let tasks = await loadTasks();
if(await migrateLegacyCollectionGoals(tasks))await saveTasks(tasks);
let datasetScopesChanged=false;
for(const task of tasks)datasetScopesChanged=(await isolateLegacyTask(task))||datasetScopesChanged;
if(datasetScopesChanged)await saveTasks(tasks);

async function loadInsightState() {
  try {
    const state = JSON.parse(await fs.readFile(insightStatePath, 'utf8'));
    if (state.status === 'running') return { ...state, status: 'ready', message: '控制台曾退出，可重新生成分析' };
    return state;
  } catch {
    return { status: 'empty', message: '尚未生成岗位市场洞察', updatedAt: null };
  }
}

let insightState = await loadInsightState();

async function saveInsightState(patch) {
  insightState = { ...insightState, ...patch, updatedAt: now() };
  const temp = `${insightStatePath}.tmp`;
  await fs.writeFile(temp, JSON.stringify(insightState, null, 2), 'utf8');
  await fs.rename(temp, insightStatePath);
  return insightState;
}

async function publicInsight() {
  let report = null;
  try { report = JSON.parse(await fs.readFile(insightReportPath, 'utf8')); } catch {}
  return { ...insightState, runningSeconds: activeInsight ? Math.floor((Date.now() - activeInsight.startedAt) / 1000) : 0, report };
}

async function discoverInsightDatasets() {
  return knowledge.catalog({synchronize:false});
}

async function startInsight(body) {
  if (activeInsight) throw new Error('岗位洞察分析正在运行');
  const requestedInput=String(body.inputFile||'').trim(),nativeInput=requestedInput.startsWith('kb://');
  const sourceRole=resolveInsightSourceRole(body,tasks);
  if(sourceRole.taskId)body={...body,sourceTaskId:sourceRole.taskId};
  const inputFile = nativeInput?requestedInput:path.resolve(requestedInput);
  if (!nativeInput&&(!requestedInput || !fsSync.existsSync(inputFile))) throw new Error('找不到输入数据');
  if (!nativeInput&&!['.xlsx', '.csv'].includes(path.extname(inputFile).toLowerCase())) throw new Error('请选择知识库岗位范围，或手工导入 XLSX/CSV');
  const classifierRole=selectManualRole(roleFamilies,sourceRole.role)?.name||sourceRole.role;
  const insightClassifier=await insightSupervised.resolve(inputFile,classifierRole);
  if(!insightClassifier&&!roleClassifier(classifierRole))throw new Error('该岗位尚无通过验收的监督分类器，请先选择具体岗位数据集并点击“Qwen 标注并训练”；岗位洞察不再使用规则筛选');
  let transferSource = null;
  if (body.sourceTaskId) {
    const task = tasks.find((item) => item.id === String(body.sourceTaskId) && !item.archived);
    if (!task) throw new Error('来源采集任务不存在');
    transferSource = await taskInsightSource(task,{knowledge:nativeInput,dataDir});
    if (transferSource.dataset.path.toLowerCase() !== inputFile.toLowerCase()) throw new Error('洞察文件不是该任务的当前交付文件，请重新点击“用于岗位洞察”');
  }
  let analysisInputFile=inputFile;
  if(nativeInput){const snapshot=await knowledge.snapshot(inputFile);analysisInputFile=snapshot.uri;if(transferSource)transferSource.dataset.expectedRows=snapshot.rows;}
  if(transferSource?.dataset.resolution==='latest_snapshot'){
    const sourceTask=tasks.find(item=>item.id===transferSource.taskId);
    const refreshed=await updateUnifiedDataset(sourceTask,{publishCsv:true});
    if(refreshed.latestSnapshotError)throw new Error(refreshed.latestSnapshotError);
    transferSource=await taskInsightSource(sourceTask);
    const content=await fs.readFile(inputFile,'utf8');
    const manifest=JSON.parse(await fs.readFile(path.join(sourceTask.outputDir,'最新数据清单.json'),'utf8'));
    if(createHash('sha256').update(content).digest('hex')!==manifest.hash)throw new Error('最新候选正在更新，请重试分析');
    analysisInputFile=path.join(insightDataDir,'当前分析输入快照.csv');
    await writeAtomic(analysisInputFile,content);
  }
  const config = {
    inputFile:analysisInputFile,
    displayInputFile:inputFile,
    ...(transferSource ? { sourceTaskId: transferSource.taskId, sourceResolution: transferSource.dataset.resolution, expectedRows: transferSource.dataset.expectedRows } : {}),
    sheetName: String(body.sheetName || '岗位数据').trim() || '岗位数据',
    role: sourceRole.role,
    roleSource: sourceRole.mode,
    analysisMode: String(body.analysisMode || 'preview') === 'full' ? 'full' : 'preview',
    sampleSize: Math.max(50, Math.min(2000, Number(body.sampleSize || 300))),
    // Clear obsolete state references; historical result files are untouched.
    reviewedLabelDir: '', prelabelDir: '', reviewedLabelJobId: '',
    consensusLabelDirs: [], consensusLabelJobIds: [], labelingEnabled: false,
    insightClassifier,
    screeningPolicy: 'supervised-only',
    semanticCloud: await semanticCloud.resolve(inputFile,classifierRole,insightClassifier),
  };
  await fs.writeFile(insightConfigPath, JSON.stringify(config, null, 2), 'utf8');
  await fs.writeFile(insightLogPath, `[${new Date().toLocaleString('zh-CN')}] 开始分析\n输入：${inputFile}\n模式：${config.analysisMode === 'full' ? '全量逐条匹配' : `抽样 ${config.sampleSize} 条`}\n`, 'utf8');
  await saveInsightState({ status: 'running', message: '正在读取样本并计算岗位洞察', ...config, startedAt: now(), error: '' });
  const child = spawn(process.execPath, [path.join(root, 'work', 'analyze_job_market_sample.mjs'), insightConfigPath, insightReportPath], {
    cwd: root, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  activeInsight = { child, startedAt: Date.now() };
  let analysisError = '';
  child.stdout.on('data', (chunk) => fs.appendFile(insightLogPath, chunk.toString('utf8'), 'utf8').catch(() => {}));
  child.stderr.on('data', (chunk) => {
    analysisError = (analysisError + chunk.toString('utf8')).slice(-16000);
    fs.appendFile(insightLogPath, `[错误] ${chunk.toString('utf8')}`, 'utf8').catch(() => {});
  });
  child.once('error', async (error) => {
    activeInsight = null;
    await saveInsightState({ status: 'failed', message: '岗位洞察启动失败', error: error.message });
  });
  child.once('close', async (code, signal) => {
    activeInsight = null;
    if (code === 0) {
      try {
        const report = JSON.parse(await fs.readFile(insightReportPath, 'utf8'));
        await saveInsightState({ status: 'completed', message: `${report.detected_role?.name || report.role}分析完成：${report.sample_rows}/${report.total_rows} 条`, error: '' });
        await fs.appendFile(insightLogPath, '\n[完成] 岗位市场洞察已生成。\n', 'utf8').catch(() => {});
      } catch (error) {
        await saveInsightState({ status: 'failed', message: '分析程序结束但报告读取失败', error: error.message });
      }
    } else {
      const failure = analysisError.match(/^Error:\s*(.+)$/m)?.[1] || `子进程退出：${code ?? signal}`;
      await saveInsightState({ status: 'failed', message: `岗位洞察分析失败：${failure}`, error: failure });
    }
  });
  return insightState;
}

async function appendLog(id, text) {
  const value = String(text || '');
  if (!value) return;
  await fs.appendFile(path.join(logDir, `${id}.log`), value, 'utf8').catch(() => {});
}

async function setTask(id, patch) {
  const task = tasks.find((item) => item.id === id);
  if (!task) return null;
  Object.assign(task, patch, { updatedAt: now() });
  await saveTasks(tasks);
  return task;
}

function runtimePython() {
  const candidates = [
    process.env.JOB_UI_PYTHON,
    path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe'),
    'python',
  ].filter(Boolean);
  return candidates.find((candidate) => candidate === 'python' || fsSync.existsSync(candidate)) || 'python';
}

function stageCommand(task, stage) {
  const roundPlatforms=(task.collectionRoundPlatforms||task.platforms).filter(key=>collectionChannelAvailable(key,task));
  // 统一 HTTP 直连：所有渠道（含智联）经 collect_public_job_platforms.mjs 采集；不再启动 RPA。
  if (['collection','zhaopin','public'].includes(stage)) return {
    command: process.execPath,
    args: [path.join(root,'work','collect_public_job_platforms.mjs'), task.publicConfigPath, task.outputDir],
  };
  if (stage === 'yupao') return {
    command: process.execPath,
    args: [path.join(root, 'work', 'collect_logged_yupao.mjs'), task.outputDir, task.yupaoConfigPath],
  };
  if (stage === 'boss') return {
    command: process.execPath,
    args: [path.join(root, 'work', 'collect_logged_boss.mjs'), task.outputDir, task.bossConfigPath],
  };
  if (stage === 'finalize') return {
    command: runtimePython(),
    args: [path.join(root, 'work', 'finalize_configurable_dataset.py'), task.outputDir, task.profilePath, String(task.targetRows||0)],
  };
  if (stage === 'workbook') return {
    command: process.execPath,
    args: [path.join(root, 'work', 'build_configurable_job_workbook.mjs'), task.outputDir, task.profilePath],
  };
  throw new Error(`未知阶段：${stage}`);
}

const stageNames = {
  collection: '多平台并发采集',
  public: '公开渠道采集', zhaopin: '智联登录采集', yupao: '鱼泡登录采集',
  boss: 'BOSS页面采集（试验）',
  finalize: '合并去重', workbook: '导出Excel',
};

async function runChild(task, stage, pipeline = false) {
  if(stage.startsWith('login_'))throw new Error('独立平台登录功能已移除');
  if(['zhaopin','yupao','boss'].includes(stage)&&collectionMode(task)!==HYBRID_MODE)assertDirectHttpCollection(stage);
  if(['collection','public'].includes(stage)&&!(task.collectionRoundPlatforms||task.platforms).some(key=>collectionChannelAvailable(key,task)))throw Object.assign(Error('该任务没有当前采集方式可用的渠道，历史数据与断点保留'),{code:'DIRECT_HTTP_REQUIRED'});
  const pipelineToken=pipeline?pipelineRuns.runs.get(task.id):null;
  const cancelled=()=>pipeline&&(!pipelineToken||!pipelineRuns.current(task.id,pipelineToken)||['paused','stopping'].includes(taskById(tasks,task.id)?.status));
  if(cancelled())return {paused:true};
  if (active.has(task.id)||startingStages.has(task.id)) throw new Error('该任务已有程序正在运行或正在检查启动条件');
  if (stage === 'boss' && (startingBoss || [...active.values()].some(item => item.stage === 'boss'))) throw new Error('BOSS使用独立本地会话，同一时间只能登录或采集一个任务');
  if (stage === 'yupao' && (
    [...active.values()].some((item) => item.stage === 'yupao')
    || tasks.some((item) => item.id !== task.id && item.status === 'running' && item.currentStage === 'yupao')
  )) {
    throw new Error('鱼泡验证较严格，同一时间只能运行一个鱼泡采集任务');
  }
  const { command, args } = stageCommand(task, stage);
  startingStages.add(task.id);
  try { await assertCollectorResources(stage === 'workbook' ? 4*1024**3 : stage === 'finalize' ? 1024**3 : 2*1024**3); }
  catch(error) {
    startingStages.delete(task.id);
    if(cancelled())return {paused:true};
    await appendLog(task.id, `\n[资源保护暂停] ${error.message}\n`);
    await setTask(task.id,{status:'paused',currentStage:stage,lastStage:stage,pipeline:false,message:error.message});
    return {paused:true,code:43};
  }
  const isBoss = stage === 'boss';
  if(cancelled()){startingStages.delete(task.id);return {paused:true};}
  if (isBoss) startingBoss = true;
  try {
    if (['public','collection'].includes(stage)) {
      const synced = await synchronizePublicKeywords(task);
      if(cancelled()){startingStages.delete(task.id);return {paused:true};}
      if (synced.changed) await appendLog(task.id, `\n[配置修复] 公开渠道同步全部 ${synced.keywords.length} 个任务关键词；断点与已采集数据保留。\n`);
    }
    if(['public','collection','zhaopin'].includes(stage)){
      const plan=await prepareStructuredCollection(task);
      if(cancelled()){startingStages.delete(task.id);return {paused:true};}
      await appendLog(task.id,`\n[接口执行计划] ${plan.channels.map(channel=>channel.key+':'+channel.mode+(channel.maxPages?'，最多'+channel.maxPages+'页':'')).join('；')}\n`);
      if(plan.changes.length)await appendLog(task.id,`[旧任务配置升级] ${plan.changes.join('；')}；原断点和自定义限额保留。\n`);
    }
    if (stage === 'finalize') await updateUnifiedDataset(task);
    if(cancelled()){startingStages.delete(task.id);return {paused:true};}
    await setTask(task.id, { status: 'running', currentStage: stage, message: `${stageNames[stage]}运行中`, pipeline,collectionIssues:(task.collectionIssues||[]).filter(item=>item.stage!==stage) });
    await appendLog(task.id, `\n[${new Date().toLocaleString('zh-CN')}] ▶ ${stageNames[stage]}\n`);
  } catch (error) { startingStages.delete(task.id); if (isBoss) startingBoss = false; throw error; }

  return await new Promise((resolve, reject) => {
    if(cancelled()){startingStages.delete(task.id);resolve({paused:true});return;}
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, JOB_COLLECTION_MODE:collectionMode(task),JOB_HTTP_RATE_DIR:process.env.JOB_HTTP_RATE_DIR||path.join(dataDir,'http_rate_limits'),JOB_COLLECTION_ROUND:task.collectionRoundCombinations?JSON.stringify({task_id:task.id,combinations:task.collectionRoundCombinations}):'',JOB_STRUCTURED_ROUND_ONLY:task.structuredRoundOnly||'',JOB_COLLECTOR_NATIVE_STORE:'1',JOB_COLLECTOR_TASK_ID:task.id,JOB_TASK_OUTPUT_DIR:task.outputDir,JOB_TASK_BACKUP_ROOT:taskBackupRoot, JOB_COLLECTOR_BLOCKED_POLICY:pipeline?'skip':'wait', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
    });
    active.set(task.id, { child, stage, startedAt: Date.now() });
    startingStages.delete(task.id);
    if (isBoss) startingBoss = false;
    const pipe = (stream, prefix = '') => stream.on('data', (chunk) => appendLog(task.id, `${prefix}${chunk.toString('utf8')}`));
    pipe(child.stdout);
    pipe(child.stderr, '[错误] ');
    child.once('error', async (error) => {
      active.delete(task.id);
      await appendLog(task.id, `\n启动失败：${error.message}\n`);
      await setTask(task.id, { status: 'failed', message: error.message, pipeline: false });
      reject(error);
    });
    child.once('exit', async (code, signal) => {
      const wasPaused = tasks.find((item) => item.id === task.id)?.status === 'stopping';
      active.delete(task.id);
      if (wasPaused) {
        await appendLog(task.id, `\n[已暂停] 下次运行将复用同一输出目录和断点文件。\n`);
        await setTask(task.id, { status: 'paused', message: '已暂停，可从断点续爬', pipeline: false, lastStage: stage });
        resolve({ paused: true, userPaused: true, code, signal });
      } else if (code === 43 || nativeCrashMessage(code)) {
        const message=code === 43?'系统资源不足，采集已安全暂停；请释放资源后从当前阶段断点续采':nativeCrashMessage(code);
        await appendLog(task.id,`\n[资源/原生异常暂停] ${message}\n`);
        await setTask(task.id,{status:'paused',message,pipeline:false,lastStage:stage});
        resolve({paused:true,code});
      } else if (['collection','boss','public','zhaopin','yupao'].includes(stage) && stageDisposition(code,pipeline)==='continue_partial') {
        const issue={stage,at:now(),message:`${stageNames[stage]}部分受阻：数据和断点已保留，跳过受阻渠道继续后续阶段；详见日志`};
        await appendLog(task.id,`\n[渠道跳过] ${issue.message}\n`);
        await setTask(task.id,{status:'running',message:issue.message,lastStage:stage,collectionIssues:[...(task.collectionIssues||[]).filter(item=>item.stage!==stage),issue]});
        resolve({partial:true,code});
      } else if (['collection','boss','public','zhaopin','yupao'].includes(stage) && [42,44].includes(code)) {
        await setTask(task.id, { status: 'paused', message: `${stageNames[stage]}暂停：请查看日志和断点状态，人工处理登录、验证、文件占用或页面异常后再续爬`, pipeline: false, lastStage: stage });
        resolve({ paused: true, code });
      } else if (code === 0) {
        await appendLog(task.id, `\n[完成] ${stageNames[stage]}\n`);
        await setTask(task.id, { status: pipeline ? 'running' : 'ready', message: `${stageNames[stage]}已完成`, lastStage: stage,collectionIssues:(task.collectionIssues||[]).filter(item=>item.stage!==stage) });
        resolve({ code });
      } else {
        const message = `${stageNames[stage]}退出，代码 ${code ?? signal}`;
        await appendLog(task.id, `\n[失败] ${message}\n`);
        await setTask(task.id, { status: 'failed', message, pipeline: false, lastStage: stage });
        reject(Object.assign(new Error(message), {code,signal,stage}));
      }
    });
  });
}

async function runPipeline(task, resumeFrom = '') {
  const stages = [];
  const publicPlatforms = ['shixiseng', 'iguopin', 'mohrss', 'job51', 'jobonline', 'liepin'];
  if (task.platforms.some((key) => publicPlatforms.includes(key)) || task.platforms.includes('zhaopin')) stages.push('collection');
  if (task.platforms.includes('yupao') && collectionChannelAvailable('yupao')) stages.push('yupao');
  if (task.platforms.includes('boss') && collectionChannelAvailable('boss')) stages.push('boss');
  // Database ingestion is the default delivery path. File exports are now explicit actions.
  if (resumeFrom) {
    if(resumeFrom==='public')resumeFrom='collection';
    if(resumeFrom==='zhaopin' && stages.includes('collection'))stages[stages.indexOf('collection')]='zhaopin';
    if(['finalize','workbook'].includes(resumeFrom))resumeFrom='';
    const start = resumeFrom?stages.indexOf(resumeFrom):stages.length;
    if (start < 0) throw new Error('流水线恢复阶段不属于该任务');
    stages.splice(0, start);
  }
  const token=pipelineRuns.begin(task.id);
  const cancelled=()=>!pipelineRuns.current(task.id,token)||['paused','stopping'].includes(taskById(tasks,task.id)?.status);
  let currentStage='';
  try {
    for (const stage of stages) {
      currentStage=stage;
      const fresh = taskById(tasks, task.id);
      if (!fresh || cancelled()) return;
      const result = await runChild(fresh, stage, true);
      if (result.paused) return;
    }
    const fresh = taskById(tasks, task.id) || task;
    if(cancelled())return;
    const continued=await runAdaptiveCollection({task:fresh,isCancelled:cancelled,
      count:()=>otherChannelValidCount(task.outputDir,'',task.id),
      activateKeyword:async keyword=>{
        if(cancelled())return;
        await setTask(task.id,{keywords:[...new Set([...(fresh.keywords||[]),keyword])]});
        await synchronizePublicKeywords(fresh);
        await prepareStructuredCollection(fresh);
        await appendLog(task.id,`\n[相关关键词补采] 增加「${keyword}」；城市仍为${fresh.cities.join('、')}；各渠道仅使用已支持的城市配置，保留分页保护、限流与原断点。\n`);
      },
      onRound:async({round,valid,target,combinations})=>{
        const summary=combinations.map(combo=>`${combo.platform}:${combo.keyword}/${combo.city.name}`).join('；');
        await setTask(task.id,{message:`补采第${round}轮：${combinations.length}个可执行条件；有效去重${valid}条，${untilExhausted(fresh)?goalText(fresh):'目标'+target+'条'}，受阻条件已让位`});
        await appendLog(task.id,`\n[目标续轮] 第${round}轮；有效去重${valid}条；${goalText(fresh)}；执行${summary}。\n`);
      },
      run:async({platforms,combinations})=>{
        if(cancelled())return {paused:true};currentStage='collection';
        return runChild({...taskById(tasks,task.id),collectionRoundPlatforms:platforms,collectionRoundCombinations:combinations},'collection',true);
      }});
    if(cancelled()||continued.paused)return;
    const ingested=await updateUnifiedDataset(fresh);await knowledge.sync({refresh:false});
    const valid=await otherChannelValidCount(task.outputDir,'',task.id);
    if(cancelled())return;
    await appendLog(task.id,`[目标执行结束] ${continued.reason}；有效去重${valid}条，候选入库${ingested.rows}条。\n`);
    if(cancelled())return;
    const outcome=collectionOutcome(fresh,{valid,reason:continued.reason,issues:fresh.collectionIssues||[]});
    await setTask(task.id,{status:outcome.status,validRows:valid,collectionStopReason:continued.reason,currentStage:'',pipeline:false,lastStage:'collection',message:`已归集候选 ${ingested.rows} 条，有效去重 ${valid} 条；${goalText(fresh)}${collectionStopMessage(continued.reason)?'；'+collectionStopMessage(continued.reason):''}；当前阶段结束不代表整个平台已采完，可直接用于洞察与助手${fresh.collectionIssues?.length?'；受阻渠道和断点保留':''}`});
  } catch (error) {
    if(cancelled())return;
    await appendLog(task.id, `\n流水线停止：${error.message}\n`);
    await finalizeAfterCollectionError(task,{stage:currentStage,code:error.code,signal:error.signal}).catch(async failure=>{
      await appendLog(task.id, `\n[异常收尾失败] ${failure.message}；保留原数据和断点，不宣称交付完成。\n`);
    });
  } finally {pipelineRuns.finish(task.id,token);}
}

async function finalizeAfterCollectionError(task,cause) {
  if(['collection','public','zhaopin','yupao','boss'].includes(cause.stage)&&Number.isInteger(cause.code)&&cause.code>0&&![42,43].includes(cause.code)&&!cause.signal){
    const fresh=taskById(tasks,task.id)||task;if(['paused','stopping'].includes(fresh.status))return {skipped:true};
    const saved=await updateUnifiedDataset(fresh);await knowledge.sync({refresh:false});
    if(saved.rows){await setTask(task.id,{status:'partial',currentStage:'',pipeline:false,lastStage:cause.stage,message:`渠道异常退出（${cause.code}）；已安全归集 ${saved.rows} 条到知识库，断点保留，可直接分析`});return {delivered:true,available:saved.rows};}
    return {skipped:true};
  }
  return deliverPartial({
    cause,
    count:()=>otherChannelValidCount(task.outputDir,'',task.id),
    run:async stage=>{
      await appendLog(task.id, `\n[异常收尾] 仅处理本任务已保存的数据：${stageNames[stage]}；不再请求招聘平台。\n`);
      return runChild(taskById(tasks,task.id)||task,stage,false);
    },
    finish:async()=>{
      const fresh=taskById(tasks,task.id)||task;
      const metrics=await metricsFor(fresh);
      const issue={stage:cause.stage,at:now(),message:`${stageNames[cause.stage]}异常退出（${cause.code}），已合并去重并导出本轮已保存的数据`};
      await setTask(task.id,{
        status:'partial',currentStage:'',pipeline:false,lastStage:cause.stage,
        collectionIssues:[...(fresh.collectionIssues||[]).filter(item=>item.stage!==cause.stage),issue],
        message:`${issue.message}；已导出 ${metrics.finalRows} 条${untilExhausted(fresh)?'；无目标条数，渠道异常仍需处理':`/${fresh.targetRows}${metrics.targetReached?'；渠道异常仍需处理':'，目标未达到'}`}`,
      });
      await appendLog(task.id, `\n[异常收尾完成] ${metrics.finalRows} 条；${goalText(fresh)}；渠道异常保留，数量不代表岗位相关性验收。\n`);
    },
  });
}

async function runSingle(task, stage) {
  let recoveryAttempted=false;
  try {
    const result=await runChild(task, stage, false);
    recoveryAttempted=true;
    await finalizeAfterCollectionError(task,{stage,...result});
    if (stage === 'workbook') {
      const fresh = taskById(tasks, task.id) || task;
      const metrics = await metricsFor(fresh);
      await setTask(task.id, metrics.targetReached
        ? { status: 'completed', message: 'Excel 已导出，目标数据量已达到', currentStage: '' }
        : {
            status: 'partial', currentStage: '',
            message: untilExhausted(fresh)?`Excel 已导出 ${metrics.finalRows} 条；无目标条数，采集状态请查看渠道进度`:`Excel 已导出 ${metrics.finalRows} 条，尚未达到 ${fresh.targetRows} 条目标`,
          });
    }
  } catch(error) {
    if(recoveryAttempted){
      await appendLog(task.id, `\n[异常收尾失败] ${error.message}；不再次执行导出，原数据和断点保留。\n`);
      return;
    }
    await finalizeAfterCollectionError(task,{stage,code:error.code,signal:error.signal}).catch(async failure=>{
      await appendLog(task.id, `\n[异常收尾失败] ${failure.message}；保留原数据和断点，不宣称交付完成。\n`);
    });
  }
}

async function createTask(body) {
  const label = String(body.label || '').trim();
  const primaryKeyword = String(body.primaryKeyword || label).trim();
  const keywords = splitTerms(body.keywords);
  if (!label || !primaryKeyword) throw new Error('请填写岗位名称和主关键词');
  if (!keywords.includes(primaryKeyword)) keywords.unshift(primaryKeyword);
  const goal=collectionGoal(body),{targetRows,candidateTarget,collectUntilExhausted}=goal;
  const transportMode=collectionMode({transportMode:body.transportMode||collectionTransportPolicy.mode});
  const browserMaxPages=Number(body.browserMaxPages||3),browserMaxRows=Number(body.browserMaxRows||200);
  if(!Number.isSafeInteger(browserMaxPages)||browserMaxPages<1||browserMaxPages>50||!Number.isSafeInteger(browserMaxRows)||browserMaxRows<1||browserMaxRows>10000)throw Error('浏览器预算须为1–50页、1–10000条');
  const cityNames = splitTerms(body.cities).filter((name) => zhaopinCities[name]);
  if (!cityNames.length) cityNames.push('北京', '上海', '广州', '深圳', '杭州', '成都');
  const allowedPlatforms = ['shixiseng', 'iguopin', 'mohrss', 'jobonline', 'job51', 'zhaopin', 'liepin', 'boss'].filter(key=>collectionChannelAvailable(key,{transportMode}));
  const retiredRequested=splitTerms(body.platforms).filter(key=>!collectionChannelAvailable(key,{transportMode}));
  if(retiredRequested.length)throw new Error(`纯接口模式暂停：${retiredRequested.map(key=>key+'（'+collectionChannelPauseReason(key)+'）').join('、')}；历史数据和断点仍保留`);
  const platforms = splitTerms(body.platforms).filter((value) => allowedPlatforms.includes(value));
  if (!platforms.length) throw new Error('至少选择一个采集渠道');
  const defaultOutput = taskOutputRoot;
  const outputBaseDir = path.resolve(String(body.outputDir || defaultOutput).trim());
  const id = `${Date.now()}-${safeName(label).replace(/\s+/g, '-').slice(0, 32) || 'task'}`;
  const outputDir=isolatedDirectory(outputBaseDir,id);
  const configDir = path.join(taskDataDir, id);
  await fs.mkdir(configDir, { recursive: true });
  await fs.mkdir(outputDir, { recursive: true });

  const pace = String(body.pace || 'balanced');
  const requestSettings = pace === 'safe'
    ? { concurrency: 1, minimumIntervalMs: 4000, jitterMs: 1000, attempts: 2 }
    : pace === 'fast'
      ? { concurrency: 1, minimumIntervalMs: 2500, jitterMs: 700, attempts: 2 }
      : { concurrency: 1, minimumIntervalMs: 3000, jitterMs: 700, attempts: 2 };
  const publicCity = { name: '全国', code: '全国' };
  const publicConfig = {
    task_id:id,
    transportMode,browser:{maxPages:browserMaxPages,maxRows:browserMaxRows},
    apiExecutionVersion:2,
    taskTargetRows:targetRows||0,collectUntilExhausted,
    acquisitionMode:'structured_data_requests',
    keywords,
    platforms: {
      shixiseng: { enabled: platforms.includes('shixiseng'), cities: [publicCity], maxPages: collectUntilExhausted?300:40, maxRows: collectUntilExhausted?6000:Math.min(candidateTarget,500) },
      zhaopin: { enabled: platforms.includes('zhaopin'), cities: cityNames.map((name) => ({ name, code: zhaopinCities[name] })).filter((item) => item.code), maxPages: 60, maxRows: Math.min(candidateTarget,50000) },
      job51: {
        enabled: platforms.includes('job51'),
        cities: cityNames.map((name) => ({ name, code: job51Cities[name] })).filter((item) => item.code),
        maxPages: 100,
      },
      jobonline: { enabled: platforms.includes('jobonline'), cities: Object.entries(jobonlineCities).map(([name, code]) => ({ name, code })), maxRows: collectUntilExhausted?100000:Math.min(candidateTarget,2000) },
      liepin: { enabled: platforms.includes('liepin'), cities: cityNames.map(name=>({name,code:liepinCities[name]})).filter(item=>item.code), maxPages:100, maxRows:candidateTarget },
      iguopin: { enabled: platforms.includes('iguopin'), cities: [{ name: '全国', code: '' }], maxPages: collectUntilExhausted?250:25, maxRows: collectUntilExhausted?5000:Math.min(candidateTarget,2500) },
      mohrss: { enabled: platforms.includes('mohrss'), cities: [{ name: '全国', code: '' }], maxPages: collectUntilExhausted?400:40, maxRows: collectUntilExhausted?8000:Math.min(candidateTarget,2500) },
    },
    request: requestSettings,
  };
  const zhaopinConfig = { task_id:id,keywords, acquisitionMode:'session_json_api',taskTargetRows:targetRows,maxPages:60,maxRows:Math.min(candidateTarget,50000),request:requestSettings,cities: cityNames.map((name) => ({ name, code: zhaopinCities[name] })) };
  const bossConfig = {
    task_id:id,
    keywords, cities: cityNames.map(name => ({ name, code: bossCities[name] })),
    maxPagesPerCombo: 3, maxRows: Math.min(candidateTarget, 100),
    minimumIntervalMs: 6000, jitterMs: 2000, sessionStatusPath: platformStatusPath,
  };
  const yupaoConfig = {
    task_id:id,
    keywords,
    cities: cityNames.map((name) => ({ name })),
    maxPagesPerCombo: pace === 'safe' ? 12 : pace === 'fast' ? 24 : 18,
    detailLimitPerCombo: pace === 'safe' ? 80 : pace === 'fast' ? 160 : 120,
    minimumIntervalMs: pace === 'safe' ? 3200 : pace === 'fast' ? 1600 : 2400,
    jitterMs: pace === 'safe' ? 1800 : pace === 'fast' ? 900 : 1400,
  };
  const profile = {
    task_id:id,collection_relevance_filter:false,
    label,
    primary_keyword: primaryKeyword,
    keywords,
    target_rows: targetRows,collect_until_exhausted:collectUntilExhausted,
    source_directories: splitTerms(body.sourceDirectories),
    relevance: {
      title_terms: splitTerms(body.titleTerms).length ? splitTerms(body.titleTerms) : keywords,
      direct_terms: splitTerms(body.directTerms).length ? splitTerms(body.directTerms) : keywords,
      skill_terms: splitTerms(body.skillTerms),
      role_terms: splitTerms(body.roleTerms).length ? splitTerms(body.roleTerms) : ['开发', '工程师', '架构', '研发', '技术', '程序员', '实习'],
      exclude_terms: splitTerms(body.excludeTerms),
      allow_platform_match: body.allowPlatformMatch !== false,
      levels: ['标题直接匹配', '职责直接匹配', '技术栈匹配', '平台关键词匹配'],
    },
  };
  const publicConfigPath = path.join(configDir, '公开渠道配置.json');
  const zhaopinConfigPath = path.join(configDir, '智联批量配置.json');
  const yupaoConfigPath = path.join(configDir, '鱼泡批量配置.json');
  const bossConfigPath = path.join(configDir, 'BOSS批量配置.json');
  const profilePath = path.join(configDir, '岗位配置.json');
  await fs.writeFile(publicConfigPath, JSON.stringify(publicConfig, null, 2), 'utf8');
  await fs.writeFile(zhaopinConfigPath, JSON.stringify(zhaopinConfig, null, 2), 'utf8');
  await fs.writeFile(yupaoConfigPath, JSON.stringify(yupaoConfig, null, 2), 'utf8');
  await fs.writeFile(bossConfigPath, JSON.stringify(bossConfig, null, 2), 'utf8');
  await fs.writeFile(profilePath, JSON.stringify(profile, null, 2), 'utf8');
  await fs.copyFile(profilePath, path.join(outputDir, '岗位配置.json'));
  await fs.writeFile(path.join(outputDir,'任务归属.json'),JSON.stringify({task_id:id,label,backup_root:taskBackupRoot},null,2),'utf8');

  const task = {
    id, label, primaryKeyword, keywords, ...goal, cities: cityNames, platforms, pace,transportMode,adaptiveSearch:body.adaptiveSearch!==false,
    outputDir, outputBaseDir,datasetScopeVersion:2, configDir, publicConfigPath, zhaopinConfigPath, yupaoConfigPath, bossConfigPath, profilePath,
    status: 'ready', currentStage: '', message: '任务已创建', createdAt: now(), updatedAt: now(), archived: false,
  };
  await snapshotTaskOutput(task,{root:taskBackupRoot});
  tasks.unshift(task);
  await saveTasks(tasks);
  await appendLog(id, `[${new Date().toLocaleString('zh-CN')}] 任务已创建\n输出目录：${outputDir}\n`);
  return task;
}

async function countCsvRows(filePath) {
  try {
    const stat = await fs.stat(filePath);
    const cached = rowCountCache.get(filePath);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.rows;
    const stream = fsSync.createReadStream(filePath);
    let rows = 0;
    let quoted = false;
    let pendingQuote = false;
    for await (const chunk of stream) {
      // Parse bytes so UTF-8 characters split across chunks cannot affect CSV
      // record counting. pendingQuote also handles escaped quotes across chunks.
      for (const byte of chunk) {
        if (byte === 34) {
          if (!quoted) quoted = true;
          else pendingQuote = !pendingQuote;
          continue;
        }
        if (quoted && pendingQuote) {
          quoted = false;
          pendingQuote = false;
        }
        if (byte === 10 && !quoted) rows += 1;
      }
    }
    // Writer output has no trailing newline: newline separators equal data rows
    // (header + N data records have N separators).
    const value = Math.max(0, rows);
    rowCountCache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, rows: value });
    return value;
  } catch { return 0; }
}

async function metricsFor(task) {
  let quality = null;
  let manifest = null;
  try { quality = JSON.parse(await fs.readFile(path.join(task.outputDir, '数据质量报告.json'), 'utf8')); } catch {}
  try { manifest = JSON.parse(await fs.readFile(path.join(task.outputDir, '采集清单.json'), 'utf8')); } catch {}
  quality=ownedReport(quality,task)?quality:null;
  manifest=ownedReport(manifest,task)?manifest:null;
  const liveCollection = await liveCollectionMetrics(task);
  const native=await nativeTaskCounts(task.outputDir,task.id);
  for(const [key,count]of Object.entries(native.platformCounts))liveCollection.platformCounts[key]=Math.max(liveCollection.platformCounts[key]||0,count);
  const nativePublic=['shixiseng','iguopin','mohrss','jobonline','job51','liepin'].reduce((n,key)=>n+(native.platformCounts[key]||0),0);
  const publicRows = Math.max(Number(manifest?.total_rows || 0), liveCollection.publicRows,nativePublic);
  const zhaopinRows = Math.max(native.platformCounts.zhaopin||0,await countCsvRows(path.join(task.outputDir, 'zhaopin_标准化数据.csv')));
  const yupaoRows = Math.max(native.platformCounts.yupao||0,await countCsvRows(path.join(task.outputDir, 'yupao_标准化数据.csv')));
  const bossRows = Math.max(native.platformCounts.boss||0,await countCsvRows(path.join(task.outputDir, 'boss_标准化数据.csv')));
  const unified=await fs.readFile(path.join(task.outputDir,'统一采集数据状态.json'),'utf8').then(JSON.parse).catch(()=>null);
  const knowledgeRows=Math.max(native.rows,unified?.task_id===task.id?Number(unified.rows||0):0);
  const finalRows = Number(quality?.output_rows || 0);
  return {
    publicRows, zhaopinRows, yupaoRows, bossRows, finalRows, knowledgeRows,liveCollection,
    validRows:Number.isSafeInteger(task.validRows)&&!['running','stopping'].includes(task.status)?task.validRows:null,
    hasFinalResult:Boolean(quality),finalResultMessage:quality?'本任务最终结果':'本任务尚未生成最终结果',
    candidates: publicRows + zhaopinRows + yupaoRows + bossRows,
    targetReached: !untilExhausted(task)&&((Number.isSafeInteger(task.validRows)?task.validRows>=task.targetRows:task.status==='completed'&&knowledgeRows>=task.targetRows)||Boolean(quality?.target_reached)),
    duplicatesRemoved: Number(quality?.duplicates_removed || 0),
    platformCounts: quality?.platform_counts || {},
  };
}

async function readManualSession(task) {
  const running=active.get(task.id);
  if(!['collection','zhaopin','yupao'].includes(running?.stage))return null;
  const session=await fs.readFile(path.join(task.outputDir,sessionFileName(running.stage==='collection'?'zhaopin':running.stage)),'utf8').then(JSON.parse).catch(()=>null);
  const ownerMatches=session?.pid===running.child.pid || session?.coordinator_pid===running.child.pid;
  if(session?.task_id!==task.id || !ownerMatches || !session.browser_open)return null;
  try { process.kill(session.pid,0);return session; } catch { return null; }
}
async function publicTask(task) {
  const running = active.get(task.id);
  const browserSession=await readManualSession(task);
  return {
    id: task.id, label: task.label, primaryKeyword: task.primaryKeyword, keywords: task.keywords,adaptiveSearch:task.adaptiveSearch!==false,
    targetRows: task.targetRows, candidateTarget: task.candidateTarget, collectUntilExhausted:untilExhausted(task),collectionGoal:task.collectionGoal, cities: task.cities, platforms: task.platforms,
    transportMode:collectionMode(task),collectionTransportPolicy:collectionPolicyFor(task),availablePlatforms:task.platforms.filter(key=>collectionChannelAvailable(key,task)),pausedPlatforms:task.platforms.filter(key=>!collectionChannelAvailable(key,task)).map(key=>({key,reason:collectionChannelPauseReason(key)})),
    hybridCollection:await fs.readFile(path.join(task.outputDir,'混合采集状态.json'),'utf8').then(JSON.parse).then(s=>s.task_id===task.id?s:null).catch(()=>null),
    pace: task.pace, outputDir: task.outputDir, legacyOutputDir:task.legacyOutputDir||null,status: task.status, currentStage: task.currentStage,
    message: task.message, createdAt: task.createdAt, updatedAt: task.updatedAt,
    browserSession:null,
    latestExport:await fs.readFile(path.join(task.outputDir,'最新导出状态.json'),'utf8').then(JSON.parse).catch(()=>null),
    collectionIssues:task.collectionIssues||[],collectionStopReason:task.collectionStopReason||null,
    collectionSchedule:await fs.readFile(path.join(task.outputDir,'采集调度状态.json'),'utf8').then(JSON.parse).then(state=>state.task_id===task.id?state:null).catch(()=>null),
    runningSeconds: running ? Math.floor((Date.now() - running.startedAt) / 1000) : 0,
    metrics: await metricsFor(task),
  };
}

function json(res, status, value) {
  const data = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data), 'cache-control': 'no-store' });
  res.end(data);
}

async function bodyJson(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 2_000_000) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

async function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const target = path.resolve(publicDir, relative);
  if (!target.startsWith(publicDir)) return json(res, 403, { error: '禁止访问' });
  try {
    const content = await fs.readFile(target);
    const ext = path.extname(target);
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.geojson': 'application/geo+json; charset=utf-8' };
    res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(content);
  } catch { json(res, 404, { error: '未找到' }); }
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${host}:${port}`);
  const pathname = decodeURIComponent(requestUrl.pathname);
  try {
    if (req.method === 'GET' && pathname === '/api/state') {
      const visible = tasks.filter((task) => !task.archived);
      return json(res, 200, { tasks: await Promise.all(visible.map(publicTask)), version: '1.17.0', capabilities: { insightSourceRole:true,multiRoleScreening:true,collectionTransportPolicy,hybridCollection:true,hybridTransportPolicy:collectionPolicyFor({transportMode:HYBRID_MODE}),adaptiveConditionQueue:true,conditionScopedStops:true,channelAcquisition,structuredDataCollection:true,structuredExecutionPlan:true,structuredTargetRounds:true,zhaopinCollection:true,mohrssHttpData:true,unifiedKnowledge:true,nativeCollection:true,optionalExports:true,automaticPartialDelivery:true,retiredChannels:[...retiredCollectionChannels],channelFailureIsolation:true,publicAllKeywords:true,bossCollection: false, job51Collection: true, jobonlineCollection: true, liepinCollection: true, publicChannelCheckpoints: true, nativeDatasets: true, platformLogin: false, aiLabeling: false, labelReview: false, labelPacing: false, resourceRouting: true, insightSelection: true, taskInsightTransfer: true, finalDatasetCatalog: true }, activeCount: new Set([...active.keys(),...pipelineRuns.runs.keys(),...startingStages]).size });
    }
    // Retired workflows: reject every method before body parsing or side effects.
    if (/^\/api\/(?:platforms|labels)(?:\/|$)/.test(pathname) || /^\/api\/tasks\/[^/]+\/login\/?$/.test(pathname)) {
      return json(res, 410, { error: '平台登录与AI打标功能已移除', code: 'FEATURE_REMOVED' });
    }
    if (req.method === 'GET' && /^\/(?:platforms|labels)(?:\/|$)/.test(pathname)) {
      res.writeHead(302, { location: '/tasks', 'cache-control': 'no-store' });res.end();return;
    }
    if (await browserWorkspace.handler(req,res,pathname)||await handleSemanticCloud(req,res,pathname)||await handleInsightClassifier(req,res,pathname)||await handleKnowledge(req,res,pathname)||await handleJobAssistant(req, res, pathname)) return;
    if (req.method === 'GET' && pathname === '/api/insights/datasets') {
      return json(res, 200, { root: knowledge.filename, catalog: 'knowledge-v1', datasets: await discoverInsightDatasets() });
    }
    if (req.method === 'GET' && pathname === '/api/insights') {
      return json(res, 200, await publicInsight());
    }
    if (req.method === 'POST' && pathname === '/api/insights/run') {
      const body = await bodyJson(req);
      if (body.labelJobId && body.labelJobId !== 'auto' || body.reviewedLabelDir || body.prelabelDir || body.reviewedLabelJobId || body.consensusLabelDirs?.length || body.consensusLabelJobIds?.length) {
        return json(res, 410, { error: 'AI打标任务接入已移除，请直接选择岗位数据集生成洞察', code: 'FEATURE_REMOVED' });
      }
      return json(res, 202, { ok: true, state: await startInsight(body), message: String(body.analysisMode || '') === 'full' ? '全量岗位匹配分析已启动' : '抽样分析已启动' });
    }
    if (req.method === 'GET' && pathname === '/api/insights/logs') {
      let content = '';
      try { content = await fs.readFile(insightLogPath, 'utf8'); } catch {}
      return json(res, 200, { content: content.slice(-100000) });
    }
    if (req.method === 'POST' && pathname === '/api/tasks') {
      return json(res, 201, { task: await createTask(await bodyJson(req)) });
    }
    if (req.method === 'GET' && pathname === '/api/tasks') {
      return json(res, 200, { tasks: await Promise.all(tasks.filter(task => !task.archived).map(publicTask)), activeCount: new Set([...active.keys(),...pipelineRuns.runs.keys(),...startingStages]).size });
    }
    const taskResourceMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
    const taskBackupMatch=pathname.match(/^\/api\/tasks\/([^/]+)\/output-backup$/);
    if(taskBackupMatch){
      const item=taskById(tasks,taskBackupMatch[1]);if(!item)return json(res,404,{error:'任务不存在'});
      if(req.method==='GET')return json(res,200,await inspectTaskBackup(item,{root:taskBackupRoot}));
      if(req.method==='POST'){
        if(active.has(item.id)||startingStages.has(item.id)||['running','stopping'].includes(item.status))return json(res,409,{error:'请先暂停任务再备份或恢复'});
        const {action}=await bodyJson(req);if(!['snapshot','restore'].includes(action))return json(res,400,{error:'action 必须是 snapshot 或 restore'});
        startingStages.add(item.id);
        try{return json(res,200,action==='snapshot'?await snapshotTaskOutput(item,{root:taskBackupRoot}):await restoreTaskBackup(item,{root:taskBackupRoot}));}finally{startingStages.delete(item.id);}
      }
      return json(res,405,{error:'仅支持 GET/POST'});
    }
    const taskInsightMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/insight-source$/);
    if (req.method === 'GET' && taskInsightMatch) {
      const item = taskById(tasks, taskInsightMatch[1]);
      if (!item || item.archived) return json(res, 404, { error: '采集任务不存在' });
      const refreshed=await knowledge.sync({tasks:[item],refresh:true});
      const failed=refreshed.sync_errors?.find(error=>error.task_id===item.id);
      if(failed)throw new Error(`当前中间数据同步失败：${failed.error}；已有数据保留`);
      return json(res, 200, await taskInsightSource(item,{knowledge:true,dataDir}));
    }
    if (req.method === 'GET' && taskResourceMatch) {
      const item = taskById(tasks, taskResourceMatch[1]);
      return item && !item.archived ? json(res, 200, { task: await publicTask(item) }) : json(res, 404, { error: '采集任务不存在' });
    }
    const actionMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/(run|pause|open|archive|confirm-verification|export-latest|refresh-latest)$/);
    if (req.method === 'POST' && actionMatch) {
      const [, id, action] = actionMatch;
      const task = taskById(tasks, id);
      if (!task) return json(res, 404, { error: '任务不存在' });
      if(action==='refresh-latest'){
        if(fsSync.existsSync(path.join(task.outputDir,'任务归属.json'))){const refreshed=await updateUnifiedDataset(task);if(refreshed.latestSnapshotError)throw new Error(refreshed.latestSnapshotError);}
        const syncResult=await knowledge.sync({tasks:[task],refresh:true});
        const syncError=syncResult.sync_errors?.find(e=>e.task_id===task.id);if(syncError)throw new Error(`当前中间数据同步失败：${syncError.error}；已有数据保留`);
        return json(res,200,await taskInsightSource(task,{knowledge:true,dataDir}));
      }
      if(action==='export-latest'){
        if(latestExports.size)return json(res,409,{error:'已有最新数据导出正在进行，请稍后重试'});
        await writeJsonAtomic(path.join(task.outputDir,'最新导出状态.json'),{task_id:task.id,status:'running',startedAt:now()});
        const child=spawn(process.execPath,[path.join(root,'work/export_latest_dataset.mjs'),JSON.stringify(task)],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
        latestExports.set(task.id,child);
        child.stdout.on('data',()=>{});let failure='';child.stderr.on('data',chunk=>{failure+=String(chunk).slice(0,2000);});
        const finish=async(code)=>{
          latestExports.delete(task.id);
          if(code!==0){const previous=await fs.readFile(path.join(task.outputDir,'最新导出状态.json'),'utf8').then(JSON.parse).catch(()=>null);if(previous?.status==='running')await writeJsonAtomic(path.join(task.outputDir,'最新导出状态.json'),{task_id:task.id,status:'failed',error:failure||'导出进程异常退出',updatedAt:now()});}
        };
        child.once('error',error=>{failure=error.message;void finish(1);});child.once('close',code=>void finish(code));
        return json(res,202,{ok:true,message:'正在导出最新CSV／Excel，采集状态不变；完成情况显示在任务页'});
      }
      if(action==='confirm-verification') {
        const session=await readManualSession(task);
        if(session?.verification_status!=='waiting_human')return json(res,409,{error:'没有正在等待人工验证的当前浏览器会话'});
        await writeJsonAtomic(path.join(task.outputDir,sessionFileName(session.platform)+'.confirm.json'),{task_id:task.id,session_id:session.session_id,confirmed_at:now()});
        return json(res,202,{message:'已提交人工确认；程序将检查当前搜索页，验证通过后继续同一会话'});
      }
      if (action === 'run') {
        if (active.has(id) || pipelineRuns.has(id) || startingStages.has(id) || ['running', 'stopping'].includes(task.status)) throw new Error('该任务已有程序正在运行或正在检查启动条件');
        const { stage = 'all', resumeFrom = '' } = await bodyJson(req);
        if(stage==='all'||['public','zhaopin','yupao','boss'].includes(stage)){
          startingStages.add(id);
          try{await assertTaskOutputOwnership(task);await snapshotTaskOutput(task,{root:taskBackupRoot});}finally{startingStages.delete(id);}
        }
        if(!collectionChannelAvailable(stage)||!collectionChannelAvailable(resumeFrom))throw new Error('该渠道已停用，不能续采；请运行其他渠道或合并导出已有数据');
        if (stage === 'all') {
          if (resumeFrom && !['collection','public', 'zhaopin', 'yupao', 'boss', 'finalize', 'workbook'].includes(resumeFrom)) throw new Error('恢复阶段无效');
          if (resumeFrom === 'public' && !task.platforms.some(key=>['shixiseng','iguopin','mohrss','job51','jobonline','liepin'].includes(key)) || ['zhaopin','yupao','boss'].includes(resumeFrom) && !task.platforms.includes(resumeFrom)) throw new Error('恢复阶段不属于该任务');
          // Clear the old pause marker before entering the pipeline's cancellation checks.
          await setTask(task.id, { status: 'ready', pipeline: true, message: '准备恢复采集流水线' });
          void runPipeline(task, resumeFrom);
        }
        else {
          if (!['public', 'zhaopin', 'yupao', 'boss', 'finalize', 'workbook'].includes(stage)) throw new Error('不支持的运行阶段');
          if (stage === 'boss' && !task.platforms.includes('boss')) throw new Error('该任务未选择BOSS渠道，请新建包含BOSS的任务');
          void runSingle(task, stage);
        }
        return json(res, 202, { ok: true, message: '已启动' });
      }
      if (action === 'pause') {
        const running = active.get(id);
        const cancelledPipeline=pipelineRuns.cancel(id);
        if (!running){
          if(!cancelledPipeline)return json(res,409,{error:'任务当前未运行'});
          await setTask(id,{status:'paused',pipeline:false,message:'已暂停，后续轮次不会启动；已保存数据和断点保留'});
          return json(res,202,{ok:true,message:'已暂停流水线'});
        }
        await setTask(id, { status: 'stopping', message: '正在安全停止当前进程' });
        if (process.platform === 'win32') {
          const killer = spawn('taskkill', ['/PID', String(running.child.pid), '/T', '/F'], { windowsHide: true });
          killer.on('error', () => running.child.kill('SIGTERM'));
        } else running.child.kill('SIGTERM');
        return json(res, 202, { ok: true, message: '正在暂停；当前未落盘的小段将在续爬时自动重采并去重' });
      }
      if (action === 'open') {
        spawn('explorer.exe', [task.outputDir], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
        return json(res, 200, { ok: true });
      }
      if (action === 'archive') {
        if (active.has(id)||pipelineRuns.has(id)||startingStages.has(id)) throw new Error('请先暂停任务');
        task.archived = true;
        await saveTasks(tasks);
        return json(res, 200, { ok: true, message: '任务已从控制台移除，输出文件未删除' });
      }
    }
    const logMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/logs$/);
    if (req.method === 'GET' && logMatch) {
      const filePath = path.join(logDir, `${logMatch[1]}.log`);
      let content = '';
      try {
        const stat = await fs.stat(filePath);
        const start = Math.max(0, stat.size - 180_000);
        const handle = await fs.open(filePath, 'r');
        const buffer = Buffer.alloc(stat.size - start);
        await handle.read(buffer, 0, buffer.length, start);
        await handle.close();
        content = buffer.toString('utf8');
      } catch {}
      return json(res, 200, { content });
    }
    if (pathname.startsWith('/api/')) return json(res, 404, { error: '接口不存在' });
    if (req.method === 'GET' && /^\/tasks(?:\/[^/]+)?\/?$|^\/(?:insights|browser)\/?$/.test(pathname)) return await serveStatic(req, res, '/');
    return await serveStatic(req, res, pathname);
  } catch (error) {
    console.error(error);
    return json(res, 400, { error: error.message || String(error) });
  }
});

server.listen(port, host, () => {
  console.log(`岗位采集控制台已启动：${consoleUrl()}`);
  console.log(`任务数据：${dataDir}`);
  if (process.env.JOB_UI_START_WORKER !== '0') spawn(process.execPath,[path.join(root,'work','unified_collection_worker.mjs'),consoleUrl()],{cwd:root,stdio:'ignore',windowsHide:true}).unref();
  if (process.env.JOB_UI_OPEN_BROWSER === '1') openBrowser();
});

server.on('error', async (error) => {
  if (error.code === 'EADDRINUSE' && await existingConsoleIsReady()) {
    console.log(`岗位采集控制台已在运行：${consoleUrl()}`);
    if (process.env.JOB_UI_OPEN_BROWSER === '1') openBrowser();
    process.exit(0);
  }
  if (error.code === 'EADDRINUSE') {
    console.error(`端口 ${port} 已被其他程序占用，无法启动岗位采集控制台。`);
  } else {
    console.error('岗位采集控制台启动失败：', error);
  }
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void insightSupervised.cancel();
    void semanticCloud.cancel();
    void browserWorkspace.dispose();
    for (const { child } of active.values()) child.kill('SIGTERM');
    if (activeInsight?.child) activeInsight.child.kill('SIGTERM');
    server.close(() => process.exit(0));
  });
}
