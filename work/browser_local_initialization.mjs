import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {writeJsonAtomic} from './collector_storage.mjs';

const exec=promisify(execFile);
const defaultConfig=fileURLToPath(new URL('../ui_data/browser_sources.json',import.meta.url));
export async function readBrowserSources(){
  if(process.env.JOB_BROWSER_SOURCE_CONFIG==='none')return {};
  try{return JSON.parse(await fs.readFile(process.env.JOB_BROWSER_SOURCE_CONFIG||defaultConfig,'utf8'));}
  catch(error){if(error.code==='ENOENT')return {};throw error;}
}
const excluded=new Set(['Cache','Code Cache','GPUCache','DawnCache','GrShaderCache','ShaderCache','Crashpad','BrowserMetrics','Sessions','SingletonLock','SingletonCookie','SingletonSocket','LOCK','lockfile','DevToolsActivePort']);
function copyFilter(source){return !excluded.has(path.basename(source));}
async function sourceBrowserRunning(source){
  if(process.platform!=='win32'||!source.source_executable)return false;
  const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',"@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:JOB_SOURCE_EXECUTABLE -and $_.CommandLine -notmatch '--type=' -and $_.CommandLine -notmatch '--user-data-dir' }).Count"],{env:{...process.env,JOB_SOURCE_EXECUTABLE:source.source_executable},windowsHide:true,timeout:15000,maxBuffer:16384});
  return Number(stdout.trim())>0;
}
export async function prepareLocalProfileSeed(source){
  const marker=path.join(source.seed_dir,'.source-snapshot.json');
  const existing=await fs.readFile(marker,'utf8').then(JSON.parse).catch(()=>null);
  if(existing?.source_root===source.source_root&&existing?.source_profile===(source.source_profile||'Default'))return existing;
  if(await sourceBrowserRunning(source))throw Error('请先正常退出日常 Edge（含后台运行），保存 Default 配置后再初始化；原窗口和原数据不会被强制关闭或修改');
  const name=source.source_profile||'Default';
  if(!/^(Default|Profile \d+)$/.test(name))throw Error('无效的本机配置名称');
  if(path.resolve(source.seed_dir)===path.resolve(source.source_root))throw Error('配置快照目录不能与来源目录相同');
  const staging=source.seed_dir+'.preparing-'+randomUUID();
  await fs.mkdir(path.dirname(staging),{recursive:true});
  await fs.mkdir(staging);
  await fs.cp(path.join(source.source_root,name),path.join(staging,'Default'),{recursive:true,filter:copyFilter});
  const localState=JSON.parse(await fs.readFile(path.join(source.source_root,'Local State'),'utf8'));
  localState.profile={...localState.profile,last_used:'Default',last_active_profiles:['Default'],info_cache:{Default:localState.profile?.info_cache?.[name]||{}}};
  await writeJsonAtomic(path.join(staging,'Local State'),localState);
  const prefsPath=path.join(staging,'Default','Preferences');
  const prefs=JSON.parse(await fs.readFile(prefsPath,'utf8'));
  prefs.session={...prefs.session,restore_on_startup:5,startup_urls:[]};
  prefs.homepage='about:blank';prefs.homepage_is_newtabpage=false;
  await writeJsonAtomic(prefsPath,prefs);
  const metadata={source_root:source.source_root,source_profile:name,mode:'full',captured_at:new Date().toISOString(),sessions_restored:false};
  await writeJsonAtomic(path.join(staging,'.source-snapshot.json'),metadata);
  await fs.rename(staging,source.seed_dir);
  return metadata;
}
export async function initializeLocalBrowserProfile(key,profile,kind){
  const config=(await readBrowserSources()).platforms?.[key];
  const source=config?.[kind];
  let metadata=await fs.readFile(path.join(profile,'.local-initialization.json'),'utf8').then(JSON.parse).catch(()=>null);
  if(!metadata&&source){
    const existing=await fs.access(path.join(profile,'Default')).then(()=>true).catch(()=>false);
    if(existing&&source.mode==='full')metadata={mode:'existing',note:'保留已有采集会话，未覆盖'};
    else if(source.mode==='full'){
      const snapshot=await prepareLocalProfileSeed(source);
      await fs.cp(source.seed_dir,profile,{recursive:true,filter:copyFilter});
      metadata={...snapshot,source_kind:kind};
    }else if(source.mode==='settings'){
      const name=source.source_profile||'Default';
      if(!/^(Default|Profile \d+)$/.test(name))throw Error('无效的本机配置名称');
      const original=JSON.parse(await fs.readFile(path.join(source.source_root,name,'Preferences'),'utf8'));
      // Only language, fonts, spellcheck and window placement are used for Chrome initialization.
      const prefs=existing?JSON.parse(await fs.readFile(path.join(profile,'Default','Preferences'),'utf8')):{};
      prefs.session={...prefs.session,restore_on_startup:5,startup_urls:[]};prefs.homepage='about:blank';prefs.homepage_is_newtabpage=false;
      for(const field of ['intl','spellcheck'])if(original[field])prefs[field]=original[field];
      if(original.webkit?.webprefs)prefs.webkit={webprefs:original.webkit.webprefs};
      if(original.browser?.window_placement)prefs.browser={window_placement:original.browser.window_placement};
      await fs.mkdir(path.join(profile,'Default'),{recursive:true});
      await writeJsonAtomic(path.join(profile,'Default','Preferences'),prefs);
      metadata={mode:'settings',source_kind:kind,source_root:source.source_root,source_profile:name,captured_at:new Date().toISOString(),applied_to_existing_profile:existing};
    }else throw Error('未知本机配置导入模式');
    await writeJsonAtomic(path.join(profile,'.local-initialization.json'),metadata);
  }
  let proxy;
  if(config?.proxy){
    const address=new URL(config.proxy.server);
    if(!['http:','socks5:'].includes(address.protocol)||!['127.0.0.1','localhost'].includes(address.hostname)||address.username||address.password||!address.port)throw Error('本机代理配置无效');
    await new Promise((resolve,reject)=>{
      const socket=net.createConnection({host:address.hostname,port:Number(address.port)});
      socket.setTimeout(1500);socket.once('connect',()=>{socket.destroy();resolve();});
      socket.once('timeout',()=>{socket.destroy();reject(Error('本机代理未响应，请先启动 127.0.0.1:7897 代理'));});
      socket.once('error',()=>reject(Error('本机代理未开启，请先启动 127.0.0.1:7897 代理')));
    });
    proxy=config.proxy;
  }
  return {metadata,proxy,executable:config?.[kind]?.executable_path};
}
