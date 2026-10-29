export function createMessageEditor(item,{text,hasAttachment=false,onSend,onCancel}={}){
  const doc=item.ownerDocument,form=doc.createElement('form');form.className='assistant-message-editor';form.setAttribute('aria-label','编辑提问');
  const input=doc.createElement('textarea');input.value=text;input.rows=2;input.maxLength=40000;input.setAttribute('aria-label','修改提问内容');
  const note=doc.createElement('p');note.className='assistant-message-edit-hint';note.textContent=hasAttachment?'原简历附件不会重复上传；发送后保留原记录。':'发送为新提问，原记录保留。';
  const error=doc.createElement('p');error.className='assistant-message-edit-error';error.setAttribute('role','status');error.hidden=true;
  const actions=doc.createElement('div');actions.className='assistant-message-edit-actions';
  const cancel=doc.createElement('button');cancel.type='button';cancel.className='secondary';cancel.textContent='取消';
  const send=doc.createElement('button');send.type='submit';send.className='primary';send.textContent='发送';
  const footer=doc.createElement('div');footer.className='assistant-message-edit-footer';
  actions.append(cancel,send);footer.append(note,actions);form.append(input,error,footer);item.append(form);item.classList.add('assistant-message-editing');
  let busy=false;
  const update=()=>{send.disabled=busy||!input.value.trim();cancel.disabled=busy;input.disabled=busy;send.textContent=busy?'发送中…':'发送';};
  const resize=()=>{input.style.height='auto';input.style.height=`${Math.min(Math.max(120,(doc.defaultView?.innerHeight||900)*.42),Math.max(64,input.scrollHeight))}px`;};
  input.addEventListener('input',()=>{update();resize();error.hidden=true;});
  form.addEventListener('submit',event=>{event.preventDefault();if(!send.disabled)onSend?.(input.value.trim());});
  cancel.addEventListener('click',()=>{if(!busy)onCancel?.();});
  input.addEventListener('keydown',event=>{
    if(event.isComposing||event.keyCode===229)return;
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(!busy)onCancel?.();}
    else if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();if(!send.disabled)onSend?.(input.value.trim());}
  });
  update();resize();
  return {
    get value(){return input.value;},
    focus(){input.focus({preventScroll:true});input.setSelectionRange(input.value.length,input.value.length);},
    setBusy(value){busy=value;update();},
    showError(message){error.textContent=message;error.hidden=false;},
    destroy(){form.remove();item.classList.remove('assistant-message-editing');}
  };
}
