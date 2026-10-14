import fs from 'node:fs/promises';
import path from 'node:path';

export async function assistantSessionDirectory(dataDir){
  if(process.env.JOB_ASSISTANT_SESSIONS_DIR)return path.resolve(process.env.JOB_ASSISTANT_SESSIONS_DIR);
  let config;try{config=JSON.parse(await fs.readFile(path.join(dataDir,'assistant_private','storage.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw new Error('助手存储配置无法读取');}
  if(config?.sessionDirectory){if(!path.isAbsolute(config.sessionDirectory))throw new Error('助手历史目录必须是绝对路径');return path.resolve(config.sessionDirectory);}
  return path.join(dataDir,'assistant_private','sessions');
}
