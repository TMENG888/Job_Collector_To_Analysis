import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {boundedFetch} from './collection_policy.mjs';
import {withAccountLock} from './collection_concurrency.mjs';
import {writeJsonAtomic} from './collector_storage.mjs';
import {collectionTransportPolicy as policy} from './channel_acquisition.mjs';
import {parseMohrssDataPage} from './public_api_adapters.mjs';

const endpoints=new Map([
  ['https://gw-c.nowcoder.com',new Set(['/api/sparta/pc/search'])],
  // 牛客社招/校招/实习广场列表：匿名表单接口，服务端分页与筛选。
  ['https://nowpick.nowcoder.com',new Set(['/u/job/square-search'])],
  ['https://www.shixiseng.com',new Set(['/app/interns/search/v2','/proxy-prefix/new-intern-api-host/api/interns/v3.0/interns/info/wxz'])],
  ['https://gp-api.iguopin.com',new Set(['/api/jobs/v1/recom-job'])],
  ['https://fe-api.zhaopin.com',new Set(['/c/i/search/positions','/c/i/refresh-token'])],
  ['https://api.jobonline.cn',new Set(['/jobtbao-es-api/elastic/api/position/common/v1/showlist'])],
  ['https://api-c.liepin.com',new Set(['/api/com.liepin.searchfront4c.pc-search-job'])],
  ['http://job.mohrss.gov.cn',new Set(['/cjobs/jobinfolist/listJobinfolist'])],
]);
const stop=(message,code)=>Object.assign(Error(message),{code,stopChannel:true});
export const nowcoderApiOrigins=new Set(['https://gw-c.nowcoder.com','https://nowpick.nowcoder.com']);
export function validateDirectHttpEndpoint(value){
  const url=new URL(value);
  const nowcoderDetail=url.origin==='https://gw-c.nowcoder.com'&&/^\/api\/sparta\/detail\/(?:moment-data\/detail\/[a-f0-9]{32}|content-data\/detail\/\d{1,20})$/.test(url.pathname);
  if(url.username||url.password||!(endpoints.get(url.origin)?.has(url.pathname)||nowcoderDetail))throw stop('未核验的直连接口；拒绝请求或回退到浏览器','DIRECT_HTTP_REQUIRED');
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
export function createPoliteHttpClient({stateDir,minimumIntervalMs=policy.minimumIntervalMs,jitterMs=700,attempts=policy.maxAttempts,fetchImpl=fetch,now=Date.now,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),random=Math.random,maxResponseBytes=4*1024**2,sessionOrigins=sessionCredentialOrigins,burstSize=Number(process.env.JOB_HTTP_BURST_SIZE)||0,burstRecoveryMs=Number(process.env.JOB_HTTP_BURST_RECOVERY_MS)||0}={}){
  if(!stateDir)throw Error('HTTP 限速器缺少共享状态目录');
  const interval=Math.max(policy.minimumIntervalMs,Number(minimumIntervalMs)||0),jitter=Math.max(0,Math.min(3000,Number(jitterMs)||0));
  // 突发节流：同一来源连续请求到 burstSize 次后强制休息 burstRecoveryMs。
  // 原因：智联风控按“短时间窗口内请求量”判定（实测 30 次左右开始 isVerification=1），
  // 只靠最小间隔仍会在深翻页时整体被封。默认 0 表示不启用，行为与之前完全一致。
  const burstLimit=Math.max(0,Number(burstSize)||0);
  // 突发必须同时配置次数与休息时长，缺一即视为未启用：只给次数会让节流变成纯日志噪音。
  const burstRecovery=burstLimit>0?Math.max(0,Number(burstRecoveryMs)||0):0;
  const burstEnabled=burstLimit>0&&burstRecovery>0;
  // 命中突发上限后，把恢复时间记到该来源的下一次请求上；正常间隔照常叠加。
  // 计数与「待休息」必须分开放：旧实现把两者塞进同一个 Map，take 读走计数后顺手清零，
  // note 再读只能读到 0，计数永远停在 1，突发休息从未真正触发（日志一直「休息 0 秒」）。
  const burstPending=new Map();
  const burstCount=new Map();
  const takeBurstDelay=key=>{const pending=burstPending.get(key)||0;if(!burstEnabled||!pending)return 0;burstPending.set(key,0);return pending;};
  const noteBurst=key=>{
    if(!burstEnabled)return;
    // 连续请求计数（不因 take 归零），只有真正休息过才清零。
    const used=(burstCount.get(key)||0)+1;
    if(used>burstLimit){burstPending.set(key,burstRecovery);burstCount.set(key,0);return;}
    burstCount.set(key,used);
  };
  // 条件级让位之后仍需落一次来源级冷却：风控校验一旦出现，
  // 紧接着的同一条件或相邻条件继续打同一来源只会把校验窗口拉长。
  // 冷却状态文件必须与 request 的 key 同源：同一来源哈希，才能被后续请求的冷却闸门命中。
  const originKey=value=>createHash('sha256').update(new URL(value).origin).digest('hex').slice(0,24);
  const penalize=async(reason='verification_required',retryMs=0,origin='https://fe-api.zhaopin.com')=>{
    const file=path.join(stateDir,originKey(origin)+'.json');
    return withAccountLock(`${file}.lock`,'direct-http',async()=>{
      const state=await fs.readFile(file,'utf8').then(JSON.parse).catch(()=>({}));
      const until=now()+Math.max(policy.cooldownMs,Math.min(24*60*60*1000,Number(retryMs)||0));
      await writeJsonAtomic(file,{...state,cooldownUntil:until,status:reason,lastVerificationAt:new Date().toISOString()});
      console.log(`[来源冷却] ${reason}：${new URL(origin).origin} 已冷却至 ${new Date(until).toISOString()}，期间不再发起请求`);
      return until;
    });
  };
  const request=async function request(value,options={}){
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
      // 拦截原因取证：只记状态码、路径与≤200字符的响应开头，便于判定是风控页、结构变更还是凭据过期；
      // 绝不记录请求头、凭据与完整响应体。
      const breadcrumbs=async(status,extra={})=>{
        const entry={at:new Date().toISOString(),status,origin:url.origin,path:url.pathname,method:options.method||'GET',...extra};
        state={...state,lastBlocked:entry,recentBlocks:[...(Array.isArray(state.recentBlocks)?state.recentBlocks:[]),entry].slice(-8)};
      };
      // 明确的风控/访问受限：写入跨任务长冷却，等待人工处理。
      const cool=async(status,retryMs=0,extra={})=>{await breadcrumbs(status,extra);state={...state,cooldownUntil:now()+Math.max(policy.cooldownMs,Math.min(24*60*60*1000,retryMs||0)),status};await writeJsonAtomic(file,state);};
      // 偶发契约异常（空/非JSON/结构抖动）：只做本轮短退避，不写跨任务冷却。
      // 一次网络抖动不应让渠道在后续 15 分钟内被整体锁死。
      const softCool=async(status,retryMs=0,extra={})=>{await breadcrumbs(status,extra);state={...state,cooldownUntil:now()+Math.max(0,Math.min(60*1000,retryMs||0)),status};await writeJsonAtomic(file,state);};
      const validatedEmbedded=new WeakSet();
      return boundedFetch(url.href,{...options,redirect:'manual'},{
        attempts:Math.min(policy.maxAttempts,Math.max(1,Number(attempts)||1)),timeoutMs:20000,wait,
        isValidatedData:response=>validatedEmbedded.has(response),
        before:async()=>{
          if(Number(state.cooldownUntil||0)>now())throw stop('该站点处于跨任务冷却期，不继续请求或重试','origin_cooldown');
          if(state.lastStartedAt!=null){const delay=Math.max(0,Number(state.lastStartedAt)+interval-now())+Math.floor(random()*jitter);if(delay)await wait(delay);}
          noteBurst(key);
          const burstDelay=takeBurstDelay(key);
          if(burstDelay){console.log(`[突发节流] ${url.origin} 已连续请求 ${burstLimit} 次，休息 ${Math.round(burstDelay/1000)} 秒后继续`);await wait(burstDelay);}
          state={...state,origin:url.origin,lastStartedAt:now()};await writeJsonAtomic(file,state);
        },
        fetchImpl:async(target,init)=>{
          let response;
          try{response=await fetchImpl(target,init);}catch(error){
            // Explicit website-session transports share this reservation too.
            // A page-level verification must cool the same API origin, not be
            // retried merely because no HTTP Response was returned.
            if(error.stopChannel&&['verification_required','access_blocked','login_required'].includes(error.code))await cool(error.code);
            throw error;
          }
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
          const preview=text=>String(text??'').replace(/\s+/g,' ').trim().slice(0,200);
          if(result.ok){
            const text=await result.clone().text();
            // Only this exact official SSR route can return HTML. Parse the
            // inert data attribute; never execute scripts or follow redirects.
            if(embedded){
              try{parseMohrssDataPage(text);validatedEmbedded.add(result);}catch(error){await cool('invalid_embedded_data',0,{preview:preview(text)});throw error;}
            }else{
              // Some public APIs label valid JSON as text/plain or text/html.
              // Accept data, not MIME alone; actual HTML/challenges still stop.
              let body;try{body=JSON.parse(text);}catch{
                const challenge=/^\s*</.test(text)&&/captcha|challenge|aliyun_waf|验证码|安全验证|人机验证|访问验证|请按住滑块/i.test(text);
                // JSON 接口返回 HTML（含无诊断词的挑战页）一律视为风控/结构异常，长冷却；
                // 仅纯文本解析失败（不以 '<' 开头，即截断/抖动）走短退避。
                if(challenge||/^\s*</.test(text)){const code=challenge?'verification_required':'invalid_json';await cool(code,0,{preview:preview(text)});throw stop(challenge?'接口返回安全验证页面，已停止冷却':'接口返回 HTML 而非业务 JSON，已停止冷却',code);}
                await softCool('invalid_json',0,{preview:preview(text)});
                throw stop('接口未返回有效 JSON，本轮该条件跳过并短退避；不执行页面或浏览器回退','invalid_response');
              }
              if(!body||typeof body!=='object'){await softCool('invalid_json_shape',0,{preview:preview(text)});throw stop('接口 JSON 不是数据对象，本轮跳过并短退避','invalid_response');}
              if([101,401,403,429].includes(Number(body?.code))){await cool('business_access_blocked',0,{bodyCode:Number(body?.code),bodyMessage:String(body?.message||body?.msg||'').slice(0,120),preview:preview(text)});throw stop('接口业务响应要求登录、验证或限流，已停止并冷却','access_blocked');}
              if(nowcoderApiOrigins.has(url.origin)&&Number(body.code)!==0&&([999].includes(Number(body.code))||/login|captcha|verify|登录|验证|频繁|限流|访问受限/i.test(String(body.msg||'')))){await cool('nowcoder_access_blocked',0,{bodyCode:Number(body?.code),bodyMessage:String(body?.msg||'').slice(0,120)});throw stop('牛客接口要求登录、验证或限流，已停止并冷却','access_blocked');}
              // 智联的瞬时风控校验（body.data.isVerification=1，业务码仍为 200）不在此处升级为来源级冷却：
              // 它只针对当次关键词/城市条件，判定与让位已下移到 direct_zhaopin_session.mjs，
              // 抛 stopChannel:false 的条件级错误；否则单个条件命中就会锁死整个渠道 900 秒。
              if(url.origin==='https://fe-api.zhaopin.com'&&[401,403,429].includes(Number(body?.data?.statusCode))){await cool('verification_required',0,{bodyCode:Number(body?.code),bodyMessage:String(body?.message||'').slice(0,120),dataStatusCode:body?.data?.statusCode??null});throw stop('智联接口返回访问受限状态码，已停止并冷却','verification_required');}
            }
          }
          return result;
        },
      });
    },{interval:100,onWait:()=>{}});
  };
  request.penalize=penalize;
  return request;
}
