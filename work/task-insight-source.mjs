import fs from 'node:fs/promises';
import path from 'node:path';

export async function taskInsightSource(task) {
  const directory = path.resolve(task.outputDir);
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(path.join(directory, '最终交付清单.json'), 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('任务交付清单不可读取，请重新导出后再用于洞察');
  }
  const key = (value) => String(value || '').trim().replace(/\s+/g, '').toLowerCase();
  if(task.datasetScopeVersion===2 && (!manifest || manifest.task_id!==task.id))throw new Error('本任务尚未生成有效交付结果，不能使用历史数据');
  if(manifest?.task_id && manifest.task_id!==task.id)throw new Error('交付清单任务 ID 不一致，拒绝用于洞察');
  if (manifest && key(manifest.label) !== key(task.label)) throw new Error('交付清单岗位与当前任务不一致，请检查共享输出目录；不会使用其他任务数据');
  const names = manifest ? [manifest.named_dataset, manifest.dataset, manifest.workbook].filter(Boolean) : [];
  if (!manifest) {
    // No manifest yet: only an unambiguous task-named export is acceptable.
    const entries = await fs.readdir(directory);
    const prefix = `${task.label}岗位_`.toLowerCase();
    const named = entries.filter((name) => name.toLowerCase().startsWith(prefix) && /_\d+条(?:_标准化数据)?\.(csv|xlsx)$/i.test(name));
    const csv = named.filter((name) => /\.csv$/i.test(name));
    const candidates = csv.length ? csv : named;
    if (candidates.length !== 1) throw new Error('缺少当前任务的有效交付清单或唯一交付文件，请先完成导出或手工选择数据集');
    names.push(candidates[0]);
  }
  for (const name of names) {
    const filePath = path.resolve(directory, String(name));
    if (path.dirname(filePath).toLowerCase() !== directory.toLowerCase() || !/\.(csv|xlsx)$/i.test(filePath)) throw new Error('交付清单包含不属于任务目录的数据路径，已拒绝转移');
    const stat = await fs.stat(filePath).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (!stat?.isFile() || !stat.size) continue;
    return { taskId: task.id, role: task.label, dataset: { path: filePath, taskId: task.id, name: `${task.label} · ${path.basename(filePath)}`, size: stat.size, format: path.extname(filePath).slice(1), expectedRows: Number(manifest?.rows || path.basename(filePath).match(/_(\d+)条/)?.[1]) || null, resolution: manifest ? 'delivery_manifest' : 'task_named_export', collecting: task.status === 'running' } };
  }
  throw new Error('当前任务交付清单中的数据文件不存在或为空，请先重新导出');
}
