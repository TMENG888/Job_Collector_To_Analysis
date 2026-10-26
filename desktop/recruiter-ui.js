/* Trusted shell only. No webpage can upload a path, start a batch or get a key. */
(() => {
  const $=id=>document.getElementById(id),api=window.jobDesktop;
  let current=null,preview=null,working=false,polling=false,uiError='',available=false;
  const resultsView=window.createRecruiterResults($);
  const error=e=>{uiError=e.message;$('recruiterStatus').textContent=uiError;};
  const action=fn=>async()=>{if(working)return;uiError='';working=true;update();try{await fn();}catch(e){error(e);}finally{working=false;await refresh();}};
  const call=(name,value={})=>api.command('recruiter-'+name,value);
  function eligibility(){return window.recruiterEligibility(current,{
    share:$('shareConsent').checked,delivery:$('deliveryConsent').checked,
    count:Number($('recruiterCount').value),coverage:Number($('recruiterCoverage').value),
    budget:Number($('recruiterBudget').value),recipients:Number($('recruiterRecipients').value),interval:Number($('recruiterInterval').value)
  },{working,available});}
  function update(){
    const gate=eligibility(),busy=gate.busy,hasResume=!!current?.resume.configured;
    $('resumeUpload').disabled=busy;$('resumeClear').disabled=!hasResume||working;
    $('resumePreview').disabled=!hasResume||busy;
    $('resumeSelect').disabled=busy||!$('resumeLibrary').value;
    $('resumeLibrary').disabled=busy;
    $('libraryMode').disabled=busy;$('autoTailor').disabled=busy||!$('libraryMode').checked;
    $('recruiterPlan').disabled=!available||busy||!hasResume||!current?.model.configured||!$('shareConsent').checked;
    $('recruiterDryRun').disabled=gate.previewReasons.length>0;
    $('recruiterSend').disabled=gate.sendReasons.length>0;
    $('recruiterDryRun').title=gate.previewReasons.join('；');
    $('recruiterSend').title=gate.sendReasons.join('；');
    const shortReasons={'请逐页预览PDF并确认已核对全部页面':'请核对简历原图','请勾选脱敏简历与JD使用授权':'请勾选模型使用授权','请勾选本批自动沟通授权':'请勾选本批发送授权','本批沟通人数须为1–5的整数':'沟通人数限1–5人','状态未连接，请等待刷新':'状态连接中'};
    const reason=gate.sendReasons[0]||'';
    $('recruiterStartHelp').textContent=shortReasons[reason]||reason;
    $('recruiterStartHelp').hidden=!reason||gate.busy;
    $('recruiterStop').textContent=gate.running&&!gate.sending?'停止预览':'停止本批';
    $('recruiterStop').disabled=!current?.finder.busy;
    $('recruiterStop').hidden=!current?.finder.busy;
    const checks=[...$('resumePages').querySelectorAll('input')],checked=checks.filter(c=>c.checked).length;
    $('resumeAck').disabled=busy||!preview||!checks.length||checked!==checks.length;
    $('resumeAck').textContent=checks.length?`确认核对（${checked}/${checks.length}）`:'确认核对';
    for(const id of ['recruiterCity','recruiterCount','recruiterCoverage','recruiterBudget','recruiterRecipients','recruiterInterval'])$(id).disabled=busy;
  }
  async function refresh(){
    if(polling||document.getElementById('tools').hidden)return;polling=true;
    try{
      const next=await call('state'),old=current;current=next;available=true;
      if(old?.resume.revision!==next.resume.revision){preview=null;$('resumePages').replaceChildren();$('resumePages').hidden=true;$('resumeAck').hidden=true;$('deliveryConsent').checked=false;}
      const r=next.resume,m=next.model,f=next.finder,u=m.usage;
      $('resumeInfo').textContent=r.configured?`${r.filename} · ${r.pages}页 · ${r.previewed?'已核对':'待核对'}`:'未上传简历';
      $('resumeInfo').title='活动简历闲置30分钟从内存清除；加密简历库持久保存';
      const versions=JSON.stringify(next.library?.resumes.map(x=>[x.id,x.status,x.sendable,x.approval?.at]));
      if($('resumeLibrary').dataset.versions!==versions){const select=$('resumeLibrary'),prior=select.value;select.replaceChildren();for(const item of next.library?.resumes||[]){const option=document.createElement('option');option.value=item.id;option.textContent=(item.sendable?'已批准 · ':'待审核 · ')+item.filename;select.append(option);}if(!select.options.length){const o=document.createElement('option');o.value='';o.textContent='简历库暂无版本';select.append(o);}select.value=[...select.options].some(o=>o.value===prior)?prior:r.libraryId||select.options[0].value;select.dataset.versions=versions;}
      $('recruiterModel').textContent=m.configured?`DeepSeek · ${m.model} ＋ 语义相似度与其他岗位参照`:'请在求职助手中配置DeepSeek';
      if(old?.finder.plan?.id!==f.plan?.id){
        $('deliveryConsent').checked=false;$('recruiterQueries').replaceChildren();
        $('recruiterQueryDetails').hidden=!f.plan;
        if(f.plan){$('recruiterQuerySummary').textContent=`检索词 · ${f.plan.queries.length}个`;$('recruiterQuerySummary').title=f.plan.summary;for(const q of f.plan.queries){const item=document.createElement('div');item.className='query-chip';const keyword=document.createElement('strong'),role=document.createElement('small');keyword.textContent=q.keyword;role.textContent=q.role;item.append(keyword,role);item.title=[q.selectionReason,q.resume_evidence,q.modelVersion].filter(Boolean).join('\n');$('recruiterQueries').append(item);}}
      }
      if(f.run&&!uiError){const active=f.run.queryHistory?.at(-1);$('recruiterStatus').textContent=(f.busy?(f.run.delivery?'自动沟通中 · ':'仅匹配预览中 · '):'')+f.run.step+(f.run.status==='running'?` · 当前词已遍历${active?.examined||0}条 · 连续非目标${active?.consecutiveNonTarget||0}/5`:'');}
      resultsView.update(f.run);
      $('recruiterUsage').textContent=`累计 ${u.requests}次请求 · 输入${u.input} / 输出${u.output} Token · 估算¥${u.estimate.toFixed(4)} · 用量未知${u.unknown+(u.inFlight&&!m.busy?1:0)}次。${m.prices.basis}。生成方案另计用量；预算为估算上限。`;
      update();
    }catch(e){available=false;error(e);update();}finally{polling=false;}
  }
  $('resumeUpload').onclick=action(async()=>{const r=await call('upload');if(!r.cancelled)$('recruiterStatus').textContent='简历已上传';});
  $('resumeClear').onclick=action(()=>call('clear'));
  $('resumeSelect').onclick=action(()=>call('select',{id:$('resumeLibrary').value}));
  $('resumeLibraryOpen').onclick=()=>api.command('workspace',{route:'profile'}).catch(error);
  $('resumePreview').onclick=action(async()=>{
    preview=await call('preview');$('resumePages').replaceChildren();$('resumePages').hidden=false;
    for(const page of preview.pages){const label=document.createElement('label');label.className='pdf-page';const img=document.createElement('img'),checkbox=document.createElement('input');checkbox.disabled=true;img.onload=()=>{checkbox.disabled=false;update();};img.onerror=()=>{checkbox.disabled=true;uiError='简历图片未加载，请重新预览';update();};img.src=`data:${page.mime};base64,${page.base64}`;img.alt=`原版式简历第${page.page}页`;checkbox.type='checkbox';checkbox.dataset.hash=page.sha256;checkbox.onchange=update;const text=document.createElement('span');text.textContent=`第${page.page}页已核对`;label.append(img,checkbox,text);$('resumePages').append(label);}
    $('resumeAck').hidden=false;
  });
  $('resumeAck').onclick=action(async()=>{if(!preview)return;const checks=[...$('resumePages').querySelectorAll('input')];if(checks.some(c=>!c.checked))throw Error('请逐页核对并勾选');await call('ack',{ticket:preview.ticket,revision:preview.revision,pages:checks.map(c=>c.dataset.hash)});$('resumePages').hidden=true;$('resumePages').replaceChildren();$('resumeAck').hidden=true;preview=null;});
  $('recruiterPlan').onclick=action(async()=>{await call('plan',{shareConfirmed:$('shareConsent').checked,budget:Number($('recruiterBudget').value)});$('recruiterStatus').textContent='检索词已生成';});
  function body(send){const p=current.finder.plan,r=current.resume;return {planId:p.id,libraryMode:$('libraryMode').checked,autoTailor:$('autoTailor').checked,wikiShareConfirmed:$('shareConsent').checked,city:$('recruiterCity').value.trim(),maxCandidates:Number($('recruiterCount').value),minCoverage:Number($('recruiterCoverage').value)/100,budget:Number($('recruiterBudget').value),delivery:send?{enabled:true,confirmed:$('deliveryConsent').checked,planId:p.id,resumeRevision:r.revision,documentHash:r.documentHash,maxRecipients:Number($('recruiterRecipients').value),intervalSeconds:Number($('recruiterInterval').value)}:{enabled:false}};}
  function start(send){
    const gate=eligibility(),reasons=send?gate.sendReasons:gate.previewReasons;
    if(reasons.length){error(Error(reasons.join('；')));update();return;}
    return action(()=>call('start',body(send)))();
  }
  $('recruiterDryRun').onclick=()=>start(false);
  $('recruiterSend').onclick=()=>start(true);
  // Stop is not blocked by an outstanding plan request or page preview.
  $('recruiterStop').onclick=async()=>{const previewOnly=!current?.finder.run?.delivery;try{await call('cancel');$('recruiterStatus').textContent=previewOnly?'已请求停止预览；停止后需重新点击授权，不会自动发送':'已请求停止，请核对最后一条发送记录';}catch(e){error(e);}await refresh();};
  for(const id of ['shareConsent','deliveryConsent','libraryMode','autoTailor','resumeLibrary'])$(id).onchange=()=>{$('deliveryConsent').checked=false;update();};
  $('deliveryConsent').onchange=update;
  for(const id of ['recruiterCount','recruiterCoverage','recruiterBudget','recruiterRecipients','recruiterInterval'])$(id).oninput=update;
  update();
  api.onState(()=>{void refresh();});setInterval(()=>{void refresh();},1500);void refresh();
})();
