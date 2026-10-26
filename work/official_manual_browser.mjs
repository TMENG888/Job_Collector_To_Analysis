import {spawn} from 'node:child_process';
import {createJobBrowserManager} from './job-browser-manager.mjs';

const fail=(message,status=400)=>Object.assign(Error(message),{status});
export function ordinaryOfficialArguments(platform,value){
  let url;try{url=new URL(value);}catch{throw fail('官网地址无效');}
  const official=platform==='liepin'
    ? url.origin==='https://www.liepin.com'&&url.pathname==='/zhaopin/'
    : platform==='job51'&&url.origin==='https://we.51job.com'&&url.pathname==='/pc/search';
  if(!official||url.username||url.password||url.hash)throw fail('只允许打开当前渠道的官网搜索页');
  return ['--new-window',url.href];
}
export async function openOfficialInOrdinaryBrowser(target,{browserId='edge',
  inventory=()=>createJobBrowserManager(import.meta.dirname).inventory(),launch=spawn}={}){
  if(!['edge','chrome'].includes(browserId))throw fail('请选择普通 Edge 或 Chrome');
  const args=ordinaryOfficialArguments(target.platform,target.url);
  const browser=(await inventory()).find(item=>item.id===browserId&&item.available);
  if(!browser?.executable)throw fail(`未找到已安装的 ${browserId==='edge'?'Microsoft Edge':'Google Chrome'}，请安装或选择另一浏览器`,409);
  let child;
  try{
    child=launch(browser.executable,args,{shell:false,detached:true,windowsHide:false,stdio:'ignore'});
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
    child.unref();
  }catch{throw fail('普通浏览器未能启动，请检查本机安装或系统限制',409);}
  return {browserId,browserName:browser.name};
}
