import assert from 'node:assert/strict';
import {canDeliverPartial,deliverPartial} from './partial_delivery.mjs';
for(const stage of ['public','zhaopin','boss','yupao'])for(const code of [1,44])assert.equal(canDeliverPartial({stage,code}),true);
assert.equal(canDeliverPartial({stage:'public',code:3221225477}),false);
for(const cause of [{stage:'workbook',code:1},{stage:'finalize',code:44},{stage:'yupao',code:42},{stage:'public',code:43},{stage:'boss',code:44,userPaused:true},{stage:'public',code:1,signal:'SIGTERM'},{stage:'boss',code:null},{stage:'boss',code:0},{stage:'boss',code:-1073741819}])assert.equal(canDeliverPartial(cause),false);
const cause={stage:'yupao',code:44};
let calls=[];
assert.deepEqual(await deliverPartial({cause,count:async()=>12875,run:async stage=>{calls.push(stage);return {code:0};},finish:async({available})=>calls.push(available)}),{delivered:true,available:12875});
assert.deepEqual(calls,['finalize','workbook',12875]);
calls=[];
assert.equal((await deliverPartial({cause,count:async()=>0,run:async()=>calls.push('bad'),finish:async()=>calls.push('bad')})).skipped,true);
assert.deepEqual(calls,[]);
await assert.rejects(deliverPartial({cause,count:async()=>{throw Error('ownership mismatch');},run:async()=>calls.push('bad'),finish:async()=>calls.push('bad')}),/ownership mismatch/);
assert.deepEqual(calls,[]);
for(const failStage of ['finalize','workbook']){
  calls=[];
  await assert.rejects(deliverPartial({cause,count:async()=>10,run:async stage=>{calls.push(stage);return stage===failStage?{paused:true,code:42}:{code:0};},finish:async()=>calls.push('bad')}),/未完成/);
  assert.deepEqual(calls,failStage==='finalize'?['finalize']:['finalize','workbook']);
}
console.log('PASS partial delivery: collection errors, same-task gate, ordered export, user pause, storage/resource protection, no recursive export');
