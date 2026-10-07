import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
import {browserProfileRoot,platformKeys,validBrowserProfile} from './managed_browser.mjs';
import {writeJsonAtomic} from './collector_storage.mjs';
import {assertCollectorResources} from './collector_resources.mjs';
import {resolveBrowserExecutable} from './browser_executables.mjs';
import {initializeLocalBrowserProfile} from './browser_local_initialization.mjs';
const [key,sessionId,requestedProfile,requestedFile,executableKind='standard']=process.argv.slice(2);
if(!platformKeys.includes(key)||!sessionId)throw Error('无效浏览器实例参数');
const profile=requestedProfile||path.join(browserProfileRoot(),key),file=requestedFile||path.join(browserProfileRoot(),key+'.browser.json');
if(!validBrowserProfile(key,profile)||path.dirname(path.resolve(file))!==path.resolve(browserProfileRoot()))throw Error('无效浏览器配置路径');
const base={platform:key,session_id:sessionId,profile_dir:profile,host_pid:process.pid};
let context;
try{
 await assertCollectorResources();await fs.mkdir(profile,{recursive:true});
 const initialization=await initializeLocalBrowserProfile(key,profile,executableKind);
 const executablePath=initialization.executable||await resolveBrowserExecutable(executableKind);
 base.executable_path=executablePath;base.executable_kind=executableKind;
 base.local_initialization=initialization.metadata||null;base.proxy_server=initialization.proxy?.server||null;
 // Standard Playwright automation remains identifiable. Do not hide webdriver or spoof fingerprints.
 context=await chromium.launchPersistentContext(profile,{headless:false,chromiumSandbox:true,viewport:null,
  executablePath,locale:'zh-CN',proxy:initialization.proxy,
  args:['--remote-debugging-address=127.0.0.1','--remote-debugging-port=0'],
 });
 const [port,wsPath]=(await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).trim().split(/\r?\n/);
 if(!/^\d+$/.test(port)||!wsPath.startsWith('/devtools/browser/'))throw Error('浏览器调试端口未就绪');
 const cdp=await context.browser().newBrowserCDPSession();
 const {processInfo}=await cdp.send('SystemInfo.getProcessInfo');
 base.browser_pid=processInfo.find(item=>item.type==='browser')?.id;
 await cdp.detach();
 if(!Number.isInteger(base.browser_pid)||base.browser_pid<=0)throw Error('无法确认独立浏览器进程');
 await writeJsonAtomic(file,{...base,state:'open',endpoint:`http://127.0.0.1:${port}`,browser_ws:`ws://127.0.0.1:${port}${wsPath}`,opened_at:new Date().toISOString(),sandbox_enabled:true});
 await new Promise(resolve=>context.once('close',resolve));
 await writeJsonAtomic(file,{...base,state:'closed',closed_at:new Date().toISOString()});
}catch(error){
 await context?.close().catch(()=>{});
 await writeJsonAtomic(file,{...base,state:'failed',message:'浏览器启动失败；请检查配置目录是否被旧窗口占用，不会接管日常浏览器或删除登录数据。'+error.message});
 process.exitCode=1;
}
