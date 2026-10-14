import assert from 'node:assert/strict';
import {wordCloudTerms,layoutWordCloud,renderKeywordWordCloud} from '../job_collector_ui/public/insight-wordcloud.js';
const terms=Array.from({length:100},(_,i)=>({name:i===0?'SQL':'业务关键词'+i,score:100-i,seed_count:200-i,lift:3,used_for_filter:i<40}));
const layout=layoutWordCloud(terms);
assert.equal(layout.words.length,100);
for(const [i,a] of layout.words.entries()){
  assert.ok(a.x>=0&&a.y>=0&&a.x+a.width<=layout.width&&a.y+a.height<=layout.height);
  for(const b of layout.words.slice(i+1))assert.ok(!(a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y));
}
assert.ok(layout.words[0].fontSize>layout.words.at(-1).fontSize);
const radialDistance=word=>Math.hypot(word.x+word.width/2-layout.width/2,(word.y+word.height/2-layout.height/2)/0.72);
assert.ok(radialDistance(layout.words[0])<0.01,'highest weight stays at center');
for(let i=1;i<layout.words.length;i++){
  assert.ok(layout.words[i].fontSize<=layout.words[i-1].fontSize,'font size decreases with weight');
}
const meanRadius=words=>words.reduce((sum,word)=>sum+radialDistance(word),0)/words.length;
assert.ok(meanRadius(layout.words.slice(0,10))<meanRadius(layout.words.slice(-10)),'low weight words cluster further outward');
assert.equal(wordCloudTerms([...terms,...terms]).length,100);
assert.match(renderKeywordWordCloud(terms),/展示 100 个关键词/);
assert.match(renderKeywordWordCloud(terms),/仅展示，不参与岗位筛选/);
assert.match(renderKeywordWordCloud([{name:'<script>alert(1)</script>',score:1}]),/&lt;script&gt;/);
assert.match(renderKeywordWordCloud([]),/暂无/);
assert.equal(wordCloudTerms([{name:'旧报告',seed_count:12}])[0].weight,12);
console.log('PASS keyword cloud: 100 words, weighted sizing, bounds, no overlaps, dedup, escape, empty and legacy reports');
