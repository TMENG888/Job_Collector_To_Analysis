import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(process.execPath, ['scripts/docs-demo.mjs'], {
  cwd: root, env: { ...process.env, JOB_DOCS_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
try {
  const origin = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(Error('Demo startup timed out')), 10000);
    child.once('exit', code => { clearTimeout(timeout); reject(Error(`Demo exited: ${code}`)); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.stdout.on('data', data => {
      output += data;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timeout); resolve(match[0]); }
    });
  });
  const get = async route => { const res = await fetch(origin + route); assert.equal(res.status, 200, route); return res; };
  assert.match(await (await get('/')).text(), /说明书演示 · 合成数据 · 只读/);
  assert.match(await (await get('/app.js')).text(), /bindCohortExplorer/);
  const tasks = await (await get('/api/tasks')).json();
  assert.equal(tasks.tasks[0].id, 'docs-demo-agent');
  assert.equal(tasks.tasks[0].metrics.finalRows, 120);
  assert.equal(tasks.tasks[0].metrics.knowledgeRows,120);
  assert.equal((await (await get('/api/knowledge/datasets')).json()).datasets[0].resolution,'knowledge');
  assert.equal((await (await get('/api/assistant/sessions')).json()).collection_flow_version,2);
  const replay=await fetch(origin+'/api/assistant/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'read',id:'docs-collection'})});
  assert.equal(replay.status,200);
  const card=(await replay.json()).turns[0].turn.result.action;
  assert.deepEqual(card.config.keywords,['测试工程师']);assert.equal(card.status,'pending');
  const insight = await (await get('/api/insights')).json();
  assert.equal(insight.report.cohort_observations.length, 96);
  assert.equal(insight.report.quality.salary_rows, 84);
  const { cohortSalaryStatistics, filterCohort } = await import('../job_collector_ui/public/insight-cohorts.js');
  assert.equal(cohortSalaryStatistics(filterCohort(insight.report.cohort_observations, { city: '北京' })).count, 12);
  assert.equal(cohortSalaryStatistics(filterCohort(insight.report.cohort_observations, { city: '北京', experience: '1-3年' })).count, 4);
  for (const route of ['/api/tasks', '/api/platforms/yupao/login', '/api/insights/run', '/api/labels','/api/assistant/action','/api/assistant/chat','/api/assistant/model']) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal((await fetch(origin + route, { method })).status, 403);
  }
  for(const action of ['create','rename','delete','restore'])assert.equal((await fetch(origin+'/api/assistant/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,id:'docs-collection'})})).status,403);
  console.log('docs-demo: native catalog, synthetic replay, correct keywords, salary counts and 32 blocked write requests passed');
} finally {
  if (child.exitCode === null) {
    await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
  }
}
