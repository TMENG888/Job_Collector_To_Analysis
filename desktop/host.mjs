import {app, BrowserWindow, WebContentsView, session, ipcMain, Menu} from 'electron';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {browserSites,checkedBaseURL,workspaceURL,isWorkspaceURL,workspaceViewForURL,isRecruitingURL,recruitingURL,allowRecruitingResource,navigationDecision,viewBounds,MAX_TABS,COMMANDS} from './policy.mjs';
import {readBrowserPlugin} from '../work/job-browser-plugins.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const shellURL = pathToFileURL(path.join(here,'index.html')).href;
const preferences = {nodeIntegration:false, contextIsolation:true, sandbox:true, webSecurity:true, allowRunningInsecureContent:false, navigateOnDragDrop:false};
const isSameSite=(value,site)=>{const host=new URL(value).hostname;return host===site.domain||host.endsWith('.'+site.domain);};

export async function createDesktop({runtime, baseURL=process.env.JOB_DESKTOP_BASE_URL || 'http://127.0.0.1:8788', visible=true, setupSession, screening:injectedScreening}={}) {
  const base = checkedBaseURL(baseURL);
  const window = new BrowserWindow({width:1440,height:980,minWidth:1000,minHeight:680,show:false,title:'岗位工作台 · 桌面预览',backgroundColor:'#f5f7f8',webPreferences:{...preferences,preload:path.join(here,'preload.cjs')}});
  const tabs = new Map(), usedSessions = new Set();
  let mode='workspace', workspaceRoute='insights', selectedId=null, notice='', disposed=false, reading=false, currentRead=null;
  let screening=injectedScreening;
  const localSession = session.fromPartition('persist:job-desktop-workspace-v1');
  localSession.setPermissionRequestHandler((_w,_p,done) => done(false));
  localSession.setPermissionCheckHandler(() => false);
  const workspace = new WebContentsView({webPreferences:{...preferences,session:localSession,preload:path.join(here,'workspace-preload.cjs')}});
  window.contentView.addChildView(workspace);

  function state() {
    return {version:'0.1.0',mode,workspaceRoute,selectedId,reading,notice,baseURL:base,
      sites:browserSites.map(({id,name,url})=>({id,name,url})),
      tabs:[...tabs.values()].map(t=>({id:t.id,site:t.site,title:t.title,url:t.view.webContents.getURL(),loading:t.loading,error:t.error,back:t.view.webContents.navigationHistory.canGoBack(),forward:t.view.webContents.navigationHistory.canGoForward()}))};
  }
  function emit(message) {if (message!==undefined) notice=String(message).slice(0,350);if(!disposed&&!window.isDestroyed()) window.webContents.send('job-desktop:state',state());}
  function layout() {
    if (window.isDestroyed()) return;
    const [width,height]=window.getContentSize();
    workspace.setVisible(mode==='workspace');
    if(mode==='workspace') workspace.setBounds(viewBounds(width,height,mode));
    for(const tab of tabs.values()) {const shown=mode==='browser'&&tab.id===selectedId&&!(tab.error&&!isRecruitingURL(tab.view.webContents.getURL()));tab.view.setVisible(shown);if(shown)tab.view.setBounds(viewBounds(width,height,mode));}
  }
  function current() {const tab=tabs.get(selectedId);if(!tab)throw Error('请先打开招聘网站');return tab;}
  function setMode(value) {mode=value;layout();emit();}
  function syncWorkspaceView(view) {
    if(view==='browser'){setMode('browser');return;}
    if(['tasks','insights','assistant'].includes(view)) {workspaceRoute=view;emit();}
  }
  function syncWorkspaceURL(value) {syncWorkspaceView(workspaceViewForURL(value,base));}
  function visibleFocus() {if(mode==='browser'&&tabs.has(selectedId))current().view.webContents.focus();else if(mode==='workspace')workspace.webContents.focus();}

  // Untrusted sites have no preload or IPC. No browser flags, UA overrides or CDP.
  async function siteSession(site) {
    const ses=session.fromPartition('persist:job-desktop-'+site+'-v1');
    if(!usedSessions.has(ses)) {
      usedSessions.add(ses);
      ses.setPermissionRequestHandler((_w,_permission,done)=>done(false));
      ses.setPermissionCheckHandler(()=>false);
      ses.setDevicePermissionHandler(()=>false);
      ses.on('will-download',(event)=>{event.preventDefault();emit('桌面预览版未启用下载；请使用普通浏览器下载文件');});
      ses.webRequest.onBeforeRequest((details,done)=>done({cancel:!allowRecruitingResource(details.url)}));
      // Test hook runs only in the main process, never reachable by IPC or websites.
      if(setupSession) await setupSession(ses);
    }
    return ses;
  }
  async function open(value, {activate=true}={}) {
    const url=recruitingURL(value);
    if(tabs.size>=MAX_TABS) throw Error('最多打开8个招聘标签，请先关闭不用的页面');
    const site=browserSites.find(s=>new URL(url).hostname===s.domain||new URL(url).hostname.endsWith('.'+s.domain));
    const ses=await siteSession(site.id);
    if(disposed)throw Error('桌面窗口已关闭');
    const view=new WebContentsView({webPreferences:{...preferences,session:ses}});
    const tab={id:randomUUID(),view,site:site.id,title:site.name,loading:true,error:null,generation:0};
    tabs.set(tab.id,tab);window.contentView.addChildView(view);
    const wc=view.webContents;
    const guard=(event,target)=>{
      const targetURL=event.url||(typeof target==='string'?target:target?.url);
      if(navigationDecision(targetURL)!=='allow') {event.preventDefault();emit('页面试图跳转到未接入地址，已保留当前页面；不会自动退回空白页');}
      else if(!isSameSite(targetURL,site)) {event.preventDefault();setImmediate(()=>open(targetURL).catch(e=>emit(e.message)));}
    };
    wc.on('will-navigate',guard);wc.on('will-redirect',guard);
    wc.on('will-frame-navigate',event=>{if(event.isMainFrame)guard(event,event.url);});
    wc.setWindowOpenHandler(({url:target})=>{
      if(isRecruitingURL(target)) setImmediate(()=>{open(target).catch(e=>emit(e.message));});
      else emit('该弹窗地址尚未接入，请使用普通浏览器处理外部登录');
      return {action:'deny'};
    });
    wc.on('did-start-navigation',(event,url,_inPlace,isMainFrame)=>{
      if(event.isMainFrame??isMainFrame){
        tab.generation++;if(currentRead?.tabId===tab.id)currentRead=null;
        // Chromium fast-paths about: navigation without will-navigate. Do not
        // call stop() in that synchronous callback (Chromium can re-enter/crash).
        // Surface the actual state after commit; never run an automatic reload.
      }
    });
    wc.on('did-start-loading',()=>{tab.loading=true;tab.error=null;emit();});
    wc.on('did-stop-loading',()=>{tab.loading=false;emit();});
    wc.on('did-navigate',(_event,url)=>{
      if(!isRecruitingURL(url)){tab.error='网站打开了空白或未接入页面，请手动返回或改用普通浏览器';tab.loading=false;layout();emit(tab.error);}
      else {tab.error=null;layout();emit();}
    });wc.on('did-navigate-in-page',()=>emit());
    wc.on('page-title-updated',(_e,title)=>{tab.title=String(title).slice(0,120);emit();});
    wc.on('did-fail-load',(_e,code,description,_url,isMainFrame)=>{if(isMainFrame&&code!==-3){tab.error=`页面加载失败（${code}）：${description}`;tab.loading=false;emit(tab.error+'；未自动重试');}});
    wc.on('render-process-gone',()=>{tab.error='页面进程已退出，请手动重新加载';tab.loading=false;currentRead=null;emit(tab.error);});
    if(activate){selectedId=tab.id;mode='browser';}
    layout();emit('');
    // Do not await network loading in IPC or retry automatically on failure.
    wc.loadURL(url).catch(()=>{});
    return tab.id;
  }
  function close(id) {
    const tab=tabs.get(id);if(!tab)throw Error('标签页不存在');
    if(currentRead?.tabId===id)currentRead=null;
    tabs.delete(id);window.contentView.removeChildView(tab.view);tab.view.webContents.close();
    if(selectedId===id)selectedId=[...tabs.keys()].at(-1)||null;
    layout();emit();
  }
  async function models() {
    if(!screening) {
      const [{createBrowserScreening},{createInsightSupervised}]=await Promise.all([import('../work/job-browser-screening.mjs'),import('../work/insight-supervised.mjs')]);
      const dataDir=process.env.JOB_UI_DATA_DIR||path.resolve(here,'../ui_data');
      screening=createBrowserScreening({supervised:createInsightSupervised(dataDir)});
    }
    return screening.catalog();
  }
  async function read(id) {
    if(reading)throw Error('正在读取，请稍候');
    if(!['read-detail','collect-page'].includes(id))throw Error('仅支持读取当前详情或当前页岗位');
    const tab=current(),wc=tab.view.webContents,generation=tab.generation;
    if(tab.loading)throw Error('页面仍在加载，请稍后手动重试');
    const url=wc.getURL();recruitingURL(url);
    reading=true;currentRead=null;emit('');
    const evaluate=(fn,arg)=>wc.executeJavaScript(`(${fn.toString()})(${JSON.stringify(arg)??''})`);
    const adapter={url:()=>url,evaluate,locator:selector=>({evaluateAll:fn=>wc.executeJavaScript(`(${fn.toString()})(Array.from(document.querySelectorAll(${JSON.stringify(selector)})))`)})};
    try {
      const rows=await Promise.race([readBrowserPlugin(adapter,id),new Promise((_,reject)=>setTimeout(()=>reject(Error('页面读取超时；未自动重试')),8000).unref())]);
      if(!tabs.has(tab.id)||selectedId!==tab.id||tab.generation!==generation||wc.getURL()!==url)throw Error('读取期间页面已变化，请重新读取');
      const result={tabId:tab.id,generation,url,rows:rows.map(row=>({...row,source:'desktop-native-visible-dom'}))};
      currentRead=result;return result;
    } finally {reading=false;emit();}
  }
  async function command(name,value={}) {
    if(!COMMANDS.has(name)||!value||typeof value!=='object'||Array.isArray(value)||JSON.stringify(value).length>4096)throw Error('无效桌面操作');
    if(name==='state')return state();
    if(name==='workspace'){const url=workspaceURL(base,value.route);workspaceRoute=value.route;setMode('workspace');if(workspace.webContents.getURL()!==url)workspace.webContents.loadURL(url).catch(()=>{});return state();}
    if(name==='browser'){setMode('browser');return state();}
    if(name==='open') {const site=browserSites.find(s=>s.id===value.site);return {id:await open(value.url||site?.url)};}
    if(name==='select'){if(!tabs.has(value.id))throw Error('标签页不存在');selectedId=value.id;currentRead=null;setMode('browser');visibleFocus();return state();}
    if(name==='close'){close(value.id);return state();}
    if(name==='navigate'){const url=recruitingURL(value.url),tab=current(),site=browserSites.find(s=>s.id===tab.site);if(!isSameSite(url,site))return {id:await open(url)};tab.view.webContents.loadURL(url).catch(()=>{});return state();}
    if(['back','forward','reload','stop'].includes(name)) {
      const wc=current().view.webContents;
      if(name==='back'&&wc.navigationHistory.canGoBack())wc.navigationHistory.goBack();
      if(name==='forward'&&wc.navigationHistory.canGoForward())wc.navigationHistory.goForward();
      if(name==='reload')wc.reload();if(name==='stop')wc.stop();
      return state();
    }
    if(name==='read')return read(value.plugin);
    if(name==='models')return {models:await models()};
    if(name==='classify'){
      const tab=current();
      if(tab.loading||!currentRead||currentRead.tabId!==tab.id||currentRead.generation!==tab.generation||currentRead.url!==tab.view.webContents.getURL()||currentRead.rows.length!==1||currentRead.rows[0].description.length<30)throw Error('请先读取当前完整岗位详情');
      await models();
      const result=await screening.screen(String(value.modelId),currentRead.rows[0]);
      if(currentRead?.tabId!==tab.id||currentRead.generation!==tab.generation)throw Error('分类期间页面已变化，结果已作废');
      return {job:currentRead.rows[0].title,result};
    }
  }

  ipcMain.handle('job-desktop:command',async(event,name,value)=>{
    // Identity + main-frame + exact file URL: local service and recruiting frames have no host authority.
    if(event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame||event.senderFrame.url!==shellURL)return {ok:false,error:'该页面无权调用桌面功能'};
    try{return {ok:true,value:await command(name,value)};}catch(e){return {ok:false,error:String(e.message).slice(0,350)};}
  });
  workspace.webContents.setWindowOpenHandler(({url})=>{if(isRecruitingURL(url))setImmediate(()=>open(url).catch(e=>emit(e.message)));return {action:'deny'};});
  workspace.webContents.on('will-navigate',(event,url)=>{
    url=event.url||url;
    if(isWorkspaceURL(url,base)) {
      if(new URL(url).pathname==='/browser'){event.preventDefault();setMode('browser');}
      return;
    }
    event.preventDefault();if(isRecruitingURL(url))void open(url).catch(e=>emit(e.message));
  });
  workspace.webContents.on('will-redirect',(event,url)=>{if(!isWorkspaceURL(event.url||url,base))event.preventDefault();});
  // The existing UI also navigates with pushState: route its browser nav to
  // native contents instead of the old screenshot workspace.
  workspace.webContents.on('did-navigate',(event,url)=>syncWorkspaceURL(event.url||url));
  workspace.webContents.on('did-navigate-in-page',(event,url,isMainFrame)=>{if(event.isMainFrame??isMainFrame)syncWorkspaceURL(event.url||url);});
  const onWorkspaceView=(event,view)=>{
    if(event.sender!==workspace.webContents||event.senderFrame!==workspace.webContents.mainFrame||!isWorkspaceURL(event.senderFrame.url,base))return;
    syncWorkspaceView(view);
  };
  ipcMain.on('job-desktop:workspace-view',onWorkspaceView);
  workspace.webContents.on('did-fail-load',(_e,code,_description,_url,isMainFrame)=>{if(isMainFrame&&code!==-3)emit('本地服务未连接。请先启动原岗位服务，再点击任务或洞察重连；招聘浏览器可独立使用');});
  window.webContents.on('will-navigate',event=>event.preventDefault());
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.on('resize',layout);
  window.on('closed',()=>{
    disposed=true;ipcMain.removeHandler('job-desktop:command');
    ipcMain.removeListener('job-desktop:workspace-view',onWorkspaceView);
    for(const tab of tabs.values())if(tab.view.webContents&&!tab.view.webContents.isDestroyed())tab.view.webContents.close();
    tabs.clear();if(workspace.webContents&&!workspace.webContents.isDestroyed())workspace.webContents.close();
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {label:'编辑',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},
    {label:'查看',submenu:[{label:'刷新当前页面',accelerator:'F5',click:()=>{if(mode==='browser'&&tabs.has(selectedId))current().view.webContents.reload();else workspace.webContents.reload();}},{label:'返回',accelerator:'Alt+Left',click:()=>{if(mode==='browser'&&tabs.has(selectedId))void command('back');}},{label:'前进',accelerator:'Alt+Right',click:()=>{if(mode==='browser'&&tabs.has(selectedId))void command('forward');}},{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'},{role:'togglefullscreen'}]},
    {label:'窗口',submenu:[{role:'minimize'},{role:'close'}]}
  ]));
  await window.loadFile(path.join(here,'index.html'));
  workspace.webContents.loadURL(workspaceURL(base,workspaceRoute)).catch(()=>{});
  layout();emit();
  if(visible)window.show();
  return {window,workspace,tabs,command,state,open,runtime};
}
