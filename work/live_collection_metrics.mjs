import fs from 'node:fs/promises';
import path from 'node:path';
import {parseChannelCsv} from './public_channel_csv.mjs';

const cache = new Map();
const publicChannels = ['shixiseng', 'iguopin', 'mohrss', 'jobonline', 'job51', 'liepin'];
const rawNames = {'实习僧':'shixiseng','国聘':'iguopin','中国公共招聘网':'mohrss','就业在线':'jobonline','前程无忧':'job51','猎聘':'liepin'};
const idOf = row => row?.uuid ?? row?.job_id ?? row?.jobId ?? row?.acb200;

// Cache compact IDs/counters, never the full descriptions. Atomic checkpoint
// replacement means readers see a complete old or new version.
async function cached(file, key, project) {
  try {
    const stat = await fs.stat(file);
    const previous = cache.get(file);
    if (previous?.key === key && previous.size === stat.size && previous.mtime === stat.mtimeMs) return previous.value;
    const value = project(await fs.readFile(file, 'utf8'));
    cache.set(file, {key, size:stat.size, mtime:stat.mtimeMs, value});
    return value;
  } catch { return null; }
}

export async function liveCollectionMetrics(task) {
  const ids = Object.fromEntries(publicChannels.map(key => [key, new Set()]));
  const progress = [];
  for (const folder of ['断点数据', '原始数据']) {
    const dir = path.join(task.outputDir, folder);
    const names = await fs.readdir(dir).catch(() => []);
    for (const name of names.filter(name => name.endsWith('.json') && !name.endsWith('.diagnostic.json'))) {
      const platform = publicChannels.find(key => name.startsWith(`${key}_`)) || Object.entries(rawNames).find(([label]) => name.startsWith(`${label}_`))?.[1];
      if (!platform) continue;
      const snapshot = await cached(path.join(dir,name), task.id, text => {
        const data = JSON.parse(text);
        if (data.task_id !== task.id) return null;
        let rows = platform === 'shixiseng' ? (data.list || data.records?.map(row=>row.list) || []) : (data.records || []);
        if (platform === 'iguopin' && data.city?.name && data.city.name !== '全国') rows = rows.filter(row=>(row.district_list||[]).some(area=>String(area.area_cn||'').includes(data.city.name)));
        const rowIds = [...new Set(rows.map(idOf).filter(id=>id !== undefined && id !== null && id !== '').map(String))];
        const details = Object.values(data.details || {});
        return {ids:rowIds, platform, keyword:data.keyword||'', city:data.city?.name||'', discovered:rowIds.length,
          processed:details.length, successful:details.filter(row=>row.ok === true).length,
          failed:details.filter(row=>row.ok !== true).length, listComplete:Boolean(data.listComplete)};
      });
      if (!snapshot) continue;
      snapshot.ids.forEach(id => ids[platform].add(id));
      if (folder === '断点数据' && platform === 'shixiseng') {
        const {ids:unused, ...detail} = snapshot;
        progress.push(detail);
      }
    }
  }
  // Channel CSVs already contain retained exports; union with checkpoints,
  // instead of adding the same jobs again across keywords or sources.
  const owner = await fs.readFile(path.join(task.outputDir,'任务归属.json'),'utf8').then(JSON.parse).catch(()=>null);
  if (owner?.task_id === task.id) for (const platform of publicChannels) {
    const rowIds = await cached(path.join(task.outputDir,`${platform}_标准化数据.csv`), task.id,
      text => parseChannelCsv(text).map(idOf).filter(id=>id !== undefined && id !== null && id !== '').map(String));
    rowIds?.forEach(id=>ids[platform].add(id));
  }
  const platformCounts = Object.fromEntries(publicChannels.map(key=>[key, ids[key].size]));
  return {task_id:task.id, updatedAt:new Date().toISOString(), publicRows:Object.values(platformCounts).reduce((sum,n)=>sum+n,0), platformCounts, details:progress};
}
