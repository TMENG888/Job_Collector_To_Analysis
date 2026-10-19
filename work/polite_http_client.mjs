import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {boundedFetch} from './collection_policy.mjs';
import {withAccountLock} from './collection_concurrency.mjs';
import {writeJsonAtomic} from './collector_storage.mjs';
import {collectionTransportPolicy as policy} from './channel_acquisition.mjs';
import {parseMohrssDataPage} from './public_api_adapters.mjs';

const endpoints=new Map([
  ['https://www.shixiseng.com',new Set(['/app/interns/search/v2','/proxy-prefix/new-intern-api-host/api/interns/v3.0/interns/info/wxz'])],
  ['https://gp-api.iguopin.com',new Set(['/api/jobs/v1/recom-job'])],
  ['https://fe-api.zhaopin.com',new Set(['/c/i/search/positions'])],
  ['https://api.jobonline.cn',new Set(['/jobtbao-es-api/elastic/api/position/common/v1/showlist'])],
  ['https://api-c.liepin.com',new Set(['/api/com.liepin.searchfront4c.pc-search-job'])],
  ['http://job.mohrss.gov.cn',new Set(['/cjobs/jobinfolist/listJobinfolist'])],
]);
const stop=(message,code)=>Object.assign(Error(message),{code,stopChannel:true});
export function validateDirectHttpEndpoint(value){
  const url=new URL(value);
  if(url.username||url.password||!endpoints.get(url.origin)?.has(url.pathname))throw stop('未核验的直连接口；拒绝请求或回退到浏览器','DIRECT_HTTP_REQUIRED');
  return url;
}
// 会话渠道：仅这些 origin 允许携带本人登录会话 cookie（来自本地登录助手）。
// 匿名公开页面仍禁止携带任何账户凭据，安全契约不变。
export const sessionCredentialOrigins=new Set(['https://fe-api.zhaopin.com','https://api-c.liepin.com']);

async function limitedResponse(response,maxBytes){
  const length=Number(response.headers.get('content-length'));
  if(length>maxBytes){await response.body?.cancel();throw stop('接口响应超过内存预算，已停止并保留断点','response_too_large');}
  if(!response.body)return response;
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{
    while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;
      if(size>maxBytes){await reader.cancel();throw stop('接口响应超过内存预算，已停止并保留断点','response_too_large');}chunks.push(value);}
  }finally{reader.releaseLock();}
  return new Response(Buffer.concat(chunks.map(chunk=>Buffer.from(chunk))),{status:response.status,statusText:response.statusText,headers:response.headers});
}

