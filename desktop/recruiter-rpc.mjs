import {createHash} from 'node:crypto';
import {pageOperation} from '../job_collector_ui/browser-extension/dom.mjs';
import {recruitingURL} from './policy.mjs';

// Main-process-only adapter. IPC never accepts code, selectors or arbitrary ops.
export function createNativeRecruiterRPC({tabs,state,open,navigate,activate}){
  let automationTab=null,detailTab=null,freshBatch=false,enabled=false,epoch=0,ticket=null;
  const check=id=>{const s=state(),tab=tabs.get(id);if(s.mode!=='browser'||s.selectedId!==id||!tab||tab.loading||tab.error||tab.view.webContents.isDestroyed())throw Error('招聘页面已切换、加载或异常，本批停止');recruitingURL(tab.view.webContents.getURL());return tab;};
  async function operation(id,args,{sideEffect=false}={}){
    if(sideEffect&&!enabled)throw Error('自动操作已停止');
    const tab=check(id),wc=tab.view.webContents,generation=tab.generation,url=wc.getURL(),revision=epoch;
    const value=await wc.executeJavaScriptInIsolatedWorld(1108,[{code:`(${pageOperation.toString()})(${JSON.stringify({...args,__localJobEnvelope:true})})`}]);
    if(value?.__localJobError)throw Error(value.__localJobError);
    if(!sideEffect){check(id);if(tab.generation!==generation||wc.getURL()!==url||revision!==epoch)throw Error('读取期间页面变化或批次取消，结果已作废');}
    return value;
  }
  async function rpc(method,args={}){
    if(method==='begin'){enabled=true;epoch++;ticket=null;freshBatch=true;return {};}
    if(method==='halt'){enabled=false;epoch++;ticket=null;return {};}
    if(method==='status'){const s=state();return {running:true,mode:s.mode==='browser'?'desktop-native':'workspace',selectedTabId:s.selectedId,tabs:s.tabs.map(t=>({...t,generation:tabs.get(t.id)?.generation,unexpectedBlank:!t.url.startsWith('https:')}))};}
    if(method==='open-site'){
      if(!enabled)throw Error('本批已停止');const url=recruitingURL(args.url);
      if(automationTab&&tabs.has(automationTab)){
        if(!freshBatch){const active=state().selectedId;if(active!==automationTab&&active!==detailTab)throw Error('招聘标签已切换，本批停止');check(active);}
        activate(automationTab);check(automationTab);navigate(automationTab,url);
      }else automationTab=await open(url);
      freshBatch=false;
      return {openRequest:{tabId:automationTab}};
    }
    const id=String(args.tabId||'');
    if(method==='navigate'){
      if(!enabled)throw Error('本批已停止');check(id);const url=recruitingURL(args.url);
      if(args.purpose==='detail'){
        if(id!==automationTab&&id!==detailTab)throw Error('不是本批拥有的检索/详情页');
        if(detailTab&&tabs.has(detailTab)){activate(detailTab);check(detailTab);navigate(detailTab,url);}else detailTab=await open(url);
        return {tabId:detailTab};
      }
      navigate(id,url);return {};
    }
    if(method==='restore-search'){
      if(!enabled||args.searchTabId!==automationTab||![automationTab,detailTab].includes(id))throw Error('当前检索会话已失效');
      check(id);activate(automationTab);check(automationTab);return {};
    }
    if(method==='plugin'){
      if(!['read-detail','collect-page','advance-results'].includes(args.id))throw Error('无效读取');
      return operation(id,{op:args.id,...(args.id==='collect-page'?{limit:300}:{})},{sideEffect:args.id==='advance-results'});
    }
    if(method==='prepare-action'){
      if(!enabled||args.kind!=='apply')throw Error('未授权的操作');
      const value=await operation(id,{op:'prepare',kind:'apply'}),tab=check(id);
      ticket={id:value.id,tabId:id,generation:tab.generation,url:tab.view.webContents.getURL(),epoch};
      return {...value,fingerprint:createHash('sha256').update(JSON.stringify([value.job.url,value.job.title,value.job.company,value.job.description])).digest('hex')};
    }
    if(method==='confirm-action'){
      const tab=check(id),t=ticket;ticket=null;
      if(!enabled||!t||t.id!==args.ticketId||t.tabId!==id||t.generation!==tab.generation||t.url!==tab.view.webContents.getURL()||t.epoch!==epoch)throw Error('沟通确认已过期或页面变化，未执行');
      return operation(id,{op:'confirm',ticketId:t.id},{sideEffect:true});
    }
    if(method==='cancel-action'){ticket=null;return operation(id,{op:'cancel'});}
    if(method==='delivery-context')return operation(id,{op:method,job:args.job});
    if(method==='delivery-message'||method==='delivery-image')return operation(id,{op:method,job:args.job,binding:args.binding,body:args.message,image:args.image},{sideEffect:true});
    throw Error('未接入的原生插件操作');
  }
  return rpc;
}
