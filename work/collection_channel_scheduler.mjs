import {randomUUID} from 'node:crypto';

const failure=message=>Object.assign(Error(message),{status:409});

// Network work is independent by platform; same-platform retries never overlap.
export function createChannelScheduler({platforms,initial=platforms,limit=platforms.length,run,shouldStop=()=>false,onState=()=>{}}){
  const states=new Map(platforms.map(platform=>[platform,{state:'idle'}])),results=[];
  let started=false,closed=false,running=0,resolveDone;
  const done=new Promise(resolve=>resolveDone=resolve);
  const notify=(platform,entry)=>{states.set(platform,entry);onState(platform,{...entry});};
  const get=platform=>{if(!states.has(platform))throw failure('该渠道未启用或不属于本轮采集器');return states.get(platform);};
  const snapshot=()=>Object.fromEntries([...states].map(([key,value])=>[key,{...value}]));
  function pump(){
    if(!started||closed)return;
    if(!shouldStop())for(const [platform,entry]of states){
      if(running>=Math.max(1,limit))break;
      if(entry.state!=='queued')continue;
      running++;notify(platform,{state:'running'});
      Promise.resolve().then(()=>run(platform,{restart:entry.restart===true})).then(
        value=>{results.push({item:platform,value});notify(platform,{state:'completed'});},
        error=>{results.push({item:platform,error});notify(platform,{state:'failed'});}
      ).finally(()=>{running--;pump();});
    }
    if(running===0&&(shouldStop()||![...states.values()].some(entry=>['queued','held'].includes(entry.state)))){
      closed=true;resolveDone(results);
    }
  }
  const schedule=()=>queueMicrotask(pump);
  return {
    snapshot,
    start(){if(started)return done;for(const platform of initial){get(platform);notify(platform,{state:'queued'});}started=true;schedule();return done;},
    hold(platform,token=randomUUID()){
      if(closed||shouldStop())throw failure('本轮正在收尾或暂停，请刷新后操作');
      const entry=get(platform);
      if(entry.state==='held'){if(entry.token===token)return {token};throw failure('该渠道已有人工操作进行中');}
      if(entry.state==='running')throw failure('该渠道正在采集，请待该渠道暂停后操作');
      notify(platform,{state:'held',token,previous:entry});return {token};
    },
    release(platform,token){
      const entry=get(platform);
      if(entry.state==='held'&&entry.token===token){notify(platform,entry.previous);schedule();}
      return {released:true};
    },
    resume(platform,token){
      if(closed||shouldStop())throw failure('本轮正在收尾或暂停，请刷新后续采');
      const entry=get(platform);
      if(entry.state==='running')throw failure('该渠道正在采集，未重复启动');
      if(entry.state==='held'&&entry.token!==token)throw failure('请先完成人工操作或关闭该渠道窗口');
      if(entry.state==='queued')return {queued:true,alreadyQueued:true};
      notify(platform,{state:'queued',restart:true});schedule();return {queued:true};
    },
  };
}

export function exposeChannelScheduler(scheduler,endpoint=process){
  if(typeof endpoint.send!=='function')return ()=>{};
  const send=value=>{if(endpoint.connected)endpoint.send(value,()=>{});};
  const listener=message=>{
    if(message?.type!=='channel-command')return;
    const {requestId,action,platform,token}=message;
    try{
      if(!['hold','release','resume'].includes(action))throw failure('未知渠道操作');
      const result=scheduler[action](platform,token);
      send({type:'channel-reply',requestId,result});
    }catch(error){send({type:'channel-reply',requestId,error:error.message,status:error.status||409});}
  };
  endpoint.on('message',listener);
  send({type:'channel-ready',states:scheduler.snapshot()});
  return ()=>{endpoint.off('message',listener);send({type:'channel-closed'});};
}

export function connectChannelScheduler(child,{timeoutMs=5000}={}){
  const pending=new Map(),states=new Map();let supported=false;
  function finish(error){for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(error);}pending.clear();}
  child.on('message',message=>{
    if(message?.type==='channel-ready'){supported=true;for(const [key,value]of Object.entries(message.states||{}))states.set(key,value);}
    if(message?.type==='channel-closed')supported=false;
    if(message?.type==='channel-state')states.set(message.platform,message.entry);
    if(message?.type!=='channel-reply')return;
    const entry=pending.get(message.requestId);if(!entry)return;
    pending.delete(message.requestId);clearTimeout(entry.timer);
    if(message.error)entry.reject(failure(message.error));else entry.resolve(message.result);
  });
  child.once('exit',()=>finish(failure('采集进程已结束，请刷新任务状态')));
  child.once('disconnect',()=>finish(failure('采集控制连接已断开，请刷新后核对状态')));
  return {
    get supported(){return supported;},
    state:platform=>states.get(platform)?.state,
    request(action,platform,token){
      if(!supported||!child.connected)return Promise.reject(failure('当前采集进程尚未加载渠道隔离调度，请保留断点并在本轮结束后重启后台'));
      const requestId=randomUUID();
      return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{pending.delete(requestId);reject(failure('渠道操作确认超时，请刷新核对，未重复启动'));},timeoutMs);
        pending.set(requestId,{resolve,reject,timer});
        child.send({type:'channel-command',requestId,action,platform,token},error=>{
          if(!error||!pending.has(requestId))return;pending.delete(requestId);clearTimeout(timer);reject(failure('渠道操作未送达，请刷新后重试'));
        });
      });
    },
  };
}
