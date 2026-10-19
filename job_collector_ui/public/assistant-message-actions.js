// UI-only actions: never send a message, call a model, or execute a collection plan.
const icons={copy:'<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',edit:'<path d="m15 4 5 5M4 20l5-1L20 8a2 2 0 0 0-5-5L4 14z"/>',retry:'<path d="M3 10a9 9 0 1 1 2 9M3 4v6h6"/>',markdown:'<path d="M3 17V7l5 6 5-6v10M17 13l3 4 3-4M20 7v10"/>'};
export function actionButton(doc,kind,label){
  const button=doc.createElement('button');button.type='button';button.className='assistant-message-action';
  button.dataset.messageAction=kind;button.title=label;button.setAttribute('aria-label',label);
  button.innerHTML=`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[kind]||icons.copy}</svg><span></span>`;
  button.querySelector('span').textContent=label;return button;
}
export async function writeClipboard(text,{navigator=globalThis.navigator,document=globalThis.document}={}){
  try{if(navigator?.clipboard?.writeText){await navigator.clipboard.writeText(text);return;}}catch{}
  const active=document.activeElement,selection=document.getSelection(),ranges=[];
  if(selection)for(let i=0;i<selection.rangeCount;i++)ranges.push(selection.getRangeAt(i).cloneRange());
  const input=document.createElement('textarea');input.value=text;input.className='assistant-clipboard-fallback';
  input.setAttribute('readonly','');document.body.append(input);
  try{input.select();if(!document.execCommand?.('copy'))throw new Error('请选中文字后按 Ctrl+C 手动复制');}
  finally{input.remove();active?.focus({preventScroll:true});if(selection){selection.removeAllRanges();for(const range of ranges)selection.addRange(range);}}
}
export async function copyWithFeedback(button,text,{write=writeClipboard,notify=()=>{}}={}){
  if(button.disabled)return;
  const label=button.querySelector('span'),original=button.getAttribute('aria-label')||label.textContent;
  button.disabled=true;
  try{await write(text);label.textContent='已复制';notify('已复制到剪贴板');}
  catch{label.textContent='复制失败';notify('复制失败，请选中文字后按 Ctrl+C 手动复制');}
  finally{button.disabled=false;clearTimeout(button.copyFeedbackTimer);button.copyFeedbackTimer=setTimeout(()=>{label.textContent=original;},1800);}
}
export function plainAnswerText(root){
  const clone=root.cloneNode(true);clone.querySelectorAll('.assistant-code-toolbar').forEach(el=>el.remove());
  // innerText requires a rendered element. Clone into an inert, offscreen container
  // so paragraphs and table rows retain their line breaks in the copied text.
  clone.classList.add('assistant-plain-copy');clone.setAttribute('aria-hidden','true');clone.inert=true;
  root.ownerDocument.body.append(clone);
  try{return (clone.innerText||clone.textContent||'').trim();}finally{clone.remove();}
}
export function addMessageActions(item,{role,text,onEdit,onRetry,notify,write}={}){
  item.querySelector(':scope > .assistant-message-actions')?.remove();
  const bar=item.ownerDocument.createElement('div');bar.className='assistant-message-actions';bar.setAttribute('role','group');bar.setAttribute('aria-label',role==='user'?'提问操作':'回答操作');
  const copy=actionButton(item.ownerDocument,'copy','复制');
  copy.addEventListener('click',()=>copyWithFeedback(copy,role==='user'?text:plainAnswerText(item.querySelector('.assistant-message-text')),{write,notify}));bar.append(copy);
  if(role==='assistant'){
    const md=actionButton(item.ownerDocument,'markdown','复制 Markdown');md.addEventListener('click',()=>copyWithFeedback(md,text,{write,notify}));bar.append(md);
  }
  for(const [kind,label,handler] of [['edit','编辑',onEdit],['retry','重新提问',onRetry]])if(handler){
    const button=actionButton(item.ownerDocument,kind,label);button.dataset.requiresIdle='true';
    button.title=kind==='edit'?'编辑到输入框，确认发送后作为新消息；保留历史':'回填原提问，确认后发送；不会自动执行工具';
    button.addEventListener('click',()=>{if(!button.disabled)handler();});bar.append(button);
  }
  item.append(bar);return bar;
}
export function addCodeActions(root,{write,notify}={}){
  for(const pre of root.querySelectorAll('pre')){
    const code=pre.querySelector('code');if(!code||pre.previousElementSibling?.classList.contains('assistant-code-toolbar'))continue;
    const wrapper=root.ownerDocument.createElement('div');wrapper.className='assistant-code-block';
    const toolbar=root.ownerDocument.createElement('div');toolbar.className='assistant-code-toolbar';
    const language=root.ownerDocument.createElement('span');language.textContent=code.className.match(/language-([\w+-]+)/)?.[1]||'代码';
    const button=actionButton(root.ownerDocument,'copy','复制代码');button.addEventListener('click',()=>copyWithFeedback(button,code.textContent,{write,notify}));
    toolbar.append(language,button);pre.before(wrapper);wrapper.append(toolbar,pre);
  }
}
