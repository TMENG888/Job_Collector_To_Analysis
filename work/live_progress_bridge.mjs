// Temporary compatibility bridge for an already running UI server. Read-only
// towards collection data; publishes aggregate counts only, not job content.
// Exits when the server is gone or upgraded to native live metrics.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {liveCollectionMetrics} from './live_collection_metrics.mjs';
import {writeJsonAtomic} from './collector_storage.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(root,'job_collector_ui/public/live-progress.json');
const base = process.argv[2] || 'http://127.0.0.1:8788';
let failures = 0;
while (true) {
  try {
    const response = await fetch(`${base}/api/tasks`, {signal:AbortSignal.timeout(5000)});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const {tasks} = await response.json();
    if (tasks.every(task=>task.metrics?.liveCollection)) break;
    const snapshots = {};
    for (const task of tasks) snapshots[task.id] = await liveCollectionMetrics(task);
    await writeJsonAtomic(destination, {updatedAt:new Date().toISOString(), tasks:snapshots});
    failures = 0;
  } catch (error) {
    console.error(error.message);
    if (++failures >= 3) break;
  }
  await new Promise(resolve=>setTimeout(resolve,3000));
}
await writeJsonAtomic(destination, {updatedAt:new Date().toISOString(), tasks:{}});
