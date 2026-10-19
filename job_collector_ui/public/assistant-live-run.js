export function collapseAssistantEvidence(supplement,turn){
  const record=document.createElement('details');record.className='assistant-run-summary';
  const summary=document.createElement('summary');summary.textContent=`执行记录与数据依据${turn.trace?.length?' · '+turn.trace.length+' 步工具':''}`;record.append(summary);
  const visible=[];
  for(const child of [...supplement.children]){
    if(child.matches('.assistant-warning,[data-action-state="pending"],[data-action-state="executing"]'))visible.push(child);
    else record.append(child);
  }
  supplement.replaceChildren(...visible,record);return record;
}

// Live execution is an observable status feed, not a model's private reasoning.
export function createLiveAssistantRun(item,{labels={},renderMarkdown,onUpdate=()=>{}}){
  const text=item.querySelector('.assistant-message-text'),panel=document.createElement('details');
  panel.className='assistant-live-run';panel.open=true;panel.dataset.state='running';
  const summary=document.createElement('summary'),title=document.createElement('span'),clock=document.createElement('small');
  title.textContent='正在开始本轮任务';title.setAttribute('role','status');clock.setAttribute('aria-hidden','true');summary.append(title,clock);
  const note=document.createElement('p');note.className='assistant-live-note';note.textContent='实时执行摘要 · 不展示模型内部思维链';
  const plan=document.createElement('p');plan.className='assistant-live-plan';plan.hidden=true;
  const list=document.createElement('ol');list.className='assistant-live-tools';panel.append(summary,note,plan,list);text.before(panel);text.textContent='';item.setAttribute('aria-busy','true');
  const entries=new Map(),began=Date.now();let buffer='',shown=0,timer=null,started=0,ended=false;
  const tick=setInterval(()=>{clock.textContent=`${Math.floor((Date.now()-began)/1000)} 秒`;},1000);
  function draw(){
    timer=null;const letters=Array.from(buffer);
    const flush=document.hidden||Date.now()-started>2500;
    shown=flush?letters.length:Math.min(letters.length,shown+Math.max(18,Math.ceil((letters.length-shown)/20)));
    renderMarkdown(text,letters.slice(0,shown).join(''));onUpdate();
    if(shown<letters.length)timer=setTimeout(draw,32);
  }
  function append(value){buffer+=String(value||'');if(buffer.length>100000)throw new Error('回答长度超出显示上限');if(!started)started=Date.now();if(!timer)draw();}
  function step(event){
    let entry=entries.get(event.id);if(!entry){entry=document.createElement('li');entry.dataset.state='running';list.append(entry);entries.set(event.id,entry);}
    const name=labels[event.tool]||event.tool||'系统工具',complete=event.type==='tool_end';
    entry.dataset.state=complete?(event.status==='failed'||event.status==='invalid_arguments'?'failed':'completed'):'running';
    const status=!complete?'调用中':event.status==='failed'?(event.phase==='validation'?'参数校验失败，未查数':event.phase==='retry_guard'?'已拦截重复调用':'执行失败'):event.status==='clarification'?'待补充条件':event.tool==='collection_prepare_action'?'方案已准备，尚未执行':'已返回';
    entry.textContent=`${name} · ${status}${complete&&Number(event.rows)>0?' · '+Number(event.rows).toLocaleString('zh-CN')+' 条':''}${Number.isFinite(event.duration_ms)?' · '+(event.duration_ms/1000).toFixed(1)+' 秒':''}${complete&&event.status==='failed'&&event.message?' · '+event.message:''}`;
    title.textContent=complete?'工具已返回，正在继续处理':`正在调用：${name}`;
  }
  return {
    event(event){
      if(ended)return;
      if(event.type==='phase'||event.type==='answer_start')title.textContent=event.message||'正在处理';
      else if(event.type==='plan'){plan.hidden=false;plan.textContent='本轮计划：'+(event.steps||[]).join(' → ');}
      else if(event.type==='tool_start'||event.type==='tool_end')step(event);
      else if(event.type==='answer_delta')append(event.text);
      onUpdate();
    },
    async complete(answer,signal){
      // JSON compatibility uses the same paced, sanitized presentation. It never
      // resends the request or pretends a finished model is still thinking.
      if(buffer!==answer){buffer='';shown=0;append(answer);}
      title.textContent='答复已核验，正在呈现';
      while(shown<Array.from(buffer).length){if(signal?.aborted)throw new Error('本轮已停止');await new Promise(resolve=>setTimeout(resolve,32));}
      if(signal?.aborted)throw new Error('本轮已停止');
      this.stop(false);
    },
    stop(failed=true){ended=true;clearInterval(tick);clearTimeout(timer);timer=null;panel.open=false;panel.dataset.state=failed?'failed':'completed';title.textContent=failed?'本轮已停止 · 展开查看已执行步骤':`本轮处理完成 · ${entries.size} 步工具`;item.setAttribute('aria-busy','false');
      for(const entry of entries.values())if(entry.dataset.state==='running'){entry.dataset.state='failed';entry.textContent+='（连接中断，结果待核对）';}
    },
  };
}
