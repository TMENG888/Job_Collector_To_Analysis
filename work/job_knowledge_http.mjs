import {knowledgeStore} from './job_knowledge_store.mjs';
export function createKnowledgeHandler(dataDir){
  const store=knowledgeStore(dataDir);
  return async(req,res,pathname)=>{
    const match=pathname.match(/^\/api\/knowledge\/tasks\/([^/]+)\/source$/);
    const termRoute=pathname==='/api/knowledge/skill-terms'||pathname.startsWith('/api/knowledge/skill-terms/');
    if(!['/api/knowledge/status','/api/knowledge/datasets'].includes(pathname)&&!match&&!termRoute)return false;
    const json=(code,data)=>{res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data));};
    try{
      if(termRoute){json(410,{error:'新技术词候选审核模块已移除',code:'FEATURE_REMOVED'});return true;}
      if(req.headers.origin){const url=new URL(req.headers.origin);if(url.protocol!=='http:'||!['localhost','127.0.0.1'].includes(url.hostname))throw new Error('仅允许本机控制台');}
      if(req.method!=='GET'){json(405,{error:'仅支持GET'});return true;}
      if(pathname.endsWith('/status'))json(200,await store.status({synchronize:false}));
      else if(match){const dataset=(await store.catalog({synchronize:false})).find(d=>d.taskId===decodeURIComponent(match[1]));if(!dataset){json(404,{error:'此任务知识库暂没有有效数据'});return true;}json(200,{taskId:dataset.taskId,role:dataset.role,dataset});}
      else json(200,{catalog:'knowledge-v1',datasets:await store.catalog({synchronize:false})});
    }catch(error){json(400,{error:String(error.message).slice(0,300)});}return true;
  };
}
