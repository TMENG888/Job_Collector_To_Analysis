import fs from 'node:fs/promises';
// Independent login processes must merge only their own platform, under a lock.
export async function savePlatformLoginStatus(file,profileRoot,key,entry){
 const lock=file+'.lock';let handle;
 for(let i=0;i<100;i++){
  try{handle=await fs.open(lock,'wx');break;}catch(e){if(e.code!=='EEXIST')throw e;await new Promise(r=>setTimeout(r,50));}
 }
 if(!handle)throw Error('登录状态正在被其他进程更新，请稍后重试；未覆盖已有会话记录');
 try{
  let status={platforms:{}};
  try{status=JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const previous=status.platforms?.[key];
  if(!entry.manual_window_closed_at&&previous?.manual_window_closed_at)entry={...entry,previous_manual_window_closed_at:previous.manual_window_closed_at};
  status={...status,profile_root:profileRoot,updated_at:new Date().toISOString(),platforms:{...status.platforms,[key]:entry}};
  const temporary=file+'.'+process.pid+'.tmp';await fs.writeFile(temporary,JSON.stringify(status,null,2),'utf8');await fs.rename(temporary,file);
 }finally{await handle.close();await fs.unlink(lock);}
}
