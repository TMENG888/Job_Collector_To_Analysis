import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {brotliCompressSync,brotliDecompressSync,constants} from 'node:zlib';
import {windowsProtect} from './job_assistant_credentials.mjs';
import {writeJsonAtomic} from './collector_storage.mjs';

export const validSessionId=id=>typeof id==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id);
export function createAssistantSessionStore(directory,{protect=windowsProtect,now=Date.now}={}){
  let keyPromise;
  async function key(){
    keyPromise??=(async()=>{
      await fs.mkdir(directory,{recursive:true});const file=path.join(directory,'key.json');
      let encrypted;
      try{encrypted=JSON.parse(await fs.readFile(file,'utf8')).encrypted;}
      catch(error){if(error.code!=='ENOENT')throw error;const generated=randomBytes(32).toString('base64');const wrapped=await protect('encrypt',generated);
        try{await fs.writeFile(file,JSON.stringify({version:1,encrypted:wrapped}),{flag:'wx',mode:0o600});encrypted=wrapped;}
        catch(error){if(error.code!=='EEXIST')throw error;encrypted=JSON.parse(await fs.readFile(file,'utf8')).encrypted;}
      }
      const bytes=Buffer.from(await protect('decrypt',encrypted),'base64');if(bytes.length!==32)throw new Error('会话加密密钥无效');return bytes;
    })();
    try{return await keyPromise;}catch{keyPromise=undefined;throw new Error('本机会话加密不可用，请检查当前 Windows 账户权限');}
  }
  function fileFor(id){if(!validSessionId(id))throw new Error('会话编号无效');return path.join(directory,id+'.json');}
  async function read(id){
    const file=fileFor(id);let value;try{value=JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw new Error('会话文件无法读取，原文件已保留');}
    try{const decipher=createDecipheriv('aes-256-gcm',await key(),Buffer.from(value.iv,'base64'));decipher.setAuthTag(Buffer.from(value.tag,'base64'));
      const plain=Buffer.concat([decipher.update(Buffer.from(value.data,'base64')),decipher.final()]);
      const record=JSON.parse((value.compression==='brotli'?brotliDecompressSync(plain,{maxOutputLength:20*1024*1024}):plain).toString('utf8'));
      if(record.id!==id||!Array.isArray(record.turns))throw new Error('Invalid record');return record;
    }catch{throw new Error('会话无法解密或校验失败，原文件已保留');}
  }
  async function write(record){
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',await key(),iv);
    const plain=brotliCompressSync(Buffer.from(JSON.stringify(record)),{params:{[constants.BROTLI_PARAM_QUALITY]:4}});
    const data=Buffer.concat([cipher.update(plain),cipher.final()]);
    await writeJsonAtomic(fileFor(record.id),{version:2,compression:'brotli',iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')});
  }
  // A filesystem lease also isolates the main server from the compatibility service.
  async function withLock(id,fn){
    fileFor(id);await fs.mkdir(directory,{recursive:true});const lock=path.join(directory,id+'.lock');let handle;
    try{handle=await fs.open(lock,'wx');}catch(error){
      if(error.code!=='EEXIST')throw error;
      const stat=await fs.stat(lock).catch(()=>null);
      if(stat&&now()-stat.mtimeMs>5*60*1000){await fs.unlink(lock).catch(()=>{});try{handle=await fs.open(lock,'wx');}catch{}}
      if(!handle)throw new Error('该会话正在处理，请等待回答完成后再操作');
    }
    try{return await fn();}finally{await handle.close();await fs.unlink(lock).catch(()=>{});}
  }
  const metadata=record=>({id:record.id,title:record.title,created:record.created,updated:record.updated,turn_count:record.turns.length});
  return {read,write,withLock,metadata,
    async list(){
      let files;try{files=await fs.readdir(directory);}catch(error){if(error.code==='ENOENT')return [];throw error;}
      const rows=[];for(const file of files){const id=file.replace(/\.json$/,'');if(!validSessionId(id))continue;const record=await read(id);if(record)rows.push(metadata(record));}
      return rows.sort((a,b)=>b.updated-a.updated);
    },
    async rename(id,title){
      const name=String(title||'').trim();if(!name||name.length>80)throw new Error('会话名称需为1–80字');
      return withLock(id,async()=>{const record=await read(id);if(!record)throw new Error('会话不存在');record.title=name;await write(record);return metadata(record);});
    },
    async remove(id){return withLock(id,async()=>{await fs.rename(fileFor(id),path.join(directory,id+'.deleted.json')).catch(error=>{if(error.code!=='ENOENT')throw error;});return {deleted:true};});},
    async restore(id){return withLock(id,async()=>{const target=fileFor(id);if(await fs.stat(target).catch(()=>null))throw new Error('会话已恢复');await fs.rename(path.join(directory,id+'.deleted.json'),target);return metadata(await read(id));});},
  };
}
