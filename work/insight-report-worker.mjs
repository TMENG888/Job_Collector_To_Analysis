import {parentPort,workerData} from 'node:worker_threads';
import fs from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
try{
  const report=JSON.parse(await fs.readFile(workerData.filename,'utf8'));
  const raw=new TextEncoder().encode(JSON.stringify(report));
  const gzip=Uint8Array.from(gzipSync(raw));
  parentPort.postMessage({raw,gzip},[raw.buffer,gzip.buffer]);
}catch(error){parentPort.postMessage({error:error.message});}
