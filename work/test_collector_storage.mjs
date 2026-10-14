import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {renameWithSharingRetry,writeAtomic} from './collector_storage.mjs';
let calls=0;const delays=[];
await renameWithSharingRetry('source','destination',{
  rename:async()=>{if(++calls<3)throw Object.assign(new Error('sharing'),{code:'EPERM'});},
  sleep:async ms=>delays.push(ms),
});
assert.equal(calls,3);assert.deepEqual(delays,[100,250]);
calls=0;
await assert.rejects(renameWithSharingRetry('source','destination',{
  rename:async()=>{calls++;throw Object.assign(new Error('locked'),{code:'EBUSY'});},sleep:async()=>{},
}),{code:'EBUSY'});
assert.equal(calls,4);
calls=0;
await assert.rejects(renameWithSharingRetry('source','destination',{
  rename:async()=>{calls++;throw Object.assign(new Error('permissions'),{code:'EACCES'});},sleep:async()=>{},
}),{code:'EACCES'});
assert.equal(calls,1);
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'collector-storage-test-'));
const file=path.join(directory,'output.txt');
await writeAtomic(file,'old');
await Promise.all([writeAtomic(file,'first'),writeAtomic(file,'last')]);
assert.equal(await fs.readFile(file,'utf8'),'last');
assert.deepEqual(await fs.readdir(directory),['output.txt']);
// Remove only the explicit files created by this isolated test.
await fs.unlink(file);await fs.rmdir(directory);
console.log('PASS: transient sharing retry, bounded persistent lock, no permission retry, ordered atomic writes');
