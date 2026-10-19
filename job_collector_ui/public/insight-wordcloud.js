const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function wordCloudTerms(terms,limit=100){
  const known=new Map();
  for(const term of terms||[]){
    const name=String(term.name??term.term??'').trim();
    if(!name)continue;
    const score=Number(term.score),count=Number(term.seed_count??term.seed_df??term.count);
    const weight=Number.isFinite(score)&&score>0?score:Number.isFinite(count)&&count>0?count:1;
    if(!known.has(name)||known.get(name).weight<weight)known.set(name,{...term,name,weight});
  }
  return [...known.values()].sort((a,b)=>b.weight-a.weight||a.name.localeCompare(b.name)).slice(0,limit);
}
const intersects=(a,b)=>a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;
export function layoutWordCloud(terms,measure=(name,size)=>[...name].reduce((sum,c)=>sum+(/[\u0000-\u00ff]/.test(c)?0.62:1),0)*size){
  const words=wordCloudTerms(terms),width=900,baseHeight=words.length>60?640:520;
  const largest=words[0]?.weight||1,smallest=words.at(-1)?.weight||1;
  // Repack at a smaller scale if crowded; never append a linear word list.
  for(let attempt=0;attempt<80;attempt++){
  const boxes=[];
  let failed=false;
  for(const word of words){
    const ratio=largest===smallest?0.5:(Math.sqrt(word.weight)-Math.sqrt(smallest))/(Math.sqrt(largest)-Math.sqrt(smallest));
    let fontSize=(12+ratio*(words.length>60?20:34))*Math.pow(0.94,attempt);
    fontSize=Math.min(fontSize,Math.max(10,(width-28)/Math.max(1,measure(word.name,1))));
    const boxWidth=Math.ceil(measure(word.name,fontSize))+8,boxHeight=Math.ceil(fontSize*1.25)+6;
    let placed;
    for(let step=0;step<6000;step++){
      const angle=step*2.3999632297,radius=(1-ratio)*180+Math.sqrt(step)*4;
      const box={x:width/2+Math.cos(angle)*radius-boxWidth/2,y:baseHeight/2+Math.sin(angle)*radius*0.72-boxHeight/2,width:boxWidth,height:boxHeight};
      if(box.x>=8&&box.y>=8&&box.x+box.width<=width-8&&box.y+box.height<=baseHeight-8&&!boxes.some(b=>intersects(box,b))){placed=box;break;}
    }
    if(!placed){failed=true;break;}
    boxes.push({...word,...placed,fontSize});
  }
  if(!failed)return {words:boxes,width,height:baseHeight};
  }
  throw new Error('关键词中心布局无法容纳全部词语');
}
export function renderKeywordWordCloud(terms,options={}){
  let measure;
  if(typeof document!=='undefined'){
    const context=document.createElement('canvas').getContext('2d');
    if(context)measure=(name,size)=>{context.font=`600 ${size}px "Segoe UI", "Microsoft YaHei", sans-serif`;return context.measureText(name).width;};
  }
  const layout=layoutWordCloud(terms,measure);
  if(!layout.words.length)return '<p class="empty">暂无可展示的关键词</p>';
  const title=options.title||'岗位关键词词云';
  const detailFor=options.detailFor || (word=>`${word.name}${word.category?`；${word.category}`:''}；种子岗位 ${word.seed_count??word.seed_df??'—'} 条；学习权重 ${word.score??'—'}${Number.isFinite(Number(word.lift))?`；Lift ${Number(word.lift).toFixed(2)}`:''}${word.used_for_filter===false?'；仅展示，不参与岗位筛选':''}`);
  const left=Math.min(...layout.words.map(w=>w.x)),top=Math.min(...layout.words.map(w=>w.y));
  const right=Math.max(...layout.words.map(w=>w.x+w.width)),bottom=Math.max(...layout.words.map(w=>w.y+w.height));
  const bounds=`${left-18} ${top-18} ${right-left+36} ${bottom-top+36}`;
  return `<div class="wordcloud-controls" aria-label="${escape(title)}缩放"><button type="button" data-cloud-zoom="in" aria-label="放大词云">＋</button><button type="button" data-cloud-zoom="out" aria-label="缩小词云">−</button><button type="button" data-cloud-zoom="reset">重置</button><output class="wordcloud-scale">100%</output></div><div class="insight-wordcloud"><svg viewBox="${bounds}" data-cloud-base="${bounds}" data-cloud-scale="1" role="img" aria-label="${escape(title)}，共${layout.words.length}个词"><title>${escape(title)}</title>${layout.words.map(word=>{
    const detail=detailFor(word);
    return `<text x="${(word.x+word.width/2).toFixed(2)}" y="${(word.y+word.height/2).toFixed(2)}" text-anchor="middle" dominant-baseline="central" font-size="${word.fontSize.toFixed(2)}" font-weight="600" tabindex="0" aria-label="${escape(detail)}"><title>${escape(detail)}</title>${escape(word.name)}</text>`;
  }).join('')}</svg><div class="wordcloud-mobile" role="list" aria-label="${escape(title)}，手机可读版">${layout.words.map(word=>`<span role="listitem" style="font-size:${Math.max(13,Math.min(24,word.fontSize)).toFixed(1)}px" title="${escape(detailFor(word))}">${escape(word.name)}</span>`).join('')}</div></div>`;
}

