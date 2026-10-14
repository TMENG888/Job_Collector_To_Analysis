import assert from 'node:assert/strict';
import {fitSkillSalaryIncrements} from '../job_collector_ui/public/skill-salary-increments.js';
import {renderSkillSalaryAssociations} from '../job_collector_ui/public/insight-profile-charts.js';
const rows=Array.from({length:480},(_,i)=>{
  const tech=i%4>=2,negative=i%4===1||i%4===3,city=Math.floor(i/4)%2;
  return {row_no:i+2,job_id:String(i),platform:'test',company_key:`company-${Math.floor(i/8)}`,
    city:city?'上海':'北京',experience:'1-3年',education:'本科',company_size:'100-499人',employment_type:'全职',
    skills:['C',...(tech?['RTOS']:[]),...(negative?['Legacy']:[])],salary_midpoint_k:12+city*8+tech*5-negative*2};
});
const model=fitSkillSalaryIncrements(rows);
assert.equal(model.status,'ready');assert.equal(model.positive_increment_publish,true);
assert.deepEqual(model.baseline_skills,['C']);
assert.ok(model.effects.every(e=>e.delta_k>=0));
const effect=model.effects.find(e=>e.name==='RTOS');
assert.ok(effect.delta_k>4.5 && effect.delta_k<5.1,JSON.stringify(effect));
assert.equal(model.effects.find(e=>e.name==='Legacy').delta_k,0);
assert.equal(model.sample_count,480);assert.ok(model.metrics.mae_k<model.baseline_metrics.mae_k);
assert.equal(fitSkillSalaryIncrements([...rows,...rows]).sample_count,480);
assert.equal(fitSkillSalaryIncrements(rows.slice(0,20)).status,'insufficient');
assert.equal(fitSkillSalaryIncrements(rows.map(r=>({...r,company_key:'one'}))).status,'insufficient');
const flat=fitSkillSalaryIncrements(rows.map(r=>({...r,salary_midpoint_k:20})));
assert.equal(flat.positive_increment_publish,false);assert.ok(flat.effects.every(e=>e.delta_k===null));
assert.equal(fitSkillSalaryIncrements(rows.map(r=>({...r,salary_midpoint_k:500}))).status,'insufficient');
assert.match(renderSkillSalaryAssociations(rows),/非负加性岭回归/);
assert.match(renderSkillSalaryAssociations(rows),/未检出正向增量/);
assert.match(renderSkillSalaryAssociations(rows.map(r=>({...r,salary_midpoint_k:20}))),/暂不发布增量/);
console.log('PASS: controlled positive recovery, nonnegative effects, group CV, no-signal publication gate, dedup, salary validity and sparse samples');
