export function installCollectionKeywords(form,{api}){
  const role=form.elements.namedItem('label'),keywords=form.elements.namedItem('keywords'),button=form.querySelector('[data-generate-keywords]'),notice=form.querySelector('[data-keywords-notice]'),submit=form.querySelector('[type="submit"]');
  let busy=false;
  const show=(message,error=false)=>{notice.textContent=message;notice.hidden=!message;notice.dataset.error=String(error);};
  button.addEventListener('click',async()=>{
    if(busy)return;
    const name=role.value.trim();
    if(name.length<2||!role.reportValidity()){show('请先填写岗位名称',true);role.focus();return;}
    busy=true;button.disabled=true;submit.disabled=true;role.readOnly=true;keywords.readOnly=true;button.textContent='生成中…';button.setAttribute('aria-busy','true');
    show('正在生成…');
    try{
      const data=await api('/api/collection/keywords',{method:'POST',body:JSON.stringify({role:name}),headers:{'Idempotency-Key':crypto.randomUUID()},timeoutMs:90000});
      if(data.role!==name||!Array.isArray(data.keywords)||data.keywords.length!==5||data.keywords.some(word=>typeof word!=='string'||!word.trim()))throw Error('生成结果无效，未覆盖已有关键词');
      keywords.value=data.keywords.join('，');keywords.dispatchEvent(new Event('input',{bubbles:true}));
      show(`已生成5个关键词${data.usage?` · 输入 ${Number(data.usage.input||0).toLocaleString()} / 输出 ${Number(data.usage.output||0).toLocaleString()} Token · 估算 ¥${Number(data.usage.estimate||0).toFixed(4)}（非账单）`:''}`);
    }catch(error){show(error.status===404?'后台尚未加载关键词生成接口，请重启服务后再试':error.message+(error.usage?` · 输入 ${Number(error.usage.input||0).toLocaleString()} / 输出 ${Number(error.usage.output||0).toLocaleString()} Token · 估算 ¥${Number(error.usage.estimate||0).toFixed(4)}（非账单）${error.usage.unknown?' · 部分用量待核':''}`:''),true);}
    finally{busy=false;button.disabled=false;submit.disabled=false;role.readOnly=false;keywords.readOnly=false;button.textContent='DeepSeek 生成';button.removeAttribute('aria-busy');}
  });
  form.addEventListener('reset',()=>show(''));
  return {get busy(){return busy;}};
}
