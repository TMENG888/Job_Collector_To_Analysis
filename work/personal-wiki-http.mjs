import path from 'node:path';
import {personalWiki} from './personal-wiki.mjs';
import {createRecruiterModel} from './job-recruiter-model.mjs';
import {tailorFromWiki} from './personal-wiki-tailor.mjs';
import {needsWikiOrganization} from './personal-wiki-agent.mjs';

export function createPersonalWikiHandler(dataDir,{wiki=personalWiki(dataDir),model=createRecruiterModel({dataDir,runtimeDir:path.join(wiki.directory,'model')})}={}){
  let agentTask=null,agentController=null;
  const json=(res,code,data)=>{res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(data));};
  return async(req,res,pathname)=>{
    if(!pathname.startsWith('/api/personal-wiki/'))return false;
    try{
      const origin='http://'+req.headers.host,host=new URL(origin);
      if(!['127.0.0.1','localhost'].includes(host.hostname)||req.headers['sec-fetch-site']==='cross-site'||req.headers.origin&&req.headers.origin!==origin)throw Error('个人资料仅允许当前本机工作台访问');
      const route=pathname.slice('/api/personal-wiki/'.length),url=new URL(req.url,origin);
      if(req.method==='GET'){
        if(route==='state')json(res,200,{...await wiki.state(),agentBusy:!!agentTask});
        else if(route==='source')json(res,200,await wiki.source(url.searchParams.get('id')));
        else if(route==='preview')json(res,200,await wiki.previewResume(url.searchParams.get('id')));
        else if(route==='model')json(res,200,await model.status());
        else json(res,404,{error:'个人资料接口不存在'});return true;
      }
      if(req.method!=='POST'||!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))throw Error('请使用本机JSON操作');
      let length=0,chunks=[];for await(const chunk of req){length+=chunk.length;if(length>4300000)throw Error('材料超过请求上限');chunks.push(chunk);}
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!body||typeof body!=='object'||Array.isArray(body))throw Error('参数无效');
      let result;
      if(route==='import')result=await wiki.importFile(body);
      else if(route==='github')result=await wiki.importGitHub(body);
      else if(route==='review')result=await wiki.reviewSource(body);
      else if(route==='transcribe')result=await wiki.transcribe(body);
      else if(route==='approve')result=await wiki.approveResume(body);
      else if(route==='revoke')result=await wiki.revokeResume(body.id);
      else if(route==='archive')result=await wiki.archiveSource(body.id);
      else if(route==='delete')result=await wiki.deleteSource(body);
      else if(route==='restore')result=await wiki.restoreSource(body);
      else if(route==='cancel'){agentController?.abort();result={stopping:!!agentTask};}
      else if(['organize','tailor'].includes(route)){
        if(body.shareConfirmed!==true)throw Error('请先同意由DeepSeek处理脱敏个人资料和JD');
        const limit=Number(body.budget??.5);if(!Number.isFinite(limit)||limit<.05||limit>2)throw Error('预算需为0.05–2元');
        const options={budget:{limit,spent:0},maxTokens:3200};
        if(route==='organize'){
          if(agentTask)throw Error('Wiki整理智能体已在运行');
          const snapshot=await wiki.state();
          if(agentTask)throw Error('Wiki整理智能体已在运行');
          if(body.sourceIds&&(!Array.isArray(body.sourceIds)||body.sourceIds.length<1||body.sourceIds.length>3||body.sourceIds.some(id=>typeof id!=='string'||!snapshot.sources.some(s=>s.id===id))))throw Error('材料选择无效，每轮最多3份');
          if(!snapshot.sources.some(s=>(!body.sourceIds||body.sourceIds.includes(s.id))&&(body.force===true||needsWikiOrganization(s)))){json(res,200,{started:false,message:'没有待整理材料；可在材料详情选择重新整理'});return true;}
          agentController=new AbortController();
          agentTask=wiki.annotate({request:model.request,...options,signal:agentController.signal,sourceIds:body.sourceIds,force:body.force===true}).catch(()=>{}).finally(()=>{agentTask=null;agentController=null;});
          result={started:true,message:'智能体已启动，每轮最多3份材料；失败或停止不发布部分候选'};
        }else result=await tailorFromWiki({wiki,job:body.job,request:model.request,options});
      }else{json(res,404,{error:'个人资料接口不存在'});return true;}
      json(res,200,result);
    }catch(error){json(res,400,{error:String(error.message).replace(/sk-[\w.\-]+/g,'[隐藏]').slice(0,400)});}return true;
  };
}
