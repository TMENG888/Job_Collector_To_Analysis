import {knowledgeStore} from './job_knowledge_store.mjs';
import {createTermDiscovery} from './skill_term_discovery.mjs';
export function createKnowledgeHandler(dataDir){
  const store=knowledgeStore(dataDir);
  const discovery=createTermDiscovery(store);
  return async(req,res,pathname)=>{
    const match=pathname.match(/^\/api\/knowledge\/tasks\/([^/]+)\/source$/);
    const termRoute=pathname==='/api/knowledge/skill-terms'||pathname.startsWith('/api/knowledge/skill-terms/');
    if(!['/api/knowledge/status','/api/knowledge/datasets'].includes(pathname)&&!match&&!termRoute)return false;
    const json=(code,data)=>{res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data));};
    try{
      if(termRoute){
        const host=new URL(`http://${req.headers.host}`);
        if(!['localhost','127.0.0.1'].includes(host.hostname)||req.headers['sec-fetch-site']==='cross-site')throw new Error('仅允许本机控制台');
        if(req.headers.origin&&req.headers.origin!==host.origin)throw new Error('请求来源与控制台不一致');
        if(req.method==='GET'){
          if(pathname.endsWith('/status'))json(200,await discovery.status());
          else if(pathname==='/api/knowledge/skill-terms'){
            const query=new URL(req.url,host.origin).searchParams;
            json(200,await store.termReview.list({state:query.get('state')||'pending',limit:Number(query.get('limit')||50),offset:Number(query.get('offset')||0),taskId:query.get('taskId')||'',synchronize:false}));
          }else json(404,{error:'接口不存在'});
        }else if(req.method==='POST'){
          if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))throw new Error('请使用JSON请求');
          const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>4096)throw new Error('请求过大');chunks.push(chunk);}
          const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('无效参数');
          if(pathname.endsWith('/scan')){
            if(Object.keys(input).some(k=>!['limit','taskId'].includes(k))||input.taskId!==undefined&&(typeof input.taskId!=='string'||input.taskId.length>200))throw new Error('不支持的扫描参数');
            json(202,await discovery.start(input));
          }else if(pathname.endsWith('/review')){
            if(Object.keys(input).some(k=>!['id','decision'].includes(k))||typeof input.id!=='string'||!/^[a-f0-9]{64}$/.test(input.id))throw new Error('无效候选ID');
            json(200,await store.termReview.review(input.id,input.decision));
          }else json(404,{error:'接口不存在'});
        }else json(405,{error:'仅支持GET/POST'});
        return true;
      }
      if(req.headers.origin){const url=new URL(req.headers.origin);if(url.protocol!=='http:'||!['localhost','127.0.0.1'].includes(url.hostname))throw new Error('仅允许本机控制台');}
      if(req.method!=='GET'){json(405,{error:'仅支持GET'});return true;}
      if(pathname.endsWith('/status'))json(200,await store.status({synchronize:false}));
      else if(match){const dataset=(await store.catalog({synchronize:false})).find(d=>d.taskId===decodeURIComponent(match[1]));if(!dataset){json(404,{error:'此任务知识库暂没有有效数据'});return true;}json(200,{taskId:dataset.taskId,role:dataset.role,dataset});}
      else json(200,{catalog:'knowledge-v1',datasets:await store.catalog({synchronize:false})});
    }catch(error){json(400,{error:String(error.message).slice(0,300)});}return true;
  };
}
