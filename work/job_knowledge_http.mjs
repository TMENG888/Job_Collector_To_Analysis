import {knowledgeStore} from './job_knowledge_store.mjs';
import {createQualityService} from './job_data_quality_service.mjs';
import {createSourceDataService} from './job_source_data.mjs';
import {createJobProcessingService} from './job_processing.mjs';
export function createKnowledgeHandler(dataDir){
  const store=knowledgeStore(dataDir);
  const quality=createQualityService({database:store.filename});
  const sources=createSourceDataService(dataDir);
  const processing=createJobProcessingService(dataDir,{database:store.filename});
  return async(req,res,pathname)=>{
    const match=pathname.match(/^\/api\/knowledge\/tasks\/([^/]+)\/source$/);
    const termRoute=pathname==='/api/knowledge/skill-terms'||pathname.startsWith('/api/knowledge/skill-terms/');
    const qualityRoute=['/api/knowledge/quality','/api/knowledge/quality/history','/api/knowledge/quality/state'].includes(pathname);
    const sourceRoute=['/api/knowledge/source-data','/api/knowledge/source-data/detail'].includes(pathname);
    const processingRoute=['/api/knowledge/processing','/api/knowledge/processing/detail','/api/knowledge/processing/run','/api/knowledge/processing/status','/api/knowledge/processing/transfer'].includes(pathname);
    if(!['/api/knowledge/status','/api/knowledge/datasets'].includes(pathname)&&!match&&!termRoute&&!qualityRoute&&!sourceRoute&&!processingRoute)return false;
    const json=(code,data)=>{res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data));};
    try{
      if(termRoute){json(410,{error:'新技术词候选审核模块已移除',code:'FEATURE_REMOVED'});return true;}
      if(req.headers.origin){const url=new URL(req.headers.origin);if(url.protocol!=='http:'||!['localhost','127.0.0.1'].includes(url.hostname))throw new Error('仅允许本机控制台');}
      if(processingRoute){
        if(pathname.endsWith('/run')||pathname.endsWith('/transfer')){
          if(req.method!=='POST'){json(405,{error:'仅支持POST'});return true;}
          if(req.headers['sec-fetch-site']==='cross-site'||!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))throw Error('请从本机控制台执行清洗');
          let body='';for await(const chunk of req){body+=chunk;if(body.length>8192)throw Error('清洗请求过大');}
          const input=JSON.parse(body||'{}');json(pathname.endsWith('/run')?202:200,pathname.endsWith('/run')?{run:processing.start(input)}:processing.transfer(input));
        }else{
          if(req.method!=='GET'){json(405,{error:'仅支持GET'});return true;}
          const input=Object.fromEntries(new URL(req.url,'http://localhost').searchParams);
          json(200,pathname.endsWith('/status')?{run:await processing.status()}:pathname.endsWith('/detail')?await processing.detail(input):await processing.list(input));
        }return true;
      }
      if(sourceRoute){
        if(req.method!=='GET'){json(405,{error:'仅支持GET'});return true;}
        const input=Object.fromEntries(new URL(req.url,'http://localhost').searchParams);
        json(200,pathname.endsWith('/detail')?await sources.detail(input):await sources.list(input));return true;
      }
      if(qualityRoute){
        if(pathname.endsWith('/state')){
          if(req.method!=='POST'){json(405,{error:'仅支持POST'});return true;}
          let body='';for await(const chunk of req){body+=chunk;if(body.length>8192)throw Error('状态请求过大');}
          json(200,{state:await quality.mark(JSON.parse(body))});
        }else{
          if(req.method!=='GET'){json(405,{error:'仅支持GET'});return true;}
          await store.status({synchronize:false});
          json(200,pathname.endsWith('/history')?{reports:await quality.history()}:await quality.report(Object.fromEntries(new URL(req.url,'http://localhost').searchParams)));
        }
        return true;
      }
      if(req.method!=='GET'){json(405,{error:'仅支持GET'});return true;}
      if(pathname.endsWith('/status'))json(200,await store.status({synchronize:false}));
      else if(match){const dataset=(await store.catalog({synchronize:false})).find(d=>d.taskId===decodeURIComponent(match[1]));if(!dataset){json(404,{error:'此任务知识库暂没有有效数据'});return true;}json(200,{taskId:dataset.taskId,role:dataset.role,dataset});}
      else json(200,{catalog:'knowledge-v1',datasets:await store.catalog({synchronize:false})});
    }catch(error){json(400,{error:String(error.message).slice(0,300)});}return true;
  };
}
