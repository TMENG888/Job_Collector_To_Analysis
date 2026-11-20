import {reportMatchesClassifier} from './insight-classifier-state.js?v=20261113-version-bound';
export function createInsightSnapshotLoader({api,selection,apply,classifier}){
  let pending=null,queued=false;const reports=new Map();
  const signature=()=>JSON.stringify([selection(),classifier?.()]);
  async function report(url,key){
    if(!key)return null;
    if(!reports.has(key)){reports.set(key,await api(url,{timeoutMs:60000}));while(reports.size>3)reports.delete(reports.keys().next().value);}
    return reports.get(key);
  }
  async function refresh(){
    if(pending){queued=true;return pending;}
    pending=(async()=>{do{
      queued=false;const selected=selection(),requested=signature();let next;
      if(!selected.role&&selected.inputFile?.startsWith('kb://processed/'))next={inputFile:selected.inputFile,status:'empty',message:'清洗数据已接入，请选择目标岗位',report:null,reportVersion:null,snapshot:null};
      if(selected.role){
        let snapshotEndpointAvailable=false;
        try{
          const reply=await api('/api/insights/snapshot?'+new URLSearchParams(selected));
          snapshotEndpointAvailable=true;
          const key=reply.snapshot?.snapshotKey;
          next={...reply.state,reportVersion:key||null,report:await report('/api/insights/report?snapshotKey='+encodeURIComponent(key),key)};
        }catch(error){if(signature()!==requested){queued=true;continue;}if(snapshotEndpointAvailable||!/接口不存在|404/.test(error.message))throw error;}
      }
      if(!next){const legacy=await api('/api/insights?summary=1');next={...legacy,report:await report('/api/insights/report',legacy.reportVersion)};}
      if(signature()!==requested){queued=true;continue;}
      const currentClassifier=classifier?.();
      if(next.report&&selected.role&&(next.report.role!==selected.role||classifier&&(!currentClassifier||!reportMatchesClassifier(next.report,currentClassifier)))){
        next={...next,report:null,reportVersion:null,status:next.status==='running'?'running':'empty',message:currentClassifier?'分类器已更新，请重新生成分析':'正在核对分类器版本',snapshot:null};
      }
      apply(next);
    }while(queued);})().finally(()=>{pending=null;});
    return pending;
  }
  return {refresh};
}