// The origin lock covers response consumption as well as request start time.
// All collector processes/tasks share stateDir; no cookies or bodies are saved.
export function createPoliteHttpClient({stateDir,minimumIntervalMs=policy.minimumIntervalMs,jitterMs=700,attempts=policy.maxAttempts,fetchImpl=fetch,now=Date.now,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),random=Math.random,maxResponseBytes=4*1024**2,sessionOrigins=sessionCredentialOrigins}={}){
  if(!stateDir)throw Error('HTTP 限速器缺少共享状态目录');
  const interval=Math.max(policy.minimumIntervalMs,Number(minimumIntervalMs)||0),jitter=Math.max(0,Math.min(3000,Number(jitterMs)||0));
  return async function request(value,options={}){
    const url=validateDirectHttpEndpoint(value),key=createHash('sha256').update(url.origin).digest('hex').slice(0,24);
    const embedded=url.origin==='http://job.mohrss.gov.cn';
    const hasCredential=[...new Headers(options.headers).keys()].some(name=>/^(?:authorization|cookie|proxy-authorization)$/i.test(name));
    // 匿名公开页面禁止携带账户凭据；仅已显式登记的会话 origin 可携带本人登录 cookie。
    if(hasCredential&&(embedded||!sessionOrigins.has(url.origin)))throw stop('公开 HTTP 接口/页面禁止携带账户凭据；仅已登记的会话渠道可携带','DIRECT_HTTP_REQUIRED');
    await fs.mkdir(stateDir,{recursive:true});
    return withAccountLock(path.join(stateDir,key+'.lock'),'direct-http',async()=>{
      const file=path.join(stateDir,key+'.json');
      let state=await fs.readFile(file,'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return {};throw error;});
      if(Number(state.cooldownUntil||0)>now())throw stop('该站点处于跨任务冷却期，请稍后人工检查登录、访问限制或限流状态','origin_cooldown');
      // 明确的风控/访问受限：写入跨任务长冷却，等待人工处理。
      const cool=async(status,retryMs=0)=>{state={...state,cooldownUntil:now()+Math.max(policy.cooldownMs,Math.min(24*60*60*1000,retryMs||0)),status};await writeJsonAtomic(file,state);};
      // 偶发契约异常（空/非JSON/结构抖动）：只做本轮短退避，不写跨任务冷却。
      // 一次网络抖动不应让渠道在后续 15 分钟内被整体锁死。
      const softCool=async(status,retryMs=0)=>{state={...state,cooldownUntil:now()+Math.max(0,Math.min(60*1000,retryMs||0)),status};await writeJsonAtomic(file,state);};
      const validatedEmbedded=new WeakSet();
      return boundedFetch(url.href,{...options,redirect:'manual'},{
        attempts:Math.min(policy.maxAttempts,Math.max(1,Number(attempts)||1)),timeoutMs:20000,wait,
        isValidatedData:response=>validatedEmbedded.has(response),
        before:async()=>{
          if(Number(state.cooldownUntil||0)>now())throw stop('该站点处于跨任务冷却期，不继续请求或重试','origin_cooldown');
          if(state.lastStartedAt!=null){const delay=Math.max(0,Number(state.lastStartedAt)+interval-now())+Math.floor(random()*jitter);if(delay)await wait(delay);}
          state={...state,origin:url.origin,lastStartedAt:now()};await writeJsonAtomic(file,state);
        },
        fetchImpl:async(target,init)=>{
          const response=await fetchImpl(target,init);
          if([401,403,429].includes(response.status)){
            const raw=response.headers.get('retry-after'),seconds=Number(raw),retryMs=raw?(Number.isFinite(seconds)?seconds*1000:Math.max(0,Date.parse(raw)-now())):0;
            await cool(response.status,retryMs);
            // Do not let a broken error-response stream turn an access denial
            // into a transient network retry that bypasses the new cooldown.
            await response.body?.cancel().catch(()=>{});
            throw stop(`HTTP ${response.status}，已停止并冷却，不自动重试`,'access_blocked');
          }
          // No redirect following, no automatic challenge execution, no browser.
          const result=await limitedResponse(response,maxResponseBytes);
          if(result.ok){
            const text=await result.clone().text();
            // Only this exact official SSR route can return HTML. Parse the
            // inert data attribute; never execute scripts or follow redirects.
            if(embedded){
              try{parseMohrssDataPage(text);validatedEmbedded.add(result);}catch(error){await cool('invalid_embedded_data');throw error;}
            }else{
              // Some public APIs label valid JSON as text/plain or text/html.
              // Accept data, not MIME alone; actual HTML/challenges still stop.
              let body;try{body=JSON.parse(text);}catch{
                const challenge=/^\s*</.test(text)&&/captcha|challenge|aliyun_waf|验证码|安全验证|人机验证|访问验证|请按住滑块/i.test(text);
                // JSON 接口返回 HTML（含无诊断词的挑战页）一律视为风控/结构异常，长冷却；
                // 仅纯文本解析失败（不以 '<' 开头，即截断/抖动）走短退避。
                if(challenge||/^\s*</.test(text)){const code=challenge?'verification_required':'invalid_json';await cool(code);throw stop(challenge?'接口返回安全验证页面，已停止冷却':'接口返回 HTML 而非业务 JSON，已停止冷却',code);}
                await softCool('invalid_json');
                throw stop('接口未返回有效 JSON，本轮该条件跳过并短退避；不执行页面或浏览器回退','invalid_response');
              }
              if(!body||typeof body!=='object'){await softCool('invalid_json_shape');throw stop('接口 JSON 不是数据对象，本轮跳过并短退避','invalid_response');}
              if([101,401,403,429].includes(Number(body?.code))){await cool('business_access_blocked');throw stop('接口业务响应要求登录、验证或限流，已停止并冷却','access_blocked');}
              if(url.origin==='https://fe-api.zhaopin.com'&&([true,1,'1','true'].includes(body?.data?.isVerification)||[401,403,429].includes(Number(body?.data?.statusCode)))){await cool('verification_required');throw stop('智联要求登录、验证或限流，已停止并冷却','verification_required');}
            }
          }
          return result;
        },
      });
    },{interval:100,onWait:()=>{}});
  };
}
