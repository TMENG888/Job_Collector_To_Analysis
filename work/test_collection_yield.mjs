import assert from 'node:assert/strict';
import {YieldWindow,yieldNote} from './collection_yield.mjs';
import {zhaopinCheckpoint} from './zhaopin_checkpoint.mjs';
const ids=Array.from({length:100},(_,i)=>String(i));
let detector=new YieldWindow(new Set(ids)),probe;
for(let page=0;page<4;page++)assert.equal(detector.observe(ids.slice(page*20,page*20+20)).defer,false);
probe=detector.observe(ids.slice(80));assert.equal(probe.defer,true);assert.equal(probe.newRows,0);
assert.match(yieldNote(probe),/未认定穷尽/);
detector=new YieldWindow();
for(let page=0;page<10;page++)assert.equal(detector.observe(ids.map(id=>`${page}:${id}`)).defer,false);
detector=new YieldWindow(new Set(ids));
for(let page=0;page<10;page++)assert.equal(detector.observe([]).defer,false); // Empty/invalid pages aren't 100 valid records.
detector=new YieldWindow(new Set(ids),{enabled:false});
for(let page=0;page<10;page++)assert.equal(detector.observe(ids).defer,false);
detector=new YieldWindow(new Set(ids));
for(let page=0;page<4;page++)detector.observe(ids.slice(0,20));
assert.equal(detector.observe([...ids.slice(0,19),'fresh']).defer,false);
const checkpoint=zhaopinCheckpoint({records:new Map([['one',{}]]),total:200,validResponse:true,lastPageIndex:5,lowYield:probe});
assert.equal(checkpoint.complete,false);assert.equal(checkpoint.low_yield.defer,true);
// A duplicate prefix can conceal a useful tail: defer then recover, never discard.
const sharedSeen=new Set(ids),exploration=new YieldWindow(sharedSeen);
const pages=[...Array.from({length:5},(_,i)=>ids.slice(i*20,i*20+20)),['late-new']];
let cursor=0;
for(;cursor<pages.length;cursor++)if(exploration.observe(pages[cursor]).defer){cursor++;break;}
assert.equal(sharedSeen.has('late-new'),false);
const recovery=new YieldWindow(sharedSeen,{enabled:false});
for(;cursor<pages.length;cursor++)assert.equal(recovery.observe(pages[cursor]).defer,false);
assert.equal(sharedSeen.has('late-new'),true);
console.log('PASS: low-yield valid-page window, fresh rows reset evidence, missing pages never trigger, opt-out, deferred checkpoint never marked exhausted');
