import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {serialize,deserialize} from 'node:v8';
import {assistantClassificationVersion} from './assistant_classification_cache.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function version(){
  const hash=createHash('sha256').update(assistantClassificationVersion());
  for(const name of ['job_decision_assistant.mjs','job_data_admission.mjs','job_salary_parser.mjs','resume_job_fit.mjs'])hash.update(fsSync.readFileSync(new URL(name,import.meta.url)));
  return hash.digest('hex');
}
export async function readAssistantIndexSnapshot(directory,revision,scope){
  try{
    const bytes=await fs.readFile(path.join(directory,'index.snapshot'));
    if(bytes.length<65||bytes.subarray(0,64).toString('ascii')!==digest(bytes.subarray(64)))return null;
    const saved=deserialize(bytes.subarray(64));
    if(saved.scope!==scope||saved.version!==version()||saved.revision!==revision||saved.index.report.revision!==revision||!(saved.index.tokenSets instanceof Map)||!(saved.index.frequencies instanceof Map))return null;
    return {...saved.index,indexCache:'disk',indexBuild:{reused:saved.index.report.candidate_rows,classified:0,total:saved.index.report.candidate_rows}};
  }catch(error){if(['EACCES','EPERM'].includes(error.code))throw Error('岗位检索缓存不可读取，请检查 E 盘目录权限');return null;}
}
export async function saveAssistantIndexSnapshot(directory,index,scope){
  const payload=serialize({version:version(),scope,revision:index.report.revision,index});
  await fs.mkdir(directory,{recursive:true});
  const target=path.join(directory,'index.snapshot'),temporary=target+'.'+randomUUID()+'.tmp';
  try{await fs.writeFile(temporary,Buffer.concat([Buffer.from(digest(payload),'ascii'),payload]),{flag:'wx',mode:0o600});await fs.rename(temporary,target);}
  finally{await fs.unlink(temporary).catch(()=>{});}
}
