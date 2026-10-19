import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {safeBrowserURL,siteForURL,cleanJobURL,browserSites} from './job-browser-contracts.mjs';
import {searchBrowserURL} from './job-browser-plugins.mjs';

const source=fileURLToPath(new URL('../job_collector_ui/browser-extension',import.meta.url));
const packageDir='E:/Codex/outputs/20261019-browser-extension/岗位助手扩展';
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export function createExtensionBridge({browserManager,launch=spawn,now=Date.now,pollMs=15000,commandMs=20000,outputDir=packageDir}={}){
  let code=null,codeExpires=0,token=null,extensionId=null,protocol=1,lastSeen=0,closing=false,waiter=null,launching=false;
  let state={tabs:[],selectedTabId:null},lastPluginAt=0,launchRequest=null;
  const queued=[],pending=new Map(),tickets=new Map();
  const connected=()=>!!token&&now()-lastSeen<45000;
  function failPending(){for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('扩展连接已断开；不会重试可能已执行的操作'));}pending.clear();queued.length=0;tickets.clear();}
  function disconnect(){token=null;extensionId=null;lastSeen=0;state={tabs:[],selectedTabId:null};if(waiter){clearTimeout(waiter.timer);waiter.resolve({command:null});waiter=null;}failPending();}
  async function status(){return {running:connected(),mode:'extension',browserId:(await browserManager.read()).browserId,profileDir:browserManager.profileFor(await browserManager.read()),...connected()?state:{tabs:[],selectedTabId:null},busy:launching,extension:{connected:connected(),protocol,lastSeen:lastSeen?new Date(lastSeen).toISOString():null,extensionId,packageDir:outputDir,launchRequest}};}
  async function launchWindow(target,{manager=false}={}){
    if(launching)throw Error('普通浏览器打开请求正在处理，请稍候');launching=true;
    try{
      const c=await browserManager.resolve();
      if(c.mode!=='extension')throw Error('请先选择普通浏览器模式');
      const url=manager?(c.browserId==='edge'?'edge://extensions/':'chrome://extensions/'):safeBrowserURL(target);
      await fs.mkdir(c.profileDir,{recursive:true});
      const child=launch(c.executable,[`--user-data-dir=${c.profileDir}`,'--new-window',url],{windowsHide:false,stdio:'ignore'});
      await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',()=>reject(Error('普通浏览器启动失败，请检查安装路径')));});
      launchRequest={id:randomUUID(),url,at:new Date(now()).toISOString(),submitted:true,verified:false,error:''};const record=launchRequest;
      child.on('exit',exitCode=>{if(exitCode&&launchRequest===record)record.error=`浏览器进程退出（代码${exitCode}），请检查浏览器窗口；未自动重试`;});
      child.unref();return {...await status(),busy:false,openRequest:{url,transport:'system-browser-launch',submitted:true,verified:false}};
    }finally{launching=false;}
  }
  async function openURL(value){
    const url=safeBrowserURL(value);
    if(connected()){tickets.clear();const opened=await send('new-tab',{url});return {...await status(),openRequest:{url,tabId:opened?.tabId,transport:'extension',submitted:true,verified:false}};}
    return launchWindow(url);
  }
  async function onboarding(){
    if(connected())throw Error('已有扩展连接，请先断开再重新配对');
    await fs.mkdir(outputDir,{recursive:true});await fs.cp(source,outputDir,{recursive:true,force:true});
    code=randomBytes(16).toString('hex');codeExpires=now()+10*60000;
    return {code,expiresAt:new Date(codeExpires).toISOString(),extensionPath:outputDir,steps:['打开普通浏览器的扩展管理页','手动开启开发者模式，加载此文件夹','点击“本机岗位助手”扩展，粘贴连接码'],note:'连接码仅用于本机配对；10分钟有效、一次使用。不在招聘网站粘贴。'};
  }
  function take(){while(queued.length){const c=queued.shift();const p=pending.get(c.id);if(p){p.delivered=true;return c;}}return null;}
  function notify(){if(waiter){const c=take();if(c){clearTimeout(waiter.timer);waiter.resolve({command:c});waiter=null;}}}
  function send(method,args={}){
    if(!connected())throw Error('普通浏览器扩展未连接；请先加载扩展并用连接码配对');
    if(pending.size>=4)throw Error('插件操作尚未结束，请稍候');
    const id=randomUUID();return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(id);reject(Error(method==='confirm-action'?'执行结果超时，可能已经发送或投递；请人工核对，不会重试':'扩展响应超时；请核对浏览器，不会重试'));},commandMs);
      pending.set(id,{resolve,reject,timer,delivered:false});queued.push({id,method,args});notify();
    });
  }
  function current(args){const id=String(args.tabId||state.selectedTabId||'');const t=state.tabs.find(t=>t.id===id);if(!t)throw Error('请在普通浏览器打开并选中招聘网站标签');return t;}
  async function command(method,args={}){
    if(method==='status')return status();
    if(method==='shutdown'){closing=true;disconnect();return {ok:true};}
    if(method==='stop'){disconnect();return status();}
    if(method==='start'){
      if(connected())return status();return openURL(args.url||browserSites[0].url);
    }
    if(method==='open-site')return openURL(args.url);
    if(method==='extension-manager')return launchWindow(null,{manager:true});
    if(method==='plugin'&&args.id==='search')return openURL(searchBrowserURL(args.site,args.keyword,args.city));
    if(['stream','resize'].includes(method))return {ok:true};
    if(['input','input-batch'].includes(method))throw Error('请在普通浏览器直接操作网页');
    if(method==='new-tab'){const url=safeBrowserURL(args.url);await send(method,{url});return status();}
    const t=current(args),base={tabId:t.id};
    if(['navigate','select','focus','close-tab','back','forward','reload'].includes(method)){
      tickets.clear();await send(method,{...base,...method==='navigate'?{url:safeBrowserURL(args.url)}:{}});return status();
    }
    if(t.id!==state.selectedTabId)throw Error('浏览器当前标签已变化，请重新选择');
    if(['mirror-frame','mirror-input'].includes(method)){
      if(protocol<3)throw Error('请重新加载1.2.0扩展并重新连接，以启用交互镜像');
      return send(method,{...base,frameId:args.frameId,input:args.input});
    }
    if(['delivery-context','delivery-message','delivery-image'].includes(method)){
      if(protocol<3)throw Error('发送需要1.2.0扩展');
      return send(method,{...base,job:args.job,binding:args.binding,message:args.message,image:args.image});
    }
    if(method==='plugin'){
      if(now()-lastPluginAt<2000)throw Error('插件操作间隔至少2秒，请稍候');lastPluginAt=now();
      if(!['read-detail','collect-page'].includes(args.id))throw Error('不支持的读取插件');
      const result=await send(method,{...base,id:args.id});
      if(!Array.isArray(result?.rows)||result.rows.length>100)throw Error('无效插件响应');
      const site=siteForURL(t.url);return {rows:result.rows.filter(r=>siteForURL(r.url)?.id===site?.id).map(r=>({url:cleanJobURL(r.url),title:String(r.title||'').slice(0,180),company:String(r.company||'').slice(0,200),salary:String(r.salary||'').slice(0,100),city:String(r.city||'').slice(0,100),description:String(r.description||'').slice(0,30000),site:site.id,platform:site.name,source:'browser-extension-visible-dom',capturedAt:new Date(now()).toISOString()}))};
    }
    if(method==='prepare-action'){
      if(!['apply','message'].includes(args.kind))throw Error('无效操作类型');
      if(args.kind==='message'&&(typeof args.message!=='string'||args.message.trim().length<2||args.message.length>2000))throw Error('请填写2–2000字消息');
      const value=await send(method,{...base,kind:args.kind,message:args.message});tickets.clear();
      const record={id:value.id,tabId:t.id,url:t.url,kind:args.kind,identity:value.identity,label:value.label,body:args.message||'',fingerprint:value.fingerprint||'',expires:now()+120000,generation:t.generation};tickets.set(record.id,record);
      return {...record,note:args.kind==='message'?'仅向当前核对的收件人发送一次，不重试、不群发。':'仅点击当前按钮一次；网站可能发送默认招呼或使用在线简历，后续弹窗请手动处理。'};
    }
    if(method==='confirm-action'){
      const ticket=tickets.get(args.ticketId);tickets.delete(args.ticketId);
      if(!ticket||ticket.expires<now()||ticket.tabId!==t.id||ticket.url!==t.url||ticket.generation!==t.generation)throw Error('页面或确认方案已变化，未执行');
      return send(method,{...base,ticketId:ticket.id});
    }
    if(method==='cancel-action'){tickets.clear();return send(method,base);}
    throw Error('不支持的扩展命令');
  }
  async function handler(req,res,pathname){
    if(!pathname.startsWith('/api/browser/extension/'))return false;
    const json=(status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value));};
    try{
      if(closing)throw Error('服务正在关闭');
      const extensionOrigin=/^chrome-extension:\/\/[a-p]{32}$/.test(req.headers.origin||'');
      if(req.headers.host!=='127.0.0.1:8788'||req.method!=='POST'||req.headers.origin&&!extensionOrigin||req.headers['sec-fetch-site']==='cross-site'&&!extensionOrigin)return json(403,{error:'仅允许本机扩展连接'}),true;
      if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))throw Error('需要JSON');
      let size=0;const chunks=[];for await(const b of req){size+=b.length;if(size>3500000)throw Error('请求过大');chunks.push(b);}const body=JSON.parse(Buffer.concat(chunks).toString());
      if(!body||typeof body!=='object'||Array.isArray(body))throw Error('无效参数');
      const route=pathname.split('/').at(-1);
      if(route==='pair'){
        if(!/^[a-p]{32}$/.test(body.extensionId)||!code||now()>codeExpires||!equal(body.code,code))return json(401,{error:'连接码无效或已过期，请在工作台重新获取'}),true;
        if(req.headers.origin&&req.headers.origin!==`chrome-extension://${body.extensionId}`)return json(403,{error:'扩展来源不一致'}),true;
        code=null;disconnect();token=randomBytes(32).toString('hex');extensionId=body.extensionId;protocol=[2,3].includes(body.protocol)?body.protocol:1;lastSeen=now();json(200,{token});return true;
      }
      if(!token||!equal(req.headers['x-job-extension-token'],token)||req.headers.origin&&req.headers.origin!==`chrome-extension://${extensionId}`)return json(401,{error:'扩展连接失效，请重新配对'}),true;
      lastSeen=now();
      if(route==='poll'){
        const tabs=Array.isArray(body.tabs)?body.tabs.slice(0,6).filter(t=>typeof t.id==='string'&&/^\d+$/.test(t.id)&&(siteForURL(t.url)&&(()=>{try{safeBrowserURL(t.url);return true;}catch{return false;}})()||t.url==='about:blank'&&siteForURL(t.lastURL))).map(t=>({id:t.id,url:t.url,title:String(t.title||'').slice(0,150),lastURL:siteForURL(t.lastURL)?t.lastURL:'',generation:Number(t.generation)||0,loading:!!t.loading,unexpectedBlank:t.url==='about:blank',navigationPaused:t.url==='about:blank',error:t.url==='about:blank'?'网页意外变为空白，插件已暂停；原因未确认，请人工核对':'',site:siteForURL(t.url)?.id||''})):[];
        const next={tabs,selectedTabId:tabs.some(t=>t.id===body.selectedTabId)?body.selectedTabId:null};
        if(state.selectedTabId!==next.selectedTabId||state.tabs.some(t=>{const n=tabs.find(n=>n.id===t.id);return !n||n.url!==t.url||n.generation!==t.generation;}))tickets.clear();state=next;
        if(waiter){clearTimeout(waiter.timer);waiter.resolve({command:null});waiter=null;}
        const queuedCommand=take();if(queuedCommand){json(200,{command:queuedCommand});return true;}
        const response=await new Promise(resolve=>{const timer=setTimeout(()=>{if(waiter?.resolve===resolve)waiter=null;resolve({command:null});},pollMs);waiter={resolve,timer};res.once('close',()=>{if(waiter?.resolve===resolve){clearTimeout(timer);waiter=null;resolve({command:null});}});});if(!res.destroyed)json(200,response);return true;
      }
      if(route==='result'){
        const p=pending.get(body.id);if(p&&p.delivered){pending.delete(body.id);clearTimeout(p.timer);body.error?p.reject(Error(String(body.error).replace(/sk-[\w.-]+/g,'[隐藏]').slice(0,500))):p.resolve(body.result);}json(200,{ok:true});return true;
      }
      json(404,{error:'接口不存在'});return true;
    }catch(e){if(!res.headersSent)json(400,{error:String(e.message).slice(0,300)});return true;}
  }
  return {status,command,handler,onboarding,dispose:()=>command('shutdown')};
}
