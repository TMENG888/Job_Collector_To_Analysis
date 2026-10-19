import {pageOperation} from './dom.mjs';
const base='http://127.0.0.1:8788/api/browser/extension/';
const domains=['zhipin.com','liepin.com','zhaopin.com','51job.com','iguopin.com','shixiseng.com'];
const valid=value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.port&&!u.username&&!u.password&&domains.some(d=>u.hostname===d||u.hostname.endsWith('.'+d));}catch{return false;}};
const clean=value=>{const u=new URL(value);for(const key of [...u.searchParams.keys()])if(!['id','jobId','positionId','securityId'].includes(key))u.searchParams.delete(key);u.hash='';return u.href;};
const generations=new Map(),known=new Map(),frames=new Map();let polling=false,lastCapture=0;
chrome.tabs.onUpdated.addListener((id,info)=>{if(info.status==='loading'||info.url)generations.set(id,(generations.get(id)||0)+1);});
chrome.tabs.onUpdated.addListener((id,info)=>{if(info.url)void(async()=>{const {mirrorGrant}=await chrome.storage.session.get('mirrorGrant');if(mirrorGrant?.tabId===id&&(!valid(info.url)||new URL(info.url).origin!==mirrorGrant.origin)){frames.delete(id);await chrome.storage.session.remove('mirrorGrant');}})();});
chrome.tabs.onRemoved.addListener(id=>{generations.delete(id);known.delete(id);frames.delete(id);});
chrome.tabs.onRemoved.addListener(id=>{void(async()=>{const {mirrorGrant}=await chrome.storage.session.get('mirrorGrant');if(mirrorGrant?.tabId===id)await chrome.storage.session.remove('mirrorGrant');})();});
async function page(id,args){const r=await chrome.scripting.executeScript({target:{tabId:id},world:'ISOLATED',func:pageOperation,args:[{...args,__localJobEnvelope:true}]});const result=r[0]?.result;if(result?.__localJobError)throw Error(result.__localJobError);if(!result)throw Error('页面执行中断，结果未知；请核对原窗口，不自动重试');return result;}
async function mirror(method,tab,args){
  const {mirrorGrant}=await chrome.storage.session.get('mirrorGrant');
  if(!mirrorGrant||mirrorGrant.tabId!==tab.id||mirrorGrant.origin!==new URL(tab.url).origin)throw Error('请在目标招聘标签点击扩展，再授权当前页镜像与交互');
  if(!tab.active)throw Error('目标招聘页不是活动标签，停止镜像');
  if(method==='mirror-input'){
    const f=(frames.get(tab.id)||[]).find(f=>f.id===args.frameId);frames.delete(tab.id);
    if(!f||f.id!==args.frameId||Date.now()-f.at>3500||f.url!==tab.url||f.generation!==(generations.get(tab.id)||0))throw Error('画面已过期或页面变化，请等待新画面后操作');
    return page(tab.id,{op:'mirror-input',expected:f.viewport,input:args.input});
  }
  if(Date.now()-lastCapture<650)throw Error('镜像采样过快，请稍候');lastCapture=Date.now();
  const generation=generations.get(tab.id)||0,before=await page(tab.id,{op:'viewport'});
  const dataURL=await chrome.tabs.captureVisibleTab(tab.windowId,{format:'jpeg',quality:65});
  const afterTab=await chrome.tabs.get(tab.id),current=await snapshot(),after=await page(tab.id,{op:'viewport'});
  const geometry=v=>JSON.stringify([v.documentId,v.url,v.width,v.height,v.dpr,v.scroll,v.panels]);
  if(current.selectedTabId!==String(tab.id)||afterTab.url!==tab.url||generation!==(generations.get(tab.id)||0)||geometry(before)!==geometry(after))throw Error('截图期间网页发生变化，请等待页面稳定');
  // Only targets unchanged throughout capture may receive coordinate input.
  const oldTargets=new Map(before.targets.map(t=>[t.id,JSON.stringify(t)]));
  after.targets=after.targets.filter(t=>oldTargets.get(t.id)===JSON.stringify(t));
  if(before.focus!==after.focus)after.focus=null;
  if(dataURL.length>3*1024*1024)throw Error('镜像画面过大');
  const f={id:crypto.randomUUID(),at:Date.now(),url:tab.url,generation,viewport:after};frames.set(tab.id,[...(frames.get(tab.id)||[]).filter(f=>Date.now()-f.at<=3500),f].slice(-3));
  return {frameId:f.id,tabId:String(tab.id),width:after.width,height:after.height,dataURL};
}
async function api(route,body,token){const response=await fetch(base+route,{method:'POST',headers:{'content-type':'application/json','x-job-extension-token':token||''},body:JSON.stringify(body),signal:AbortSignal.timeout(25000)});const value=await response.json();if(!response.ok)throw Object.assign(Error(value.error||'本机连接失败'),{status:response.status});return value;}
async function snapshot(){
  const all=await chrome.tabs.query({}),win=await chrome.windows.getLastFocused();
  const current=all.find(t=>t.windowId===win.id&&t.active);
  const tabs=all.filter(t=>valid(t.url)||t.url==='about:blank'&&known.has(t.id)).sort((a,b)=>Number(b.id===current?.id)-Number(a.id===current?.id)).slice(0,6).map(t=>{
    if(valid(t.url))known.set(t.id,t.url);
    return {id:String(t.id),url:t.url,title:t.title||'',lastURL:known.get(t.id)||'',generation:generations.get(t.id)||0,loading:t.status==='loading',unexpectedBlank:t.url==='about:blank'};
  });
  return {tabs,selectedTabId:tabs.some(t=>t.id===String(current?.id))?String(current.id):null};
}
async function run(command){
  const {method,args={}}=command;
  if(method==='disconnect'){frames.clear();await chrome.storage.session.remove(['connection','mirrorGrant']);return {ok:true};}
  if(method==='new-tab'){if(!valid(args.url))throw Error('请指定招聘网站HTTPS地址');const tab=await chrome.tabs.create({url:args.url});return {ok:true,tabId:String(tab.id)};}
  const id=Number(args.tabId);if(!Number.isSafeInteger(id)||id<0)throw Error('请先在普通浏览器选择招聘网站标签');
  const tab=await chrome.tabs.get(id);
  if(!valid(tab.url)&&!(tab.url==='about:blank'&&known.has(id)))throw Error('目标标签不是招聘网站');
  if(['select','focus'].includes(method)){await chrome.tabs.update(id,{active:true});await chrome.windows.update(tab.windowId,{focused:true});return {ok:true};}
  if(method==='navigate'){if(!valid(args.url))throw Error('无效招聘网站地址');await chrome.tabs.update(id,{url:args.url});return {ok:true};}
  if(method==='reload'){await chrome.tabs.reload(id);return {ok:true};}
  if(method==='back'){await chrome.tabs.goBack(id);return {ok:true};}
  if(method==='forward'){await chrome.tabs.goForward(id);return {ok:true};}
  if(method==='close-tab'){await chrome.tabs.remove(id);return {ok:true};}
  const current=await snapshot();if(current.selectedTabId!==String(id))throw Error('浏览器当前标签已变化，请重新核对');
  if(!valid(tab.url))throw Error('网页已变为空白，请手动检查，不执行插件');
  if(['mirror-frame','mirror-input'].includes(method))return mirror(method,tab,args);
  if(['delivery-context','delivery-message','delivery-image'].includes(method))return page(id,{op:method,job:args.job,binding:args.binding,body:args.message,image:args.image});
  const op=method==='plugin'?args.id:method==='prepare-action'?'prepare':method==='confirm-action'?'confirm':method==='cancel-action'?'cancel':null;
  if(!['read-detail','collect-page','prepare','confirm','cancel'].includes(op))throw Error('不支持的插件命令');
  const result=await page(id,{op,kind:args.kind,body:args.message,ticketId:args.ticketId});
  if(result.rows)result.rows=result.rows.filter(r=>valid(r.url)).map(r=>({...r,url:clean(r.url),source:'browser-extension-visible-dom',capturedAt:new Date().toISOString()}));
  if(result.job){result.job.url=clean(result.job.url);const bytes=new TextEncoder().encode(JSON.stringify([result.job.url,result.job.title,result.job.company,result.job.description]));result.fingerprint=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');}
  return result;
}
async function loop(){
  if(polling)return;polling=true;let requestToken=null;
  try{
    while(true){
      const {connection}=await chrome.storage.session.get('connection');if(!connection)return;
      requestToken=connection.token;
      const response=await api('poll',await snapshot(),connection.token);
      if(!response.command)continue;
      let result,error;try{result=await run(response.command);}catch(e){error=e.message.slice(0,500);}
      // A command is delivered once. Never retry an uncertain action/result POST.
      await api('result',{id:response.command.id,result,error},connection.token);
    }
  }catch(e){const {connection}=await chrome.storage.session.get('connection');if(e.status===401&&connection?.token===requestToken)await chrome.storage.session.remove('connection');await chrome.storage.local.set({lastError:e.status===401?'连接已过期，请重新连接工作台':'本机连接中断；不会重试已下发的操作'});}
  finally{polling=false;}
}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  // Only our own popup/extension pages; no website content scripts are installed.
  if(sender.id!==chrome.runtime.id)return;
  (async()=>{
    if(message.kind==='pair'){
      const value=await api('pair',{code:message.code,extensionId:chrome.runtime.id,protocol:3});frames.clear();await chrome.storage.session.remove('mirrorGrant');await chrome.storage.session.set({connection:{token:value.token}});void loop();return {ok:true};
    }
    if(message.kind==='disconnect'){frames.clear();await chrome.storage.session.remove(['connection','mirrorGrant']);return {ok:true};}
    if(message.kind==='authorize'){
      const {connection}=await chrome.storage.session.get('connection');if(!connection)throw Error('请先连接工作台');
      const [tab]=await chrome.tabs.query({active:true,currentWindow:true});if(!tab||!valid(tab.url))throw Error('请先切换到招聘网站标签，再点击扩展');
      await chrome.storage.session.set({mirrorGrant:{tabId:tab.id,origin:new URL(tab.url).origin}});frames.clear();return {ok:true,tabId:tab.id};
    }
    if(message.kind==='revoke'){frames.clear();await chrome.storage.session.remove('mirrorGrant');return {ok:true};}
    if(message.kind==='status'){const {connection}=await chrome.storage.session.get('connection');return {connected:!!connection};}
    throw Error('未知操作');
  })().then(respond,e=>respond({error:e.message}));return true;
});
chrome.alarms.create('bridge-heartbeat',{periodInMinutes:.5});
chrome.alarms.onAlarm.addListener(()=>{void loop();});
void loop();
