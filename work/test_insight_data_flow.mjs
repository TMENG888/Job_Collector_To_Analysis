import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const testRoot=await fs.mkdtemp(path.join(root,'ui_data_flow_test_'));
await fs.copyFile(path.join(root,'ui_data','label_jobs.json'),path.join(testRoot,'label_jobs.json'));
const child=spawn(process.execPath,[path.join(root,'job_collector_ui','server.mjs'),'8766'],{cwd:root,env:{...process.env,JOB_UI_DATA_DIR:testRoot,JOB_UI_OPEN_BROWSER:'0'},windowsHide:true,stdio:['ignore','pipe','pipe']});
let logs='';child.stdout.on('data',c=>logs+=c);child.stderr.on('data',c=>logs+=c);
const origin='http://127.0.0.1:8766';
const request=async(route,body)=>{const response=await fetch(origin+route,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});const json=await response.json();assert.ok(response.ok,JSON.stringify(json));return json;};
try{
  for(let i=0;i<30;i++){try{await request('/api/state');break;}catch{await new Promise(r=>setTimeout(r,200));}}
  const datasets=await request('/api/insights/datasets');
  const jobs=(await request('/api/labels')).jobs;
  const rule=jobs.find(j=>j.id==='1790913948169-label');
  assert.ok(datasets.datasets.some(d=>d.path===rule.inputFile));
  const deep=jobs.find(j=>j.id==='1790914152428-label');
  assert.ok(datasets.datasets.some(d=>d.path===deep.inputFile),'External labeled datasets should be discoverable');
  const run=async(input)=>{
    await request('/api/insights/run',{inputFile:input,sheetName:'岗位数据',role:'爬虫/数据采集',analysisMode:'full',labelJobId:'auto'});
    for(let i=0;i<100;i++){await new Promise(r=>setTimeout(r,400));const status=await request('/api/insights');if(status.status==='completed')return status.report;if(status.status==='failed')throw new Error(status.error);}
    throw new Error('Analysis did not complete');
  };
  const ruleReport=await run(rule.inputFile);assert.equal(ruleReport.label_provenance.job_id,rule.id);assert.equal(ruleReport.cohort_observations.length,ruleReport.sample_rows);
  const consensusReport=await run(deep.inputFile);assert.match(consensusReport.label_provenance.mode,/双平台一致/);assert.ok(consensusReport.label_provenance.matched>=5);assert.ok(consensusReport.label_provenance.used_in_focused_rows>0);
  console.log(JSON.stringify({ok:true,datasets:datasets.datasets.length,rule_rows:ruleReport.sample_rows,consensus_used:consensusReport.label_provenance.used_in_focused_rows,test_data:testRoot}));
}finally{child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}
