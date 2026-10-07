// The deadline includes response body parsing, not only the response headers.
export async function fetchJsonWithTimeout(url,options={},timeoutMs=15000){
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),timeoutMs);
 try{
  const response=await fetch(url,{headers:{'content-type':'application/json'},...options,signal:controller.signal});
  const data=await response.json();
  if(!response.ok){const error=new Error(data.error||'操作失败');error.status=response.status;throw error;}
  return data;
 }catch(error){
  if(controller.signal.aborted)throw new Error('请求超时，请确认本地服务仍在运行后重试');
  if(error instanceof TypeError)throw new Error('无法连接本地服务，请确认控制台已启动');
  throw error;
 }finally{clearTimeout(timer);}
}
