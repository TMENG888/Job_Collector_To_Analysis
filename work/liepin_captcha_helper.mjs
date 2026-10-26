// Capture only a successful, normal website search. No stealth flags, generated
// verification identifiers, captcha solving, automatic login or browser fallback.
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {launchWebsiteContext,readWebsiteSearch} from './liepin_website_session.mjs';
import {LIEPIN_SEARCH_ENDPOINT} from './liepin_session_capture.mjs';
import {createPoliteHttpClient} from './polite_http_client.mjs';
import {writeJsonAtomic} from './collector_storage.mjs';
import {liepinCities} from './liepin_cities.mjs';

export async function captureLiepinSession({profileDir,stateDir=path.resolve(import.meta.dirname,'../ui_data/liepin_login'),rateDir=path.resolve(import.meta.dirname,'../ui_data/http_rate_limits'),keyword='数据智能体',city='广州',headless=false,waitMs=120000,executablePath='C:/Program Files/Google/Chrome/Application/chrome.exe'}={}){
  if(!profileDir||!path.isAbsolute(profileDir))throw Error('请显式指定本机会话目录 --profile-dir（新建目录请放 E 盘）');
  if(!Object.hasOwn(liepinCities,city)||!keyword.trim())throw Error('关键词或城市无效');
  if(headless)throw Error('官网会话通路仅使用有界面浏览器，不支持无头验证');
  const context=await launchWebsiteContext(profileDir,{executablePath});
  const page=context.pages()[0]||await context.newPage();
  try{
    const request=createPoliteHttpClient({stateDir:rateDir,attempts:1,fetchImpl:async()=>{
      const body=await readWebsiteSearch(page,keyword,{name:city,code:liepinCities[city]},0,{timeoutMs:Math.min(30000,Math.max(5000,waitMs))});
      return new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
    }});
    const body=await (await request(LIEPIN_SEARCH_ENDPOINT)).json();
    // Save metadata only; Cookie and storage stay in the normal browser profile.
    // Existing cookies.json and session_template.json are left untouched.
    const summary={ok:true,transport:'website_session_api',keyword,city,rows:body.data.data.jobCardList.length,total:body.data.pagination.totalCounts,totalPages:body.data.pagination.totalPage,profileDir,checkedAt:new Date().toISOString()};
    await writeJsonAtomic(path.join(stateDir,'website_session.json'),summary);
    console.log(JSON.stringify(summary));return summary;
  }finally{await context.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const args=process.argv.slice(2),value=name=>{const index=args.indexOf(name);return index>=0?args[index+1]:undefined;};
  try{await captureLiepinSession({profileDir:value('--profile-dir')||process.env.LIEPIN_SESSION_PROFILE,stateDir:value('--state-dir'),rateDir:value('--rate-dir'),keyword:value('--keyword')||'数据智能体',city:value('--city')||'广州',headless:args.includes('--headless'),waitMs:Number(value('--wait-ms'))||120000});}
  catch(error){console.error(JSON.stringify({ok:false,code:error.code||'capture_failed',message:error.message}));process.exitCode=1;}
}
