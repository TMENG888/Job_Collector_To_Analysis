import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {withAccountLock} from './collection_concurrency.mjs';
import {writeJsonAtomic} from './collector_storage.mjs';
import {HYBRID_MODE,browserFallbackPlatforms,collectionTransportPolicy} from './channel_acquisition.mjs';

export const platformRateOrigins={zhaopin:['https://fe-api.zhaopin.com','https://www.zhaopin.com'],job51:['https://we.51job.com'],jobonline:['https://api.jobonline.cn','https://www.jobonline.cn'],liepin:['https://api-c.liepin.com','https://www.liepin.com','https://c.liepin.com']};
export const rateKey=origin=>createHash('sha256').update(origin).digest('hex').slice(0,24);
export const accessStopCodes=new Set(['verification_required','access_blocked','login_required','origin_cooldown','waiting_human','captcha_required']);
export const accessStates=new Set(['verification_required','business_access_blocked','access_blocked','login_required','challenge','captcha_required','waiting_human',401,403,429,'401','403','429']);
export function browserFallbackAllowed({mode,platform,errors=[],httpReady=true}={}){
  if(mode!==HYBRID_MODE||!browserFallbackPlatforms.includes(platform))return false;
  if(errors.some(e=>accessStopCodes.has(e?.code)||[42,43].includes(e?.code)||['RESOURCE_PRESSURE','OUTPUT_LOCKED','TASK_OUTPUT_OWNERSHIP','pagination_stalled'].includes(e?.code)))return false;
  if(!httpReady)return errors.length===0;
  return errors.length>0&&errors.every(e=>['invalid_response','api_schema_changed','response_timeout','client_unavailable','ETIMEDOUT','ECONNRESET','ENOTFOUND','http_unavailable'].includes(e?.code));
}
export async function readBrowserAccessState(platform,stateDir){
  if(!platformRateOrigins[platform])throw Error('未知浏览器采集平台');
  const result=[];
  for(const origin of platformRateOrigins[platform]){
    const file=path.join(stateDir,rateKey(origin)+'.json');
    const state=await fs.readFile(file,'utf8').then(JSON.parse).catch(e=>{if(e.code==='ENOENT')return {};throw e;});
    result.push({origin,state});
  }
  return result;
}
export async function assertBrowserAccess(platform,stateDir,{now=Date.now()}={}){
  const states=await readBrowserAccessState(platform,stateDir);
  if(states.some(({state})=>Number(state.cooldownUntil||0)>now))throw Object.assign(Error('渠道仍在共享冷却期，不切换浏览器规避限制'),{code:'origin_cooldown',stopChannel:true});
  const blocked=states.some(({state})=>accessStates.has(state.status));
  if(blocked)throw Object.assign(Error('渠道存在验证/拒绝访问记录；需人工处理并复核渠道状态，不能自动换取数方式'),{code:'waiting_human',stopChannel:true});
  return states;
}
export async function recordBrowserDenial(platform,stateDir,code){
  if(!accessStopCodes.has(code)||['origin_cooldown','waiting_human'].includes(code))return;
  await fs.mkdir(stateDir,{recursive:true});const origin=platformRateOrigins[platform][0],key=rateKey(origin),file=path.join(stateDir,key+'.json');
  await withAccountLock(path.join(stateDir,key+'.lock'),'browser-denial',async()=>{const state=await fs.readFile(file,'utf8').then(JSON.parse).catch(e=>{if(e.code==='ENOENT')return {};throw e;});await writeJsonAtomic(file,{...state,origin,status:code,cooldownUntil:Math.max(Number(state.cooldownUntil||0),Date.now()+collectionTransportPolicy.cooldownMs)});},{interval:100,onWait:()=>{}});
}
// Browser actions share the HTTP platform's rate clock. The page can make its
// own background requests; this does not claim to throttle every site asset.
export async function withBrowserStep(platform,stateDir,action,{minimumIntervalMs=4000,jitterMs=700,wait=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now}={}){
  await fs.mkdir(stateDir,{recursive:true});
  const origin=platformRateOrigins[platform]?.[0];if(!origin)throw Error('未接入浏览器平台');
  const key=rateKey(origin),file=path.join(stateDir,key+'.json');
  return withAccountLock(path.join(stateDir,key+'.lock'),'browser-dom',async()=>{
    const states=await assertBrowserAccess(platform,stateDir,{now:now()});
    const state=states.find(s=>s.origin===origin).state;
    const interval=Math.max(4000,Number(minimumIntervalMs)||0),jitter=Math.max(0,Math.min(3000,Number(jitterMs)||0));
    const delay=Math.max(0,Number(state.lastStartedAt||0)+interval-now())+Math.floor(Math.random()*jitter);if(delay)await wait(delay);
    await writeJsonAtomic(file,{...state,origin,lastStartedAt:now()});
    try{return await action();}catch(error){
      if(accessStopCodes.has(error.code)&&error.code!=='origin_cooldown'&&error.code!=='waiting_human')await writeJsonAtomic(file,{...state,origin,lastStartedAt:now(),status:error.code,cooldownUntil:now()+collectionTransportPolicy.cooldownMs});
      throw error;
    }
  },{interval:100,onWait:()=>{}});
}
