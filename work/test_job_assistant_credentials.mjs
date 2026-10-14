import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createAssistantCredentialStore,windowsProtect} from './job_assistant_credentials.mjs';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-credentials-test-'));
const filename=path.join(dir,'model.json'),fakeKey='test-only-not-a-real-api-key';
try{
  const store=createAssistantCredentialStore(filename);
  assert.equal((await store.status()).configured,false);
  await assert.rejects(store.save({provider:'other',model:'test',apiKey:fakeKey}));
  const metadata=await store.save({provider:'deepseek',model:'deepseek-flash',apiKey:fakeKey});
  assert.equal(metadata.configured,true);assert.equal(metadata.provider,'DeepSeek');
  assert.ok(!JSON.stringify(metadata).includes(fakeKey));assert.ok(!JSON.stringify(metadata).includes('encrypted_key'));
  const raw=await fs.readFile(filename,'utf8');assert.ok(!raw.includes(fakeKey));
  assert.equal((await store.load()).JOB_ASSISTANT_API_KEY,fakeKey);
  await store.save({provider:'qwen',model:'test',apiKey:fakeKey});
  assert.equal((await store.status()).provider_id,'qwen');
  assert.throws(()=>windowsProtect('bad',fakeKey));
  console.log('PASS: actual Windows DPAPI roundtrip, atomic credential replacement, no plaintext on disk or metadata, provider validation');
}finally{await fs.unlink(filename).catch(()=>{});await fs.rmdir(dir);}
