import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {createLiveAssistantRun,collapseAssistantEvidence} from '../job_collector_ui/public/assistant-live-run.js';
// Optional test-only dependency outside the application and production data.
const packageDir=process.env.ASSISTANT_TEST_DOM_DIR||'D:/岗位采集数据/界面验证依赖/node_modules/linkedom';
const {parseHTML}=await import(pathToFileURL(path.join(packageDir,'esm/index.js')).href);
const {document}=parseHTML('<html><body><article id="message"><div class="assistant-message-text"></div></article></body></html>');
globalThis.document=document;
const item=document.querySelector('#message'),rendered=[];
const live=createLiveAssistantRun(item,{labels:{search_jobs:'岗位检索'},renderMarkdown:(root,text)=>{rendered.push(text);root.textContent=text;}});
try{
  const panel=item.querySelector('.assistant-live-run');assert.equal(panel.open,true);assert.equal(item.getAttribute('aria-busy'),'true');
  live.event({type:'phase',message:'正在核对条件'});assert.match(panel.querySelector('summary').textContent,/正在核对条件/);
  live.event({type:'plan',steps:['确认范围','检索','核验']});assert.match(panel.querySelector('.assistant-live-plan').textContent,/确认范围 → 检索 → 核验/);
  live.event({type:'tool_start',id:'one',tool:'search_jobs'});assert.equal(panel.querySelector('li').dataset.state,'running');
  live.event({type:'tool_end',id:'one',tool:'search_jobs',status:'ready',rows:12,duration_ms:550});
  assert.match(panel.querySelector('li').textContent,/岗位检索 · 已返回 · 12 条 · 0.6 秒/);assert.equal(panel.querySelectorAll('li').length,1);
  const answer='已核验的报告内容。'.repeat(15);live.event({type:'answer_delta',text:answer});
  assert.ok(rendered[0].length<answer.length,'answer must be incrementally presented, not one DOM replacement');
  await live.complete(answer);assert.equal(item.querySelector('.assistant-message-text').textContent,answer);assert.equal(panel.open,false);assert.equal(item.getAttribute('aria-busy'),'false');
  const evidence=document.createElement('div');evidence.innerHTML='<div class="assistant-metrics">统计</div><details class="assistant-source-list"><summary>证据</summary>JD原文</details><article data-action-state="pending">需要点击确认</article><p class="assistant-warning">尚未执行采集</p>';
  const closed=collapseAssistantEvidence(evidence,{trace:[{}]});
  assert.ok(!closed.open);assert.equal(closed.querySelectorAll('.assistant-metrics,.assistant-source-list').length,2);assert.match(closed.querySelector('summary').textContent,/1 步工具/);
  assert.equal(evidence.querySelector('[data-action-state=pending]').parentElement,evidence,'confirmation must not be hidden');
  assert.equal(evidence.querySelector('.assistant-warning').parentElement,evidence,'failure/warning must remain visible');
  const other=document.createElement('article');other.innerHTML='<div class="assistant-message-text"></div>';
  const cancelled=createLiveAssistantRun(other,{renderMarkdown:(root,text)=>root.textContent=text});
  cancelled.event({type:'tool_start',id:'a',tool:'search_jobs'});cancelled.stop();assert.equal(other.querySelector('li').dataset.state,'failed');assert.match(other.textContent,/结果待核对/);assert.equal(other.querySelector('details').open,false);
  console.log('PASS: live status/plan, tool-start-to-result replacement, paced answer DOM updates, auto-collapse, accessible busy state, visible confirmation/warnings and interrupted tool states');
}finally{live.stop();delete globalThis.document;}