// One delegated binding survives chart replacement when cohort filters change.
export function installWordCloudInteractions(root=document){
  function zoom(svg,factor,reset=false){
    const base=svg.dataset.cloudBase.split(' ').map(Number);
    const view=svg.getAttribute('viewBox').split(' ').map(Number);
    const scale=reset?1:Math.max(0.75,Math.min(6,Number(svg.dataset.cloudScale||1)*factor));
    const width=base[2]/scale,height=base[3]/scale;
    svg.setAttribute('viewBox',reset?base.join(' '):[view[0]+view[2]/2-width/2,view[1]+view[3]/2-height/2,width,height].join(' '));
    svg.dataset.cloudScale=String(scale);
    svg.parentElement.previousElementSibling.querySelector('output').textContent=`${Math.round(scale*100)}%`;
  }
  root.addEventListener('click',event=>{
    const button=event.target.closest('[data-cloud-zoom]');
    if(!button)return;
    const svg=button.closest('.wordcloud-controls').nextElementSibling.querySelector('svg');
    zoom(svg,button.dataset.cloudZoom==='in'?1.25:0.8,button.dataset.cloudZoom==='reset');
  });
  root.addEventListener('wheel',event=>{
    const svg=event.target.closest('.insight-wordcloud svg');
    if(!svg||!event.ctrlKey)return;
    event.preventDefault();
    zoom(svg,Math.exp(-Math.max(-100,Math.min(100,event.deltaY))*0.003));
  },{passive:false});
  let drag;
  root.addEventListener('pointerdown',event=>{
    const svg=event.target.closest('.insight-wordcloud svg');
    if(!svg||event.button!==0)return;
    const rect=svg.getBoundingClientRect(),view=svg.getAttribute('viewBox').split(' ').map(Number);
    drag={svg,id:event.pointerId,x:event.clientX,y:event.clientY,view,unit:Math.max(view[2]/rect.width,view[3]/rect.height)};
    svg.setPointerCapture(event.pointerId);
    svg.classList.add('dragging');
  });
  root.addEventListener('pointermove',event=>{
    if(!drag||event.pointerId!==drag.id)return;
    const {svg,x,y,view,unit}=drag;
    svg.setAttribute('viewBox',[view[0]-(event.clientX-x)*unit,view[1]-(event.clientY-y)*unit,view[2],view[3]].join(' '));
  });
  const stop=()=>{if(drag)drag.svg.classList.remove('dragging');drag=null;};
  root.addEventListener('pointerup',stop);
  root.addEventListener('pointercancel',stop);
  root.addEventListener('lostpointercapture',stop);
}
