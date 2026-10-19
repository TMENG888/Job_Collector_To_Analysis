import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {writeJsonAtomic} from './collector_storage.mjs';

export const browserModes=['extension','native','embedded'];
export function validateBrowserSettings(value){
  if(!value||!browserModes.includes(value.mode)||!['chrome','edge','configured'].includes(value.browserId))throw Error('请选择有效的浏览器和交互模式');
  if(Object.keys(value).some(key=>!['mode','browserId'].includes(key)))throw Error('不接受自定义可执行文件或登录目录');
  return {mode:value.mode,browserId:value.browserId};
}
// Only installed, known vendor paths or an operator-provided environment setting.
// A recruiting page or HTTP caller cannot nominate an executable to run.
export function createJobBrowserManager(runtimeDir,{env=process.env,stat=fs.stat}={}){
  const file=path.join(runtimeDir,'browser-settings.json');
  const definitions=[
    {id:'chrome',name:'Google Chrome',paths:['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',path.join(os.homedir(),'AppData/Local/Google/Chrome/Application/chrome.exe')]},
    {id:'edge',name:'Microsoft Edge',paths:['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe']},
    ...(env.JOB_WORKSPACE_BROWSER_EXE?[{id:'configured',name:'管理员配置的浏览器',paths:[env.JOB_WORKSPACE_BROWSER_EXE]}]:[]),
  ];
  async function inventory(){return Promise.all(definitions.map(async item=>{
    for(const candidate of item.paths){if(await stat(candidate).then(s=>s.isFile()).catch(()=>false))return {id:item.id,name:item.name,available:true,executable:candidate};}
    return {id:item.id,name:item.name,available:false,executable:''};
  }));}
  async function read(){
    try{return validateBrowserSettings(JSON.parse(await fs.readFile(file,'utf8')));}
    catch(error){if(error.code!=='ENOENT')throw Error('浏览器配置不可读取，未自动覆盖；请检查 browser-settings.json');}
    const installed=await inventory();
    return {mode:'extension',browserId:env.JOB_WORKSPACE_BROWSER_EXE?'configured':installed.find(b=>b.available)?.id||'chrome'};
  }
  function profileFor(settings){
    // Preserve the legacy Chrome profile in place; Edge must never open Chrome's data.
    if(settings.mode==='embedded'&&settings.browserId==='chrome')return path.join(runtimeDir,'profile');
    return path.join(runtimeDir,'profiles',settings.mode,settings.browserId);
  }
  async function status(){const settings=await read();return {settings,browsers:await inventory(),profileDir:profileFor(settings)};}
  async function resolve(){
    const configuration=await status(),browser=configuration.browsers.find(b=>b.id===configuration.settings.browserId);
    if(!browser?.available)throw Error('所选浏览器未安装或不可用；请选择其他浏览器，不会静默切换');
    return {...configuration.settings,executable:browser.executable,profileDir:configuration.profileDir};
  }
  async function save(value){
    const settings=validateBrowserSettings(value),browser=(await inventory()).find(b=>b.id===settings.browserId);
    if(!browser?.available)throw Error('所选浏览器未安装或不可用');
    await fs.mkdir(runtimeDir,{recursive:true});
    await writeJsonAtomic(file,settings);return status();
  }
  return {inventory,read,status,resolve,save,profileFor};
}
