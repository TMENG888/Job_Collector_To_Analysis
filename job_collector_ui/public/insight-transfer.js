export const localPathKey = (value) => String(value || '').trim().replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase();
export async function resolveLatestInsightSource(task,request){
  // Task-scoped transfer refreshes committed intermediate rows and carries the
  // running flag; a catalog lookup alone may still be the previous poll.
  try{return (await request(`/api/tasks/${encodeURIComponent(task.id)}/insight-source`,{timeoutMs:120000})).dataset;}catch(error){if(error.status!==404)throw error;}
  try{const dataset=(await request(`/api/knowledge/tasks/${encodeURIComponent(task.id)}/source`)).dataset;return {...dataset,collecting:['running','stopping'].includes(task.status)};}catch(error){if(error.status!==404)throw error;}
  try{return (await request(`/api/tasks/${encodeURIComponent(task.id)}/refresh-latest`,{method:'POST',body:'{}',timeoutMs:120000})).dataset;}
  catch(error){
    if(error.status!==404)throw error;
    // Old servers can still analyze an explicitly supplied CSV. Do not attach
    // a sourceTaskId: their delivery-only validator cannot recognize snapshots.
    const directory=String(task.outputDir||'').replace(/[\\/]+$/,'');
    if(!directory)throw new Error('任务输出目录缺失，无法对接最新数据');
    return {path:directory+'\\最新数据.csv',taskId:task.id,format:'csv',resolution:'latest_snapshot_legacy',expectedRows:null,collecting:task.status==='running',complete:false,requiresManualSource:true};
  }
}
export const localDirectory = (value) => localPathKey(value).replace(/\\[^\\]+$/, '');
const basename = (value) => String(value || '').replaceAll('/', '\\').split('\\').pop();
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function normalizeDiscoveredDatasets(datasets, tasks) {
  return datasets.map((dataset) => {
    const owners = tasks.filter((task) => localPathKey(task.outputDir) === localDirectory(dataset.path));
    const owner = owners.length === 1 ? owners[0] : null;
    const folder = basename(localDirectory(dataset.path));
    return { ...dataset, taskId: owner?.id || '', name: `${owner?.label || folder} · ${basename(dataset.path).replace(/\.(xlsx|csv)$/i, '')}`, collecting: owner?.status === 'running' };
  });
}

export function selectLegacyTaskDataset(task, datasets) {
  const candidates = datasets.filter((dataset) => localDirectory(dataset.path) === localPathKey(task.outputDir));
  const canonical = candidates.filter((dataset) => dataset.canonical && dataset.taskId === task.id);
  if (canonical.length === 1) return canonical[0];
  // Do not trust taskId from old servers; a broad parent task could own unrelated
  // historical spreadsheets. Legacy transfer requires a task-named export.
  const named = new RegExp(`^${escapeRegex(task.label)}岗位_\\d+条(?:_标准化数据)?\\.(csv|xlsx)$`, 'i');
  const matching = candidates.filter((dataset) => named.test(basename(dataset.path)));
  const csv = matching.filter((dataset) => /\.csv$/i.test(dataset.path));
  const preferred = csv.length ? csv : matching;
  if (preferred.length !== 1) throw new Error(preferred.length ? '当前任务有多个交付版本，请手工指定数据集或重启服务以读取交付清单' : '旧版服务未找到当前任务对应的交付文件，请先导出数据或重启服务；不会选择历史岗位文件');
  const dataset = preferred[0];
  return { ...dataset, taskId: task.id, expectedRows: Number(basename(dataset.path).match(/_(\d+)条/)?.[1]) || null, resolution: 'task_named_legacy' };
}

export function finalDatasetCatalog(datasets, tasks) {
  if(datasets.some(d=>d.resolution==='knowledge'))return datasets.filter(d=>d.resolution==='knowledge');
  const found = new Map();
  for (const task of tasks.filter((item) => !item.archived)) {
    const candidates = datasets.filter((dataset) => localDirectory(dataset.path) === localPathKey(task.outputDir));
    let selected = candidates.find((dataset) => dataset.canonical && dataset.taskId === task.id);
    if (!selected) {
      try { selected = selectLegacyTaskDataset(task, candidates); }
      catch {
        const currentRows = Number(task.metrics?.finalRows);
        const named = new RegExp(`^${escapeRegex(task.label)}岗位_${currentRows}条(?:_标准化数据)?\\.csv$`, 'i');
        const current = currentRows > 0 ? candidates.filter((dataset) => named.test(basename(dataset.path))) : [];
        if (current.length === 1) selected = { ...current[0], expectedRows: currentRows };
        // Multiple named historical exports: the stable final merged CSV is
        // the current analysis source, but never infer ownership in shared dirs.
        const owners = tasks.filter((item) => !item.archived && localPathKey(item.outputDir) === localPathKey(task.outputDir));
        if (!selected && owners.length === 1) selected = candidates.find((dataset) => /^最终合并数据\.csv$/i.test(basename(dataset.path)));
      }
    }
    if (!selected) continue;
    const rows = selected.expectedRows || Number(task.metrics?.finalRows) || null;
    const dataset = { ...selected, taskId: task.id, canonical: true, expectedRows: rows, collecting: task.status === 'running', resolution: selected.resolution || 'final_catalog_legacy', name: `${task.label} · ${selected.resolution==='latest_snapshot'?'最新候选数据（未最终交付）':'最终整合数据'}${rows ? ` · ${rows.toLocaleString('zh-CN')} 条` : ''}` };
    found.set(localPathKey(dataset.path), dataset);
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}
