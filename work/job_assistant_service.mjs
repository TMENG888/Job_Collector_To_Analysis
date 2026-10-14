import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createKnowledgeAssistantStore} from './job_decision_assistant.mjs';
import {createAssistantHandler} from './job_assistant_http.mjs';
import {createAssistantCredentialStore} from './job_assistant_credentials.mjs';
import {createKnowledgeHandler} from './job_knowledge_http.mjs';
import {createAssistantSessionStore} from './job_assistant_sessions.mjs';
import {assistantSessionDirectory} from './job_assistant_storage.mjs';
import {createCollectionControl} from './job_assistant_collection.mjs';
import {zhaopinCities} from './collection_cities.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const port=Number(process.env.JOB_ASSISTANT_PORT||8791);
const dataDir=process.env.JOB_UI_DATA_DIR?path.resolve(process.env.JOB_UI_DATA_DIR):path.join(root,'ui_data');
const handle=createAssistantHandler(createKnowledgeAssistantStore(dataDir),createAssistantCredentialStore(path.join(dataDir,'assistant_private','model.json')),{repository:createAssistantSessionStore(await assistantSessionDirectory(dataDir)),collectionControl:createCollectionControl({baseUrl:`http://127.0.0.1:${Number(process.env.JOB_UI_PORT||8788)}`,storageDir:dataDir,getCities:()=>Object.keys(zhaopinCities)})});
const handleKnowledge=createKnowledgeHandler(dataDir);
const allowed=new Set(['http://127.0.0.1:8788','http://127.0.0.1:8765','http://localhost:8788','http://localhost:8765',`http://127.0.0.1:${port}`,`http://localhost:${port}`]);
const server=http.createServer(async(req,res)=>{
  if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(req.headers.host)){res.writeHead(403);res.end();return;}
  const origin=req.headers.origin;
  if(origin&&!allowed.has(origin)){res.writeHead(403);res.end();return;}
  if(origin){res.setHeader('access-control-allow-origin',origin);res.setHeader('vary','Origin');}
  if(req.method==='OPTIONS'){
    res.writeHead(204,{'access-control-allow-methods':'GET, POST, OPTIONS','access-control-allow-headers':'content-type'});res.end();return;
  }
  try{const pathname=new URL(req.url,`http://127.0.0.1:${port}`).pathname;if(await handleKnowledge(req,res,pathname)||await handle(req,res,pathname))return;res.writeHead(404);res.end();}
  catch{res.writeHead(500);res.end('服务暂不可用');}
});
server.listen(port,'127.0.0.1',()=>console.log(`求职助手多会话服务：http://127.0.0.1:${port}（历史本机加密保存，简历原文仅存内存）`));
server.on('error',error=>{console.error(error.code==='EADDRINUSE'?'助手端口已被占用':error.message);process.exitCode=1;});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close(()=>process.exit(0)));
