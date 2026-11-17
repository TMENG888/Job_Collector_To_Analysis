import {BrowserWindow,WebContentsView,session,ipcMain,Menu,shell} from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {checkedZoom,nextZoom,zoomShortcut} from './zoom.mjs';
import {checkedBaseURL,workspaceURL,isWorkspaceURL,workspaceViewForURL,isRecruitingURL,viewBounds,COMMANDS} from './policy.mjs';

const here=path.dirname(fileURLToPath(import.meta.url)),shellURL=pathToFileURL(path.join(here,'index.html')).href;
const preferences={nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,allowRunningInsecureContent:false,navigateOnDragDrop:false};

export async function createDesktop({runtime,baseURL=process.env.JOB_DESKTOP_BASE_URL||'http://127.0.0.1:8788',visible=true}={}){
  const base=checkedBaseURL(baseURL);
  const zoomFile=path.join(runtime,'workspace-zoom.json');
  let zoomFactor=1,zoomWrites=Promise.resolve();
  try{zoomFactor=checkedZoom(JSON.parse(await fs.readFile(zoomFile,'utf8')).factor);}catch{}
  const window=new BrowserWindow({width:1440,height:980,minWidth:1000,minHeight:680,show:false,title:'岗位工作台 · 桌面预览',backgroundColor:'#f5f7f8',webPreferences:{...preferences,preload:path.join(here,'preload.cjs')}});
  const localSession=session.fromPartition('persist:job-desktop-workspace-v1');
  localSession.setPermissionRequestHandler((_w,_p,done)=>done(false));localSession.setPermissionCheckHandler(()=>false);
  const workspace=new WebContentsView({webPreferences:{...preferences,session:localSession,preload:path.join(here,'workspace-preload.cjs')}});
  window.contentView.addChildView(workspace);
  let workspaceRoute='insights',workspaceStatus='loading',workspaceError='',workspaceTimer=null,disposed=false;
  function state(){return {version:'0.2.0',mode:'workspace',workspaceRoute,workspaceStatus,workspaceError,zoomFactor,baseURL:base,tabs:[]};}
  function emit(){if(!disposed&&!window.isDestroyed())window.webContents.send('job-desktop:state',state());}
  function layout(){if(window.isDestroyed())return;const [width,height]=window.getContentSize();workspace.setVisible(workspaceStatus!=='error');workspace.setBounds(viewBounds(width,height,'workspace',zoomFactor));}
  function applyZoom(){for(const content of [window.webContents,workspace.webContents])if(!content.isDestroyed())content.setZoomFactor(zoomFactor);layout();}
  function changeZoom(direction){
    zoomFactor=nextZoom(zoomFactor,direction);applyZoom();emit();
    const value=JSON.stringify({factor:zoomFactor});
    zoomWrites=zoomWrites.then(async()=>{await fs.mkdir(runtime,{recursive:true});await fs.writeFile(zoomFile,value);}).catch(()=>{});
  }
  for(const content of [window.webContents,workspace.webContents]){
    content.on('before-input-event',(event,input)=>{const action=zoomShortcut(input);if(action){event.preventDefault();changeZoom(action);}});
    content.on('zoom-changed',(_event,direction)=>changeZoom(direction));
    content.on('did-finish-load',applyZoom);
  }
  function failed(message){clearTimeout(workspaceTimer);workspaceStatus='error';workspaceError=message;layout();emit();}
  function loading(){clearTimeout(workspaceTimer);workspaceStatus='loading';workspaceError='';layout();emit();workspaceTimer=setTimeout(()=>failed('本地页面加载超时，请检查后台服务后重试'),20000);}
  function load(url){loading();workspace.webContents.loadURL(url).catch(error=>{if(error.code!=='ERR_ABORTED')failed('本地页面连接失败，请检查后台服务后重试');});}
  function syncView(view){if(['tasks','insights','matching','assistant'].includes(view)){workspaceRoute=view;emit();}}
  function syncURL(url){if(isWorkspaceURL(url,base)&&/^\/browser(?:\/|$)/.test(new URL(url).pathname)){workspaceRoute='tasks';load(workspaceURL(base,'tasks'));return;}syncView(workspaceViewForURL(url,base));}
  async function command(name,value={}){
    if(!COMMANDS.has(name)||!value||typeof value!=='object'||Array.isArray(value)||JSON.stringify(value).length>4096)throw Error('不支持的桌面操作');
    if(name==='state')return state();
    const url=workspaceURL(base,value.route);workspaceRoute=value.route;
    if(value.retry||workspaceStatus==='error'||workspace.webContents.getURL()!==url)load(url);else emit();
    return state();
  }
  ipcMain.handle('job-desktop:command',async(event,name,value)=>{
    if(event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame||event.senderFrame.url!==shellURL)return {ok:false,error:'该页面无权调用桌面功能'};
    try{return {ok:true,value:await command(name,value)};}catch(error){return {ok:false,error:String(error.message).slice(0,350)};}
  });
  const openExternal=url=>{if(isRecruitingURL(url))void shell.openExternal(url).catch(()=>{});};
  workspace.webContents.setWindowOpenHandler(({url})=>{openExternal(url);return {action:'deny'};});
  workspace.webContents.on('will-navigate',(event,url)=>{url=event.url||url;if(isWorkspaceURL(url,base))return;event.preventDefault();openExternal(url);});
  workspace.webContents.on('will-redirect',(event,url)=>{if(!isWorkspaceURL(event.url||url,base))event.preventDefault();});
  workspace.webContents.on('did-navigate',(event,url)=>syncURL(event.url||url));
  workspace.webContents.on('did-navigate-in-page',(event,url,isMainFrame)=>{if(event.isMainFrame??isMainFrame)syncURL(event.url||url);});
  const onWorkspaceView=(event,view)=>{
    if(event.sender!==workspace.webContents||event.senderFrame!==workspace.webContents.mainFrame||!isWorkspaceURL(event.senderFrame.url,base))return;
    if(!['tasks','insights','matching','assistant'].includes(view))return;
    clearTimeout(workspaceTimer);workspaceStatus='ready';workspaceError='';layout();syncView(view);
  };
  ipcMain.on('job-desktop:workspace-view',onWorkspaceView);
  workspace.webContents.on('did-start-navigation',(event,_url,inPlace,isMainFrame)=>{if((event.isMainFrame??isMainFrame)&&!(event.isSameDocument??event.isInPlace??inPlace))loading();});
  workspace.webContents.on('did-fail-load',(_event,code,_description,_url,isMainFrame)=>{if(isMainFrame&&code!==-3)failed(`本地页面加载失败（${code}），请检查后台服务后重试`);});
  workspace.webContents.on('render-process-gone',()=>failed('本地页面进程已退出，请点击重新加载'));
  window.webContents.on('will-navigate',event=>event.preventDefault());window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.on('resize',layout);
  window.on('closed',()=>{disposed=true;clearTimeout(workspaceTimer);ipcMain.removeHandler('job-desktop:command');ipcMain.removeListener('job-desktop:workspace-view',onWorkspaceView);if(!workspace.webContents.isDestroyed())workspace.webContents.close();});
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {label:'编辑',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},
    {label:'查看',submenu:[{label:'刷新当前页面',accelerator:'F5',click:()=>workspace.webContents.reload()},{type:'separator'},{id:'workspace-zoom-in',label:'放大',accelerator:'CommandOrControl+=',click:()=>changeZoom('in')},{id:'workspace-zoom-out',label:'缩小',accelerator:'CommandOrControl+-',click:()=>changeZoom('out')},{id:'workspace-zoom-reset',label:'恢复 100%',accelerator:'CommandOrControl+0',click:()=>changeZoom('reset')},{type:'separator'},{role:'togglefullscreen'}]},
    {label:'窗口',submenu:[{role:'minimize'},{role:'close'}]}
  ]));
  await window.loadFile(path.join(here,'index.html'));load(workspaceURL(base,workspaceRoute));applyZoom();emit();if(visible)window.show();
  return {window,workspace,command,state,runtime};
}
