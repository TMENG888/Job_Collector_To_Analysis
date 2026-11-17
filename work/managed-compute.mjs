import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {randomUUID} from 'node:crypto';

export const managedComputeEnabled=()=>!!process.env.JOB_COMPUTE_BASE_URL;
export function startManagedCompute(kind,parameters={}){
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
  let id='',cancelled=false,closed=false,stdoutOffset=0,stderrOffset=0;
  const base=process.env.JOB_COMPUTE_BASE_URL,headers={'content-type':'application/json','x-job-compute-token':process.env.JOB_COMPUTE_TOKEN||''};
  const request=async(path,options={})=>{
    const response=await fetch(base+'/internal/compute'+path,{...options,headers,signal:AbortSignal.timeout(30000)});
    const body=await response.json();if(!response.ok)throw Error(body.error||'FastAPI计算调度未完成');return body;
  };
  child.kill=()=>{cancelled=true;if(id)void request('/'+id+'/cancel',{method:'POST',body:'{}'}).catch(()=>{});return true;};
  queueMicrotask(async()=>{
    try{
      const {job}=await request('',{method:'POST',body:JSON.stringify({kind,...parameters,requestId:randomUUID()})});id=job.id;
      if(cancelled)await request('/'+id+'/cancel',{method:'POST',body:'{}'});
      while(true){
        const {job:current,output}=await request('/'+id+'?stdoutOffset='+stdoutOffset+'&stderrOffset='+stderrOffset);
        if(output){
          if(output.stdout)child.stdout.write(Buffer.from(output.stdout,'base64'));
          if(output.stderr)child.stderr.write(Buffer.from(output.stderr,'base64'));
          stdoutOffset=output.stdoutOffset;stderrOffset=output.stderrOffset;
        }
        if(!output?.more&&['completed','failed','cancelled','interrupted'].includes(current.state)){
          if(current.error&&!stderrOffset)child.stderr.write(current.error);
          child.stdout.end();child.stderr.end();closed=true;child.emit('close',current.state==='completed'?0:current.code||1);break;
        }
        await new Promise(resolve=>setTimeout(resolve,250));
      }
    }catch(error){
      if(!closed){child.stderr.write(error.message);child.stdout.end();child.stderr.end();closed=true;child.emit('close',1);}
    }
  });
  return child;
}
