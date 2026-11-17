let active=false;

export function confirmAction(label='确认操作',message=''){
  if(active)return Promise.resolve(false);
  active=true;
  const opener=document.activeElement,dialog=document.createElement('dialog');
  dialog.className='action-confirm-dialog';dialog.setAttribute('aria-label',label);
  dialog.innerHTML='<form method="dialog"><button type="submit" class="primary" value="confirm">确认</button><button type="submit" class="ghost" value="cancel" autofocus>取消</button></form>';
  const prompt=document.createElement('p');
  prompt.id='action-confirm-message';prompt.textContent=message||(label==='确认操作'?'是否继续此操作？':`确定要${label.replace(/^确认/,'')}吗？`);
  dialog.prepend(prompt);dialog.classList.add('has-message');dialog.setAttribute('aria-describedby',prompt.id);
  document.body.append(dialog);
  return new Promise((resolve,reject)=>{
    dialog.addEventListener('close',()=>{const confirmed=dialog.returnValue==='confirm';dialog.remove();active=false;if(opener?.isConnected&&!opener.disabled)opener.focus();resolve(confirmed);},{once:true});
    try{dialog.showModal();}catch(error){dialog.remove();active=false;reject(error);}
  });
}
