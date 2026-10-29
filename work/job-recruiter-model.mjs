import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createAssistantCredentialStore,assistantProviders} from './job_assistant_credentials.mjs';
import {writeJsonAtomic} from './collector_storage.mjs';

// These are budgeting assumptions, NOT a provider tariff or billing receipt.
export const recruiterPrices=Object.freeze({input:4,output:8,basis:'预算假设：输入4、输出8元/百万Token；非官方报价、非账单，未计缓存折扣'});
export function parseRecruiterJson(content){
  if(typeof content!=='string')throw Error('DeepSeek返回内容不是文本；用量已记录');
  const trimmed=content.trim(),fence=trimmed.match(/^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i);
  let parsed;try{parsed=JSON.parse(fence?fence[1]:trimmed);}catch{throw Error('DeepSeek返回非JSON；用量已记录，未重试');}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('DeepSeek输出结构无效；用量已记录');
  return parsed;
}
export function createRecruiterModel({dataDir,runtimeDir,credentials=createAssistantCredentialStore(path.join(dataDir,'assistant_private/model.json')),fetcher=fetch}={}){
  const file=path.join(runtimeDir,'deepseek-usage.json');let busy=false,controller=null;
  async function usage(){
    try{const value=JSON.parse(await fs.readFile(file,'utf8'));if(![value.requests,value.input,value.output,value.estimate,value.unknown].every(n=>Number.isFinite(n)&&n>=0))throw Error();return value;}
    catch(e){if(e.code==='ENOENT')return {requests:0,input:0,output:0,estimate:0,unknown:0,inFlight:false};throw Error('DeepSeek用量账本不可读取，停止请求');}
  }
  async function status(){const meta=await credentials.status();return {configured:meta.configured&&meta.provider_id==='deepseek',provider:'DeepSeek',model:meta.model,prices:recruiterPrices,busy,usage:await usage()};}
  async function request(prompt,data,{signal,budget,maxTokens=2200}={}){
    if(busy)throw Error('已有DeepSeek请求进行中');busy=true;const local=new AbortController();controller=local;
    try{
      signal?.throwIfAborted();local.signal.throwIfAborted();
      const config=await credentials.load();
      if(config.JOB_ASSISTANT_PROVIDER!=='deepseek'||!config.JOB_ASSISTANT_API_KEY||!config.JOB_ASSISTANT_MODEL)throw Error('请先在求职助手配置DeepSeek；不会改用Qwen标注密钥');
      const content=JSON.stringify(data),reserve=((Buffer.byteLength(content+prompt,'utf8')+1024)*recruiterPrices.input+maxTokens*recruiterPrices.output)/1e6;
      if(budget&&budget.spent+reserve>budget.limit)throw Error('预算不足以覆盖下一个请求的保守估算，未发起请求');
      signal?.throwIfAborted();local.signal.throwIfAborted();
      const log=await usage();if(log.inFlight)log.unknown++;log.inFlight=true;log.requests++;
      await fs.mkdir(runtimeDir,{recursive:true});await writeJsonAtomic(file,log);if(budget)budget.spent+=reserve;
      let payload;
      try{
        const response=await fetcher(assistantProviders.deepseek.endpoint,{method:'POST',redirect:'error',headers:{authorization:`Bearer ${config.JOB_ASSISTANT_API_KEY}`,'content-type':'application/json'},signal:AbortSignal.any([local.signal,...(signal?[signal]:[]),AbortSignal.timeout(60000)]),body:JSON.stringify({model:config.JOB_ASSISTANT_MODEL,thinking:{type:'disabled'},temperature:0,max_tokens:maxTokens,response_format:{type:'json_object'},messages:[{role:'system',content:prompt},{role:'user',content}]})});
        if(!response.ok)throw Error(`HTTP ${response.status}`);
        payload=await response.json();
      }catch{log.unknown++;log.inFlight=false;await writeJsonAtomic(file,log);throw Error('DeepSeek请求失败或中断，用量可能未知；未自动重试，请检查助手模型配置、余额或网络');}
      const u=payload.usage;
      if(!u||![u.prompt_tokens,u.completion_tokens].every(n=>Number.isSafeInteger(n)&&n>=0)){log.unknown++;log.inFlight=false;await writeJsonAtomic(file,log);throw Error('DeepSeek未返回完整Token用量，停止，不重试');}
      const estimate=(u.prompt_tokens*recruiterPrices.input+u.completion_tokens*recruiterPrices.output)/1e6;
      log.input+=u.prompt_tokens;log.output+=u.completion_tokens;log.estimate+=estimate;log.inFlight=false;await writeJsonAtomic(file,log);if(budget)budget.spent+=estimate-reserve;
      signal?.throwIfAborted();local.signal.throwIfAborted();
      await fs.mkdir(path.join(runtimeDir,'responses'),{recursive:true});
      await writeJsonAtomic(path.join(runtimeDir,'responses',randomUUID()+'.json'),{id:payload.id,model:payload.model,usage:u,finishReason:payload.choices?.[0]?.finish_reason,content:payload.choices?.[0]?.message?.content,recordedAt:new Date().toISOString()});
      if(payload.choices?.[0]?.finish_reason!=='stop')throw Error('DeepSeek输出截断或未正常完成；用量已记录，不采用部分结果');
      const parsed=parseRecruiterJson(payload.choices?.[0]?.message?.content);
      Object.defineProperties(parsed,{_usage:{value:{input:u.prompt_tokens,output:u.completion_tokens,estimate}},_model:{value:config.JOB_ASSISTANT_MODEL}});return parsed;
    }finally{busy=false;if(controller===local)controller=null;}
  }
  return {request,status,cancel(){controller?.abort();}};
}
