import fs from 'node:fs';
import path from 'node:path';

export function knowledgeDatabasePath(dataDir){
  // Per-data-directory config keeps isolated tests isolated. Never fall back to
  // creating an empty old database when an explicitly configured disk is absent.
  const file=path.join(dataDir,'knowledge-storage.json');
  let config;
  try{config=JSON.parse(fs.readFileSync(file,'utf8'));}
  catch(error){if(error.code!=='ENOENT')throw new Error('知识库存储配置不可读取，请恢复配置；不会创建替代空库');}
  if(config){
    if(typeof config.database!=='string'||!path.isAbsolute(config.database))throw new Error('知识库路径必须是绝对路径');
    if(!fs.existsSync(config.database))throw new Error('已配置的知识库不可用，请检查数据盘；不会创建替代空库');
    return path.resolve(config.database);
  }
  return path.join(dataDir,'knowledge','岗位知识库.sqlite');
}

export function storageError(error){
  if(/database or disk is full|SQLITE_FULL|ENOSPC/i.test(String(error?.message||error)))return new Error('数据盘空间不足，无法同步或保存分析；已有数据保留，请检查知识库及临时文件所在磁盘');
  return error;
}
