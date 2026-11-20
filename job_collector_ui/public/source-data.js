export const escapeSource=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const number=value=>new Intl.NumberFormat('zh-CN').format(value||0);
const text=value=>value==null||value===''?'—':typeof value==='object'?JSON.stringify(value):String(value);
export const sourceFields=[['job_name','岗位名称'],['platform','平台'],['company_name','公司名称'],['salary','原始薪资'],['city','工作地点'],['experience','经验要求'],['education','学历要求'],['job_description','岗位正文'],['query_keyword','检索关键词'],['collected_at','采集时间'],['task','来源任务'],['job_id','岗位ID'],['district','区县'],['employment_type','用工类型'],['industry','行业'],['company_size','公司规模'],['company_nature','公司性质'],['publish_time','发布时间'],['refresh_time','刷新时间'],['deadline','截止时间'],['tags','平台标签'],['skills','平台技能字段'],['address','工作地址'],['query_city','查询城市'],['detail_status','采集完整状态'],['acquisition_mode','采集方式'],['job_url','岗位链接'],['company_id','公司ID'],['company_url','公司链接']];
const fieldLabels=Object.fromEntries([...sourceFields,['task_id','任务ID'],['query_keywords','命中关键词'],['recruiter_name','招聘者'],['recruiter_title','招聘者职务'],['source_total','来源查询总量'],['access_level','字段获取说明']]);
const initialFields=sourceFields.slice(0,12).map(([key])=>key);
export const processedSourceFields=[['original_salary','采集薪资'],['salary_min','月薪下限（元）'],['salary_max','月薪上限（元）'],['salary_midpoint_k','月薪中点（K）'],['salary_basis','薪资处理依据'],['province','省份'],['original_city','采集地点'],['original_education','采集学历'],['original_experience','采集经验'],['salary_usable','薪资可用性'],['body_usable','正文可用性'],['region_usable','地区可用性'],['issues','处理说明'],['processing_state','清洗状态'],['source_tasks','关联采集任务']];
function value(row,key){return key==='task'?row.taskLabel:key==='platform'?row.platform:key==='job_id'?row.jobId:key==='job_description'?row.descriptionPreview:row.fields[key];}
function safeURL(raw){try{const url=new URL(raw);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.href:'';}catch{return '';}}
export function renderSourceTable(rows,keys=initialFields){
  const columns=[...sourceFields,...processedSourceFields].filter(([key])=>keys.includes(key));
  return `<table><caption class="source-sr">爬虫采集入库源数据</caption><thead><tr><th scope="col">序号</th>${columns.map(([,label])=>`<th scope="col">${label}</th>`).join('')}<th scope="col" class="source-action-col">记录详情</th></tr></thead><tbody>${rows.length?rows.map((row,i)=>`<tr><td>${number(row.rowNumber??i+1)}</td>${columns.map(([key])=>`<td class="source-cell source-cell-${key}"><span title="${escapeSource(text(value(row,key)))}">${escapeSource(text(value(row,key)))}</span></td>`).join('')}<td class="source-action-col"><button class="ghost" type="button" data-source-detail="${i}" aria-label="查看${escapeSource(row.fields.job_name||row.jobId)}的完整源数据">查看</button></td></tr>`).join(''):`<tr><td class="source-empty" colspan="${columns.length+2}">当前条件没有采集记录，请调整任务、平台或关键词。</td></tr>`}</tbody></table>`;
}
export function renderSourceDetail(raw){
  const order=[...sourceFields.map(([key])=>key).filter(key=>key!=='task'),...Object.keys(raw)],keys=[...new Set(order)].filter(key=>Object.hasOwn(raw,key));
  const url=safeURL(raw.job_url);
  return `<div class="source-detail-title"><h3>${escapeSource(text(raw.job_name))}</h3><p>${escapeSource(text(raw.platform))} · ${escapeSource(text(raw.job_id))}</p>${url?`<a href="${escapeSource(url)}" target="_blank" rel="noopener noreferrer">查看原始岗位 ↗</a>`:''}</div><dl class="source-detail-fields">${keys.map(key=>`<div class="${key==='job_description'?'source-body-field':''}"><dt>${escapeSource(fieldLabels[key]||key)}<small>${escapeSource(key)}</small></dt><dd>${escapeSource(text(raw[key]))}</dd></div>`).join('')}</dl><details class="source-json"><summary>原始记录 JSON</summary><pre>${escapeSource(JSON.stringify(raw,null,2))}</pre></details>`;
}
let installed;
export async function loadSourceData({api,toast}){
  if(installed){await installed.load();return;}
  const root=document.querySelector('#qualityView');if(!root)return;
  root.innerHTML=`<p class="source-intro">浏览爬虫采集入库的岗位字段，点击记录可查看完整正文。相同岗位在不同任务中分别列出。</p><form id="sourceFilters" class="source-toolbar"><label>采集任务<select id="sourceTask"><option value="all">全部采集任务</option></select></label><label>平台<select id="sourcePlatform"><option value="all">全部平台</option></select></label><label class="source-search">搜索源数据<input id="sourceQuery" type="search" maxlength="120" placeholder="岗位、公司、城市、关键词或正文" autocomplete="off" /></label><button class="primary" type="submit">查询</button><button class="secondary" id="sourceRefresh" type="button">刷新数据</button></form><div class="source-controls"><div id="sourceStatus" role="status" aria-live="polite"></div><details class="source-column-picker"><summary>显示字段</summary><div>${sourceFields.map(([key,label])=>`<label><input type="checkbox" value="${key}"${initialFields.includes(key)?' checked':''} />${label}</label>`).join('')}</div></details></div><div id="sourceWarnings" class="source-warnings" hidden></div><div id="sourceTable" class="source-table-scroll" tabindex="0" role="region" aria-label="采集源数据表格" aria-busy="false"></div><div class="source-pagination"><label>每页<select id="sourcePageSize"><option>20</option><option selected>50</option><option>100</option></select>条</label><span id="sourceRange"></span><div><button class="ghost" type="button" id="sourcePrev" disabled>上一页</button><span id="sourcePage">1 / 1</span><button class="ghost" type="button" id="sourceNext" disabled>下一页</button><label>跳至<input id="sourceJump" type="number" min="1" value="1" aria-label="跳转页码" />页</label><button class="secondary" type="button" id="sourceGo" disabled>跳转</button></div></div><dialog id="sourceDetailDialog" aria-labelledby="sourceDetailHeading"><header><h2 id="sourceDetailHeading">源数据详情</h2><button class="ghost" type="button" id="sourceClose" aria-label="关闭源数据详情">×</button></header><p id="sourceDetailTask" class="source-muted"></p><div id="sourceDetailContent"></div></dialog>`;
  const q=selector=>root.querySelector(selector);let current=null,busy=false,page=1,detailToken=0,applied={taskId:'all',platform:'all',q:''};
  const columns=()=>[...root.querySelectorAll('.source-column-picker input:checked')].map(input=>input.value);
  function render(){if(current)q('#sourceTable').innerHTML=renderSourceTable(current.rows,columns());}
  function controls(){
    for(const element of q('#sourceFilters').elements)element.disabled=busy;
    q('#sourcePageSize').disabled=busy;q('#sourceJump').disabled=busy;
    q('#sourcePrev').disabled=busy||!current||page<=1;q('#sourceNext').disabled=busy||!current||page>=current.pages;q('#sourceGo').disabled=busy||!current;
  }
  async function load({reset=false,filters=false}={}){
    if(busy)return;
    if(filters)applied={taskId:q('#sourceTask').value,platform:q('#sourcePlatform').value,q:q('#sourceQuery').value.trim()};
    if(reset)page=1;
    busy=true;controls();q('#sourceTable').setAttribute('aria-busy','true');q('#sourceStatus').classList.remove('source-error');q('#sourceStatus').textContent='正在读取采集记录…';
    try{
      const result=await api('/api/knowledge/source-data?'+new URLSearchParams({...applied,page,pageSize:q('#sourcePageSize').value}),{timeoutMs:60000});
      current=result;page=result.scope.page;current.rows.forEach((row,i)=>row.rowNumber=(page-1)*result.scope.pageSize+i+1);
      q('#sourceTask').innerHTML='<option value="all">全部采集任务</option>'+result.tasks.map(task=>`<option value="${escapeSource(task.id)}">${escapeSource(task.label)}（${task.available?number(task.rows):'暂不可读'}）</option>`).join('');q('#sourceTask').value=applied.taskId;
      q('#sourcePlatform').innerHTML='<option value="all">全部平台</option>'+result.platforms.map(p=>`<option value="${escapeSource(p.platform)}">${escapeSource(p.platform)}（${number(p.rows)}）</option>`).join('');
      if(applied.platform!=='all'&&!result.platforms.some(p=>p.platform===applied.platform))q('#sourcePlatform').insertAdjacentHTML('beforeend',`<option value="${escapeSource(applied.platform)}">${escapeSource(applied.platform)}（0）</option>`);
      q('#sourcePlatform').value=applied.platform;
      q('#sourceStatus').textContent=`共 ${number(result.total)} 条采集记录${applied.q?' · 已按关键词筛选':''}`;
      q('#sourceWarnings').hidden=!result.warnings.length;q('#sourceWarnings').textContent=result.warnings.join('；');
      q('#sourcePage').textContent=`${page} / ${result.pages}`;q('#sourceJump').value=page;q('#sourceJump').max=result.pages;
      const start=result.total?(page-1)*result.scope.pageSize+1:0;q('#sourceRange').textContent=`显示 ${number(start)}—${number(start?start+result.rows.length-1:0)} 条`;
      render();
    }catch(error){
      q('#sourceStatus').classList.add('source-error');q('#sourceStatus').textContent=`读取失败：${error.message}`;
      current=null;q('#sourceTable').innerHTML='<p class="source-empty">本次查询未完成，请调整条件或点击刷新数据重试。</p>';q('#sourceRange').textContent='';q('#sourcePage').textContent='—';
    }finally{busy=false;controls();q('#sourceTable').setAttribute('aria-busy','false');}
  }
  q('#sourceFilters').addEventListener('submit',event=>{event.preventDefault();void load({reset:true,filters:true});});
  q('#sourceTask').addEventListener('change',()=>{q('#sourcePlatform').value='all';void load({reset:true,filters:true});});
  q('#sourcePlatform').addEventListener('change',()=>void load({reset:true,filters:true}));
  q('#sourceRefresh').addEventListener('click',()=>void load({reset:true,filters:true}));
  q('#sourcePageSize').addEventListener('change',()=>void load({reset:true}));
  q('#sourcePrev').addEventListener('click',()=>{if(busy)return;page--;void load();});
  q('#sourceNext').addEventListener('click',()=>{if(busy)return;page++;void load();});
  const jump=()=>{if(busy||!current)return;const n=Number(q('#sourceJump').value);if(!Number.isSafeInteger(n)||n<1||n>current.pages){toast(`请输入1—${current.pages}之间的页码`);return;}page=n;void load();};
  q('#sourceGo').addEventListener('click',jump);q('#sourceJump').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();jump();}});
  root.querySelector('.source-column-picker').addEventListener('change',event=>{if(!columns().length){event.target.checked=true;toast('请至少保留一个字段');}render();});
  q('#sourceClose').addEventListener('click',()=>q('#sourceDetailDialog').close());q('#sourceDetailDialog').addEventListener('close',()=>detailToken++);
  q('#sourceTable').addEventListener('click',async event=>{
    const button=event.target.closest('[data-source-detail]');if(!button||!current||busy)return;
    const row=current.rows[Number(button.dataset.sourceDetail)];if(!row)return;
    const token=++detailToken;q('#sourceDetailTask').textContent=row.taskLabel;q('#sourceDetailContent').textContent='正在读取完整记录…';q('#sourceDetailDialog').showModal();
    try{const result=await api('/api/knowledge/source-data/detail?'+new URLSearchParams({taskId:row.taskId,platform:row.platform,jobId:row.jobId}));if(token===detailToken)q('#sourceDetailContent').innerHTML=renderSourceDetail(result.raw);}
    catch(error){if(token===detailToken)q('#sourceDetailContent').textContent='读取失败：'+error.message;}
  });
  installed={load};await load();
}
