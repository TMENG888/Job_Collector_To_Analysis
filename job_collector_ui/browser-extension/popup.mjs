const status=document.querySelector('#status');
for(const kind of ['authorize','revoke'])document.querySelector('#'+kind).onclick=async()=>{try{const result=await send({kind});status.textContent=kind==='authorize'?`已授权当前招聘页（${result.tabId}），返回工作台点击交互镜像`:'已停止镜像授权';}catch(e){status.textContent=e.message;}};
async function send(value){const r=await chrome.runtime.sendMessage(value);if(r.error)throw Error(r.error);return r;}
document.querySelector('#pair').onsubmit=async e=>{e.preventDefault();try{await send({kind:'pair',code:document.querySelector('#code').value.trim()});document.querySelector('#code').value='';status.textContent='已连接。返回工作台读取当前岗位。';}catch(e){status.textContent=e.message;}};
document.querySelector('#disconnect').onclick=async()=>{await send({kind:'disconnect'});status.textContent='已断开连接';};
send({kind:'status'}).then(r=>{status.textContent=r.connected?'已连接本机工作台':'未连接，请粘贴连接码';}).catch(e=>{status.textContent=e.message;});
