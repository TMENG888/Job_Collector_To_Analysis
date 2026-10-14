import {answerJobDecision,generateGroundedAdvice,modelAvailability} from './job_decision_assistant.mjs';
import {cohortConditionValue} from '../job_collector_ui/public/insight-cohorts.js';
import {createChatAgent} from './job_assistant_chat.mjs';
import {extractResumeAttachment} from './job_assistant_resume.mjs';
import {resumeMessage} from './job_assistant_resume.mjs';
import {isCollectionRequest,collectionOnlyIndex} from './job_assistant_collection.mjs';
function json(res,status,value){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value));}
export function createAssistantHandler(store,credentials=null,chatOptions={}){
  let active=0;
  const chat=createChatAgent({getModel:()=>credentials?credentials.load():Promise.resolve(process.env),...chatOptions});
  return async(req,res,pathname)=>{
    if(!['/api/assistant/context','/api/assistant/ask','/api/assistant/model','/api/assistant/chat','/api/assistant/action','/api/assistant/reset','/api/assistant/attachment','/api/assistant/sessions','/api/assistant/session'].includes(pathname))return false;
    try{
      // Reject browser requests from unrelated origins, including on the main console.
      const origin=req.headers.origin;
      if(origin){let url;try{url=new URL(origin);}catch{}if(!url||url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname)||!['8788','8765','8791',String(req.headers.host||'').split(':').pop()].includes(url.port)){json(res,403,{error:'仅允许本机控制台访问'});return true;}}
      if(req.method==='GET'&&pathname.endsWith('/model')){json(res,200,credentials?await credentials.status():modelAvailability());return true;}
      if(req.method==='GET'&&pathname.endsWith('/sessions')){json(res,200,{sessions:await chat.list(),persistent:!!chatOptions.repository,collection_flow_version:2});return true;}
      if(req.method==='GET'&&pathname.endsWith('/context')){
        let index;try{index=await store.load();}catch(error){if(!chatOptions.collectionControl)throw error;index=collectionOnlyIndex;}
        const options=Object.fromEntries(['city','experience','education','employment_type'].map(field=>[field,[...new Set(index.jobs.map(j=>cohortConditionValue(j,field)))].sort((a,b)=>a.localeCompare(b,'zh-CN'))]));
        json(res,200,{role:index.report.role,generated_at:index.report.generated_at,indexed_jobs:index.jobs.length,
          verified_sources:index.jobs.filter(j=>j.source_verified).length,roles:index.report.roles||[index.report.role],knowledge:!!index.report.knowledge,revision:index.report.revision,candidate_rows:index.report.candidate_rows,options,model:credentials?await credentials.status():modelAvailability(),
          collection_control:!!chatOptions.collectionControl,retrieval:'多轮系统工具Agent；岗位工具只读，采集写操作需确认；未配置模型时使用本地规则模式',privacy:'历史会话本机加密保存；简历原文仅存内存，闲置30分钟或重启后需重新提供。发送消息默认调用已配置模型，外发脱敏最近对话、技能与少量证据，不发送简历原文。'});return true;
      }
      if(req.method!=='POST'||!['/api/assistant/ask','/api/assistant/model','/api/assistant/chat','/api/assistant/action','/api/assistant/reset','/api/assistant/attachment','/api/assistant/session'].includes(pathname)){json(res,405,{error:'请求方法不支持'});return true;}
      if(!String(req.headers['content-type']||'').startsWith('application/json')){json(res,415,{error:'仅接受JSON'});return true;}
      if(active>=3){json(res,429,{error:'助手繁忙，请稍后重试'});return true;}
      const limit=pathname.endsWith('/attachment')?4500000:200000;
      const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>limit)throw new Error('请求体过大');chunks.push(chunk);}
      let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('请求JSON格式不正确');}
      if(!body||typeof body!=='object'||Array.isArray(body))throw new Error('请输入JSON对象');
      if(pathname.endsWith('/session')){
        const result=body.action==='read'?await chat.view(body.id):body.action==='rename'?await chat.rename(body.id,body.title):body.action==='delete'?await chat.remove(body.id):body.action==='restore'?await chat.restore(body.id):null;
        if(!result)throw new Error('不支持的会话操作');json(res,200,result);return true;
      }
      if(pathname.endsWith('/reset')){json(res,200,chat.reset(body.conversationId));return true;}
      if(pathname.endsWith('/model')){
        if(!credentials){json(res,503,{error:'此服务不支持本机密钥保存，请启动新版助手服务'});return true;}
        try{json(res,200,await credentials.save(body));}catch{json(res,400,{error:'模型配置保存失败，请检查供应商、模型ID和新密钥；需要当前Windows账户支持DPAPI。'});}return true;
      }
      active++;
      try{
        if(pathname.endsWith('/attachment')){json(res,200,await extractResumeAttachment(body));return true;}
        if(pathname.endsWith('/action')){json(res,200,await chat.action(body));return true;}
        const collection=chatOptions.collectionControl&&pathname.endsWith('/chat')&&body.resume==null&&resumeMessage(String(body.message||''))===null&&isCollectionRequest(body.message);
        const index=collection?collectionOnlyIndex:await store.load();
        if(pathname.endsWith('/chat')){
          const controller=new AbortController(),cancel=()=>controller.abort();res.once('close',cancel);
          try{const turn=await chat.run(index,body,controller.signal);if(!res.destroyed)json(res,200,turn);}finally{res.off('close',cancel);}return true;
        }
        const result=answerJobDecision(index,body);
        if(body.useModel===true&&result.status==='ready'){
          try{result.advice=await generateGroundedAdvice(result,String(body.question||''),credentials?await credentials.load():process.env);}
          catch{result.model_warning='AI建议生成失败或引用无效；已保留本地统计与证据。请检查本机模型配置后重试。';}
        }
        json(res,200,result);
      }finally{active--;}
    }catch(error){json(res,400,{error:error.code==='ENOENT'?'尚无岗位洞察报告，请先生成分析':String(error.message||'请求失败').slice(0,300)});}
    return true;
  };
}
