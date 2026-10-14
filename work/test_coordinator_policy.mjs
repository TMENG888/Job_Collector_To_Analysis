import assert from 'node:assert/strict';
import {isCollectionStage,shouldStopAtTarget} from './coordinator_policy.mjs';
for(const stage of ['public','zhaopin','boss','yupao']) {
  assert.ok(isCollectionStage(stage));
  assert.equal(shouldStopAtTarget({stage,status:'running',valid:19999,target:20000}),false);
  assert.equal(shouldStopAtTarget({stage,status:'running',valid:20000,target:20000}),true);
  assert.equal(shouldStopAtTarget({stage,status:'stopping',valid:20000,target:20000}),false);
}
for(const stage of ['finalize','workbook']) {
  assert.equal(isCollectionStage(stage),false);
  assert.equal(shouldStopAtTarget({stage,status:'running',valid:20000,target:20000}),false,'export must finish, never be stopped by collection threshold');
}
console.log('PASS: collection stops at target; finalize and workbook always finish');
