import {answerJobDecision,generateGroundedAdvice,modelAvailability} from './job_decision_assistant.mjs';
import {cohortConditionValue} from '../job_collector_ui/public/insight-cohorts.js';
import {createChatAgent} from './job_assistant_chat.mjs';
import {extractResumeAttachment} from './job_assistant_resume.mjs';
import {resumeMessage} from './job_assistant_resume.mjs';
import {collectionOnlyIndex} from './job_assistant_collection.mjs';
import {storageError} from './knowledge_storage.mjs';
import {isInterviewQuestion,interviewOnlyIndex} from './job_assistant_interviews.mjs';
import {requestBudget} from './assistant_request_budget.mjs';
function json(res,status,value){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value));}
export function createAssistantHandler(store,credentials=null,chatOptions={}){
  let active=0;
  const chat=createChatAgent({getModel:()=>credentials?credentials.load():Promise.resolve(process.env),...chatOptions});
  const interviewMetadata=async()=>{try{return chatOptions.interviewStore?await chatOptions.interviewStore.metadata():{posts:0,available:false};}catch{return {posts:0,available:false,warning:'面经目录读取失败，不代表空库'};}};
  const loadIndex=async(body,options={})=>{try{return await store.load(options);}catch(error){if(options.signal?.aborted)throw options.signal.reason;if(chatOptions.interviewStore&&isInterviewQuestion(body.message))return interviewOnlyIndex;throw error;}};
  return async(req,res,pathname)=>{
    if(!['/api/assistant/context','/api/assistant/ask','/api/assistant/model','/api/assistant/chat','/api/assistant/action','/api/assistant/reset','/api/assistant/attachment','/api/assistant/sessions','/api/assistant/session'].includes(pathname))return false;
    const budget=['/api/assistant/context','/api/assistant/ask','/api/assistant/chat'].includes(pathname)?requestBudget(res,chatOptions.requestTimeoutMs??180000):null;
    const wait=operation=>budget?budget.wait(operation):Promise.resolve().then(operation);
    try{
      // Reject browser requests from unrelated origins, including on the main console.
      const origin=req.headers.origin;
      if(origin){let url;try{url=new URL(origin);}catch{}if(!url||url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname)||!['8788','8765','8791',String(req.headers.host||'').split(':').pop()].includes(url.port)){json(res,403,{error:'仅允许本机控制台访问'});return true;}}
      if(req.method==='GET'&&pathname.endsWith('/model')){json(res,200,credentials?await credentials.status():modelAvailability());return true;}
      if(req.method==='GET'&&pathname.endsWith('/sessions')){json(res,200,{sessions:await chat.list(),persistent:!!chatOptions.repository,collection_flow_version:5});return true;}
      if(req.method==='GET'&&pathname.endsWith('/context')){
        // Opening a chat is not a request to classify/tokenize the entire KB.
        // Keep the full context contract for existing analytical consumers.
        if(new URL(req.url,'http://localhost').searchParams.get('summary')==='1'&&store.metadata){
          let meta;try{meta=await wait(()=>store.metadata());}catch(error){if(budget.signal.aborted)throw budget.signal.reason;if(!chatOptions.interviewStore)throw error;meta={revision:null,rows:0};}
          json(res,200,{assistant_flow_version:6,streaming:true,knowledge:true,revision:meta.revision,candidate_rows:meta.rows,index_deferred:true,interview_knowledge:await wait(interviewMetadata),collection_control:!!chatOptions.collectionControl,model:credentials?await wait(()=>credentials.status()):modelAvailability()});return true;
        }
        let index;try{index=await wait(()=>store.load({signal:budget.signal}));}catch(error){if(budget.signal.aborted)throw budget.signal.reason;if(chatOptions.interviewStore)index=interviewOnlyIndex;else if(chatOptions.collectionControl)index=collectionOnlyIndex;else throw error;}
        const options=Object.fromEntries(['city','experience','education','employment_type'].map(field=>[field,[...new Set(index.jobs.map(j=>cohortConditionValue(j,field)))].sort((a,b)=>a.localeCompare(b,'zh-CN'))]));
        json(res,200,{assistant_flow_version:6,streaming:true,features:['career_goal','salary_benchmark','job_details','clarification','multi_city_role','resumable_task','data_admission','scoped_tools','live_execution','flexible_query_scope','market_salary_scope','role_scope_edits','tool_failure_recovery','interview_retrieval'],interview_knowledge:await interviewMetadata(),data_quality:index.report.data_quality,role:index.report.role,generated_at:index.report.generated_at,indexed_jobs:index.jobs.length,
          verified_sources:index.jobs.filter(j=>j.source_verified).length,roles:index.report.roles||[index.report.role],knowledge:!!index.report.knowledge,revision:index.report.revision,candidate_rows:index.report.candidate_rows,options,model:credentials?await credentials.status():modelAvailability(),
          collection_control:!!chatOptions.collectionControl,retrieval:'JD与牛客面经双源只读检索；面试问题优先召回面经，题频按去重原文计算；采集写操作仍需确认',privacy:'历史会话本机加密保存；简历原文仅存内存，闲置30分钟或重启后需重新提供。发送消息默认调用已配置模型，外发脱敏最近对话、技能与少量JD/面经证据，不发送简历原文。'});return true;
      }
      if(req.method!=='POST'||!['/api/assistant/ask','/api/assistant/model','/api/assistant/chat','/api/assistant/action','/api/assistant/reset','/api/assistant/attachment','/api/assistant/session'].includes(pathname)){json(res,405,{error:'请求方法不支持'});return true;}
      if(!String(req.headers['content-type']||'').startsWith('application/json')){json(res,415,{error:'仅接受JSON'});return true;}
      if(active>=3){json(res,429,{error:'助手繁忙，请稍后重试'});return true;}
      const limit=pathname.endsWith('/attachment')?4500000:200000;
      const chunks=await wait(async()=>{const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>limit)throw new Error('请求体过大');chunks.push(chunk);}return chunks;});
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
        const collectionMode=()=>chatOptions.collectionControl&&pathname.endsWith('/chat')&&body.resume==null&&resumeMessage(String(body.message||''))===null?chat.isCollectionMessage(body.message,body.conversationId):false;
        if(pathname.endsWith('/chat')&&String(req.headers.accept||'').includes('text/event-stream')){
          res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache, no-transform','x-accel-buffering':'no'});res.flushHeaders();
          const emit=event=>{if(!res.destroyed&&!res.writableEnded)res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);};
          const heartbeat=setInterval(()=>{if(!res.destroyed&&!res.writableEnded)res.write(': heartbeat\n\n');},10000);heartbeat.unref();
          try{
            emit({type:'phase',phase:'routing',message:'已接收请求，正在核对会话与任务类型'});
            const collection=await wait(collectionMode);
            emit({type:'phase',phase:'loading',message:collection?'已接收请求，正在连接采集中心':isInterviewQuestion(body.message)?'正在连接岗位与面经证据库':'已接收请求，正在读取已入库的岗位证据'});
            const index=collection?collectionOnlyIndex:await wait(()=>loadIndex(body,{signal:budget.signal,onProgress:progress=>emit({type:'phase',...progress})}));
            const turn=await wait(()=>chat.run(index,body,budget.signal,emit));
            // Publish only the grounded/validated answer. Provider drafts and
            // private reasoning are never forwarded, even on failed citations.
            emit({type:'answer_start',message:'核验完成，正在呈现答复'});
            const letters=Array.from(turn.answer||'');
            for(let n=0;n<letters.length;n+=96){if(budget.signal.aborted)return true;emit({type:'answer_delta',text:letters.slice(n,n+96).join('')});}
            emit({type:'done',turn});
          }catch(error){emit({type:'error',message:String(storageError(error).message||'本轮未完成').slice(0,300)});}
          finally{clearInterval(heartbeat);if(!res.destroyed)res.end();}
          return true;
        }
        const collection=await wait(collectionMode);
        const index=collection?collectionOnlyIndex:await wait(()=>loadIndex(body,{signal:budget.signal}));
        if(pathname.endsWith('/chat')){
          const turn=await wait(()=>chat.run(index,body,budget.signal));if(!res.destroyed)json(res,200,turn);return true;
        }
        const result=answerJobDecision(index,body);
        if(body.useModel===true&&result.status==='ready'){
          try{result.advice=await wait(async()=>generateGroundedAdvice(result,String(body.question||''),credentials?await credentials.load():process.env,undefined,budget.signal));}
          catch{if(budget.signal.aborted)throw budget.signal.reason;result.model_warning='AI建议生成失败或引用无效；已保留本地统计与证据。请检查本机模型配置后重试。';}
        }
        json(res,200,result);
      }finally{active--;}
    }catch(error){if(!res.headersSent&&!res.destroyed)json(res,error.code==='ASSISTANT_REQUEST_TIMEOUT'?504:400,{error:error.code==='ENOENT'?'尚无岗位洞察报告，请先生成分析':String(storageError(error).message||'请求失败').slice(0,300)});else if(!res.destroyed)res.end();}
    finally{budget?.dispose();}
    return true;
  };
}
