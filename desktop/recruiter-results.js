/* Local presentation only. Filtering never changes delivery eligibility. */
(() => {
  const groups={all:'全部',active:'处理中',excluded:'非目标岗位',unqualified:'条件未满足',ready:'可沟通',sent:'已发送',review:'待复核',stopped:'异常/停止',skipped:'已跳过'};
  const category=state=>({reading:'active',matching:'active',sending:'active',excluded:'excluded','low-match':'unqualified',ready:'ready',sent:'sent',review:'review','awaiting-review':'review',stopped:'stopped','delivery-stopped':'stopped',skipped:'skipped',quota:'skipped'})[state]||'review';
  window.createRecruiterResults=($) => {
    const size=5,list=$('recruiterResults'),filter=$('recruiterResultFilter');
    let run=null,runId=null,page=1,previous=new Set(),pending=new Set(),initialized=false;
    const key=(row,i)=>String(row.id||row.job?.url||`${i}:${row.job?.title}`);
    function card(row,k){
      const node=document.createElement('article');node.className='job result-card';node.dataset.key=k;node.dataset.category=category(row.state);
      const heading=document.createElement('h3');heading.textContent=row.job?.title||'未命名岗位';node.append(heading);
      const meta=document.createElement('p');meta.className='result-meta';meta.textContent=[row.job?.company,Number.isFinite(row.coverage)?`证据覆盖 ${Math.round(row.coverage*100)}%`:''].filter(Boolean).join(' · ');meta.title='证据覆盖不是录用概率';node.append(meta);
      const status=document.createElement('span');status.className='result-state';status.textContent=({reading:'读取中',matching:'匹配中',excluded:'非目标岗位',review:'待复核','low-match':'条件未满足',ready:run?.delivery?'准备发送':'可沟通 · 草稿未发送',sending:'发送待确认',sent:'已发送招呼及简历',skipped:'未重复发送',quota:'达到授权人数','delivery-stopped':'发送中断，需核对',stopped:'已停止'})[row.state]||'待核对';node.append(status);
      const paragraph=(parent,text)=>{const p=document.createElement('p');p.textContent=text;parent.append(p);};
      if(row.resumeFilename)paragraph(node,'使用简历：'+row.resumeFilename);
      if(row.state==='awaiting-review'){status.textContent='新简历待人工审核 · 未发送';paragraph(node,row.message||'请到个人资料审核草稿，再重新授权');const button=document.createElement('button');button.textContent='打开简历库';button.onclick=()=>window.jobDesktop.command('workspace',{route:'profile'});node.append(button);}
      const details=(title,section)=>{const d=document.createElement('details'),s=document.createElement('summary');d.dataset.section=section;s.textContent=title;d.append(s);node.append(d);return d;};
      if(['delivery-stopped','stopped'].includes(row.state)&&row.message)paragraph(node,row.message);
      if(row.greeting)paragraph(details(row.state==='sent'?'已发送招呼':row.state==='ready'&&!run?.delivery?'预览草稿 · 未发送':'招呼内容 · 发送待确认','draft'),row.greeting);
      const evidence=details('匹配详情','evidence');
      if(row.message)paragraph(evidence,row.message);
      if(row.matches?.length)paragraph(evidence,row.matches.map(m=>`JD：${m.jd_evidence}\n简历：${m.resume_evidence}`).join('\n\n'));
      for(const [label,rows] of [['资格待核实',row.gaps?.filter(g=>g.requirement_type!=='core')],['技能缺口',row.gaps?.filter(g=>g.requirement_type==='core')],['加分项',row.preferredGaps]])if(rows?.length)paragraph(evidence,label+'：'+rows.map(g=>g.requirement+' · '+g.jd_evidence).join('\n'));
      for(const [label,items] of [['待核实问题',row.questions],['其他咨询',row.informationalQuestions]])if(items?.length)paragraph(evidence,label+'：'+items.join('\n'));
      return node;
    }
    function render({resetScroll=false}={}){
      const rows=run?.results||[],entries=rows.map((row,i)=>({row,key:key(row,i)})),counts=Object.fromEntries(Object.keys(groups).map(g=>[g,g==='all'?rows.length:rows.filter(r=>category(r.state)===g).length]));
      $('recruiterResultsPanel').hidden=!run;
      $('recruiterResultTotal').textContent=`岗位结果 · ${rows.length}`;
      for(const [value,label] of Object.entries(groups)){
        let option=[...filter.options].find(o=>o.value===value);
        if(!option){option=document.createElement('option');option.value=value;filter.append(option);}
        option.textContent=`${label} · ${counts[value]}`;
      }
      const selected=entries.filter(({row})=>filter.value==='all'||category(row.state)===filter.value),pages=Math.max(1,Math.ceil(selected.length/size));
      page=Math.min(page,pages);const visible=selected.slice((page-1)*size,page*size),old=new Map([...list.children].map(n=>[n.dataset.key,n]));
      const scroll=resetScroll?0:list.scrollTop,focus=document.activeElement?.closest?.('.result-card'),section=document.activeElement?.closest?.('details')?.dataset.section;
      const nodes=visible.map(({row,key:k})=>{
        pending.delete(k);const signature=JSON.stringify([row,!!run?.delivery]),prior=old.get(k);
        if(prior?.dataset.signature===signature)return prior;
        const next=card(row,k);next.dataset.signature=signature;
        for(const d of prior?.querySelectorAll('details[open]')||[])next.querySelector(`details[data-section="${d.dataset.section}"]`)?.setAttribute('open','');
        return next;
      });
      if(nodes.length!==list.children.length||nodes.some((n,i)=>n!==list.children[i]))list.replaceChildren(...nodes);
      $('recruiterResultEmpty').hidden=selected.length>0;
      $('recruiterResultPage').textContent=`${page} / ${pages}`;
      $('recruiterResultRange').textContent=selected.length?`${(page-1)*size+1}–${Math.min(page*size,selected.length)} / ${selected.length}`:'0条';
      $('recruiterResultPrevious').disabled=page===1;$('recruiterResultNext').disabled=page===pages;
      $('recruiterResultNew').hidden=pending.size===0;$('recruiterResultNew').textContent=`新增 ${pending.size} 条`;
      if(focus&&section&&!list.contains(document.activeElement))nodes.find(n=>n.dataset.key===focus.dataset.key)?.querySelector(`details[data-section="${section}"] summary`)?.focus({preventScroll:true});
      list.scrollTop=scroll;
    }
    filter.onchange=()=>{page=1;render({resetScroll:true});};
    $('recruiterResultPrevious').onclick=()=>{page=Math.max(1,page-1);render({resetScroll:true});};
    $('recruiterResultNext').onclick=()=>{page++;render({resetScroll:true});};
    $('recruiterResultNew').onclick=()=>{filter.value='all';page=Math.max(1,Math.ceil((run?.results.length||0)/size));pending.clear();render({resetScroll:true});};
    return {update(next){
      const id=next?.id||next?.createdAt||(next?'current-run':null),fresh=!initialized||id!==runId;
      if(fresh){page=1;filter.value='all';pending.clear();previous.clear();}
      const keys=new Set((next?.results||[]).map(key));
      if(!fresh)for(const k of keys)if(!previous.has(k))pending.add(k);
      for(const k of pending)if(!keys.has(k))pending.delete(k);
      run=next;runId=id;previous=keys;initialized=true;render({resetScroll:fresh});
    }};
  };
})();
