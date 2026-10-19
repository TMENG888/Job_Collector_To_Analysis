import {setAssistantMarkdown} from '../assistant-markdown.js';
import {addMessageActions,addCodeActions,writeClipboard,copyWithFeedback,plainAnswerText} from '../assistant-message-actions.js';
const results=[],scratch=document.querySelector('#scratch');
const assert=(v,m='断言失败')=>{if(!v)throw new Error(m);};
async function test(name,fn){try{await fn();results.push({name,pass:true});}catch(error){results.push({name,pass:false,error:error.message});}}
const sample='## 推荐方向\n\n**Agent应用开发实习**：期望日薪250元，结合JD沟通。\n\n| 技术 | 证据 |\n| --- | --- |\n| RAG | 项目检索与评测 |\n\n```python\nprint("岗位助手")\n```';
function message(role,text){const item=document.createElement('article');item.className=`assistant-message assistant-message-${role}`;const body=document.createElement('div');body.className='assistant-message-text';item.append(body);scratch.append(item);if(role==='assistant')setAssistantMarkdown(body,text);else body.textContent=text;return item;}
const item=message('assistant',sample);let copied='',retried=0;
addMessageActions(item,{role:'assistant',text:sample,write:async text=>{copied=text;},onRetry:()=>retried++});
await test('回答工具条只出现一次',()=>{assert(item.querySelectorAll(':scope > .assistant-message-actions').length===1);assert(item.querySelectorAll('[data-message-action="markdown"]').length===1);});
await test('复制 Markdown 保留原文',async()=>{item.querySelector('[data-message-action="markdown"]').click();await Promise.resolve();assert(copied===sample);});
await test('普通复制去除 Markdown 标记与工具条文字',async()=>{item.querySelector(':scope > .assistant-message-actions [data-message-action="copy"]').click();await Promise.resolve();assert(copied.includes('Agent应用开发实习'));assert(!copied.includes('**'));assert(!copied.includes('复制代码'));assert(!copied.includes('复制 Markdown'));assert(copied.includes('\n'));});
await test('重新提问只回填，不发送或调用网络',()=>{item.querySelector('[data-message-action="retry"]').click();assert(retried===1);});
await test('禁用时不触发重新提问',()=>{const b=item.querySelector('[data-message-action="retry"]');b.disabled=true;b.click();assert(retried===1);b.disabled=false;});
await test('代码块有独立复制入口',()=>{assert(item.querySelectorAll('.assistant-code-toolbar').length===1);assert(item.querySelector('.assistant-code-toolbar button').type==='button');});
await test('代码复制只复制代码原文',async()=>{addCodeActions(item);const codeItem=message('assistant','```text\na < b && "安全"\n```');codeItem.querySelector('.assistant-code-toolbar').remove();addCodeActions(codeItem,{write:async text=>{copied=text;}});codeItem.querySelector('.assistant-code-toolbar button').click();await Promise.resolve();assert(copied==='a < b && "安全"\n');});
await test('重复安装代码操作不产生重复工具条',()=>{addCodeActions(item);addCodeActions(item);assert(item.querySelectorAll('.assistant-code-toolbar').length===1);});
await test('用户消息保持纯文本，编辑得到原提问',()=>{const text='**简历** <img src=x onerror=alert(1)>';const user=message('user',text);let edits=0;addMessageActions(user,{role:'user',text,onEdit:()=>edits++});user.querySelector('[data-message-action="edit"]').click();assert(edits===1);assert(!user.querySelector('img,strong'));assert(!user.querySelector('[data-message-action="markdown"]'));});
await test('回执消息可以不提供编辑或重试',()=>{const receipt=message('user','确认执行采集方案');addMessageActions(receipt,{role:'user',text:'确认执行采集方案'});assert(!receipt.querySelector('[data-requires-idle]'));});
await test('复制成功提示只在完成后出现',async()=>{const button=item.querySelector(':scope > .assistant-message-actions [data-message-action="copy"]');let note='';await copyWithFeedback(button,'x',{write:async()=>{},notify:t=>note=t});assert(note==='已复制到剪贴板');assert(!button.disabled);});
await test('复制失败明确提示且可重试',async()=>{const button=item.querySelector(':scope > .assistant-message-actions [data-message-action="copy"]');let note='';await copyWithFeedback(button,'x',{write:async()=>{throw Error();},notify:t=>note=t});assert(note.includes('复制失败'));assert(!button.disabled);});
await test('空闲前禁用的复制按钮不会写剪贴板',async()=>{const button=item.querySelector(':scope > .assistant-message-actions [data-message-action="copy"]');button.disabled=true;let writes=0;await copyWithFeedback(button,'x',{write:async()=>writes++});assert(writes===0);button.disabled=false;});
await test('安全剪贴板通道优先',async()=>{let value='';await writeClipboard('安全文本',{navigator:{clipboard:{writeText:async t=>value=t}},document});assert(value==='安全文本');});
await test('剪贴板权限拒绝时安全降级，焦点与临时元素清理',async()=>{const input=document.createElement('input');scratch.append(input);input.focus();const original=document.execCommand;let command='';document.execCommand=name=>{command=name;return true;};try{await writeClipboard('降级文本',{navigator:{clipboard:{writeText:async()=>{throw Error();}}},document});assert(command==='copy');assert(document.activeElement===input);assert(!document.querySelector('.assistant-clipboard-fallback'));}finally{document.execCommand=original;input.remove();}});
await test('降级也失败时不谎报成功',async()=>{const original=document.execCommand;document.execCommand=()=>false;let failed=false;try{await writeClipboard('x',{navigator:{},document});}catch{failed=true;}finally{document.execCommand=original;}assert(failed);assert(!document.querySelector('.assistant-clipboard-fallback'));});
await test('提取纯文本不残留隐形DOM',()=>{plainAnswerText(item.querySelector('.assistant-message-text'));assert(!document.querySelector('.assistant-plain-copy'));});
await test('重新安装消息操作无重复',()=>{addMessageActions(item,{role:'assistant',text:sample});assert(item.querySelectorAll(':scope > .assistant-message-actions').length===1);});
const preview=document.querySelector('#preview');
const user=message('user','按我的简历推荐Agent实习岗位，并给出薪资建议。');addMessageActions(user,{role:'user',text:user.querySelector('.assistant-message-text').textContent,onEdit:()=>{document.querySelector('#assistantNotice').textContent='编辑会回填输入框；生产界面支持取消并恢复草稿。';}});preview.append(user);
const answer=message('assistant',sample);addMessageActions(answer,{role:'assistant',text:sample,onRetry:()=>{document.querySelector('#assistantNotice').textContent='生产界面将回填原提问，等待你确认发送。';},notify:t=>{document.querySelector('#assistantNotice').textContent=t;}});preview.append(answer);
requestAnimationFrame(()=>{
  try{assert(document.documentElement.scrollWidth<=document.documentElement.clientWidth+1);results.push({name:'当前视口不横向溢出',pass:true});}catch(error){results.push({name:'当前视口不横向溢出',pass:false,error:error.message});}
  const failed=results.filter(r=>!r.pass);document.title=`${failed.length?'FAIL':'PASS'} — 聊天消息操作`;
  const status=document.querySelector('#results');status.textContent=`${failed.length?'FAIL':'PASS'} · ${results.length-failed.length}/${results.length} 项通过`;
  const list=document.createElement('ul');for(const r of results){const li=document.createElement('li');li.textContent=`${r.pass?'✓':'✗'} ${r.name}${r.error?'：'+r.error:''}`;list.append(li);}status.append(list);
});
