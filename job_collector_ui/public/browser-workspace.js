import {installInteractiveMirror} from './browser-interactive.js?v=20261019-interaction-fix-9';
import {createBrowserMirror} from './browser-mirror.js?v=20261019-interactive-8';
import {installBrowserFinder} from './browser-finder.js?v=20261019-interactive-8';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function browserNavigationURL(value,fallback=''){
  let text=String(value||'').trim()||String(fallback||'').trim();
  if(!text)throw Error('请填写招聘网站地址，或选择一个招聘网站');
  if(!/^[a-z][a-z\d+.-]*:/i.test(text))text='https://'+text;
  let url;try{url=new URL(text);}catch{throw Error('招聘网站地址不完整，请填写域名，例如 www.zhipin.com');}
  if(url.protocol!=='https:'||url.username||url.password||url.port)throw Error('请使用不含账户信息和自定义端口的HTTPS招聘网站地址');
  const domains=['zhipin.com','liepin.com','zhaopin.com','51job.com','iguopin.com','shixiseng.com'];
  if(!domains.some(d=>url.hostname===d||url.hostname.endsWith('.'+d)))throw Error('此地址不是已接入的招聘网站');
  return url.href;
}
// Coalesce only adjacent transient events. Clicks, text and key edges stay ordered.
export function createBrowserInputQueue({send,onError=()=>{},delayMs=16,maxBatch=32,maxPending=512}){
  let pending=[],inFlight=false,timer=null,generation=0,idle=[];
  const settle=()=>{if(!pending.length&&!inFlight){for(const resolve of idle.splice(0))resolve();}};
  function schedule(){if(!timer&&!inFlight&&pending.length)timer=setTimeout(()=>{timer=null;void drain();},delayMs);}
  async function drain(){
    if(inFlight||!pending.length){settle();return;}
    const batch=pending.splice(0,maxBatch),version=generation;inFlight=true;
    try{await send(batch);}
    catch(e){if(version===generation){pending=[];onError(e);}} // Never replay uncertain input.
    finally{inFlight=false;if(pending.length)schedule();else settle();}
  }
  return {
    push(input){
      const last=pending.at(-1);
      if(last?.type==='mouse'&&input.type==='mouse'&&last.event===input.event&&last.buttons===input.buttons){
        if(input.event==='mouseMoved'){pending[pending.length-1]=input;schedule();return;}
        if(input.event==='mouseWheel'&&last.x===input.x&&last.y===input.y&&Math.abs(last.deltaX+input.deltaX)<=2000&&Math.abs(last.deltaY+input.deltaY)<=2000){last.deltaX+=input.deltaX;last.deltaY+=input.deltaY;schedule();return;}
      }
      if(pending.length>=maxPending){this.clear();onError(Error('输入积压，已停止转发；请核对网页后继续操作，不自动重试'));return;}
      pending.push({...input});schedule();
    },
    clear(){generation++;pending=[];clearTimeout(timer);timer=null;settle();},
    flush(){clearTimeout(timer);timer=null;void drain();return pending.length||inFlight?new Promise(resolve=>idle.push(resolve)):Promise.resolve();},
    get pending(){return pending.length;}
  };
}
export function installJobBrowserWorkspace({api,toast}){
  const root=document.querySelector('#jobBrowserWorkspace');if(!root)return;
  root.innerHTML=`<div class="jb-workspace"><div class="jb-notice" data-jb-notice role="status">浏览器待启动</div><section class="jb-window" aria-label="招聘网页"><div class="jb-tabs" data-jb-tabs></div><form class="jb-nav" data-jb-nav><button type="button" data-jb-back title="后退">←</button><button type="button" data-jb-forward title="前进">→</button><button type="button" data-jb-reload title="刷新网页">↻</button><input class="jb-address" data-jb-address aria-label="招聘网站地址" placeholder="https://www.zhipin.com/" autocomplete="off"><button type="submit" title="访问地址">访问</button><button type="button" data-jb-fullscreen title="全屏网页">⛶</button></form><div class="jb-stage" data-jb-stage><canvas class="jb-canvas" data-jb-canvas width="1280" height="800" tabindex="0" aria-label="可交互的招聘网页，点击后可输入文字、滚动及操作" hidden></canvas><textarea class="jb-ime" data-jb-ime aria-label="网页键盘输入" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea><div class="jb-empty" data-jb-empty><svg viewBox="0 0 64 64"><rect x="5" y="9" width="54" height="44" rx="6"/><path d="M5 21h54M12 15h2m5 0h2m5 0h2M17 34l7 7 20-15"/></svg><h2>在这里打开招聘网站</h2><div class="jb-sites" data-jb-sites></div><p>独立本机浏览器 · 登录状态保留在本机</p></div></div><div class="jb-footer"><span class="jb-status" data-jb-status>尚未连接</span><button type="button" class="ghost" data-jb-reconnect>重连画面</button></div></section><aside class="jb-sidebar"><section class="jb-panel"><h2>求职插件 <span class="jb-badge">本机运行</span></h2><form data-jb-search><label>招聘网站<select data-jb-site></select></label><div class="jb-row"><label>岗位<input data-jb-keyword placeholder="如销售工程师" maxlength="80"></label><label>城市<input data-jb-city placeholder="全国或城市名" maxlength="30"></label></div><button class="secondary" type="submit">按条件搜索</button></form></section><section class="jb-panel"><h2>简历匹配</h2><span data-jb-resume-state class="jb-badge">尚未提供简历</span><div data-jb-document-preview></div><input type="file" data-jb-file accept=".txt,.md,.pdf,.docx" hidden><div class="jb-row"><button class="ghost" data-jb-upload type="button">上传文件</button><button class="ghost" data-jb-clear type="button">清除</button></div><p>PDF保留原版式截图；DOCX仅解析，截图需先另存PDF。简历闲置30分钟清除。</p><button type="button" data-jb-preview-pages hidden>预览全部原版式截图</button><button class="primary" data-jb-match type="button" disabled>分析当前岗位匹配度</button><div data-jb-analysis></div></section><section class="jb-panel"><h2>沟通与智能投递</h2><label>沟通草稿<textarea data-jb-message maxlength="2000" rows="6" placeholder="匹配后生成草稿，也可自行填写"></textarea></label><div class="jb-row"><button class="secondary" data-jb-prepare-message type="button" disabled>准备发送</button><button class="primary" data-jb-prepare-apply type="button" disabled>准备投递 / 沟通</button></div><p>此处为单次沟通确认；上方“简历找岗位”可单独授权本批招呼与PDF截图。验证或结果不明即停止。</p></section><details class="jb-panel"><summary>插件权限与运行记录</summary><ul data-jb-permissions class="jb-plugin-list jb-permissions"></ul><p data-jb-usage></p><p data-jb-model></p></details></aside></div><dialog class="jb-confirm" data-jb-confirm aria-labelledby="jbConfirmTitle"><h2 id="jbConfirmTitle">确认执行</h2><p data-jb-target></p><pre data-jb-content></pre><p data-jb-action-note></p><p data-jb-expires></p><div class="jb-row"><button class="ghost" type="button" data-jb-cancel>取消</button><button class="primary" type="button" data-jb-confirm-button>确认执行一次</button></div></dialog>`;
  const $=s=>root.querySelector(s),canvas=$('[data-jb-canvas]'),ime=$('[data-jb-ime]');
  $('[data-jb-tabs]').insertAdjacentHTML('beforebegin','<form class="jb-browser-config" data-jb-config hidden><label>交互模式<select data-jb-mode><option value="extension">普通浏览器＋本地扩展（推荐）</option><option value="native">受控原生窗口（Playwright）</option><option value="embedded">内嵌画面（兼容模式）</option></select></label><label>浏览器<select data-jb-engine></select></label><button type="submit" data-jb-save-config>保存配置</button><button type="button" data-jb-launch>启动浏览器</button><button type="button" data-jb-pair hidden>连接扩展</button><span data-jb-config-status></span></form><section class="jb-extension-setup" data-jb-setup hidden><h3>首次连接本地扩展</h3><p>在刚打开的独立普通浏览器中，手动打开扩展管理页 → 开启开发者模式 → 加载已解压的扩展，选择下方文件夹。然后点击“本机岗位助手”扩展并输入连接码。</p><label>扩展文件夹<input data-jb-extension-path readonly></label><label>一次性连接码<input data-jb-pair-code readonly autocomplete="off"></label><p data-jb-pair-expires></p><p>代码只粘贴到本机岗位助手扩展，不在招聘网站输入。浏览器或服务重启后需重新连接；不会复制旧登录资料。</p></section>');
  $('[data-jb-setup] h3').insertAdjacentHTML('afterend','<button type="button" data-jb-extension-manager>打开扩展管理页</button>');
  $('[data-jb-config]').insertAdjacentHTML('afterend','<div class="jb-mirror-controls" data-jb-mirror-controls hidden><button type="button" data-jb-share>共享浏览器画面</button><button type="button" data-jb-end-share hidden>停止镜像</button><span data-jb-mirror-state>只读镜像 · 点击、输入请在普通浏览器中完成</span></div>');
  $('[data-jb-stage]').insertAdjacentHTML('beforeend','<video class="jb-mirror-video" data-jb-mirror-video autoplay playsinline muted hidden aria-label="用户授权的浏览器只读镜像"></video>');
  $('[data-jb-empty]').insertAdjacentHTML('afterend','<div class="jb-native" data-jb-native hidden><h2>原生浏览器窗口已连接</h2><p data-jb-native-title></p><button type="button" class="primary" data-jb-focus>打开当前浏览器标签</button><p>在浏览器窗口操作网页，在右侧使用求职插件。</p><small data-jb-profile></small></div>');
  $('[data-jb-reconnect]').insertAdjacentHTML('beforebegin','<button type="button" class="ghost" data-jb-stop>关闭浏览器</button>');
  $('[data-jb-match]').insertAdjacentHTML('beforebegin','<button type="button" class="secondary" data-jb-read-detail>读取当前岗位</button><div data-jb-preview></div>');
  $('[data-jb-notice]').insertAdjacentHTML('afterend','<div class="jb-notice error" data-jb-update hidden>浏览器后端待重启更新：回车、新版岗位读取和连续跳转保护尚未加载。</div>');
  let state=null,visible=false,loading=false,events=null,streamId=null,frameSerial=0,frame=null,confirmation=null,disposed=false,resizing=null,composing=false,compositionText='',timer=null,pendingFrame=null,decoding=false,tabsHTML='',previewHTML='',inputTab=null,lastSize='';
  const selected=()=>state?.tabs?.find(t=>t.id===state.selectedTabId);
  const mode=()=>state?.running?state.mode:state?.browserManagement?.settings.mode;
  const extension=()=>mode()==='extension';
  const native=()=>state?.features?.nativeWindow&&['native','extension'].includes(mode());
  let configurationDirty=false,engineHTML='';
  for(const selector of ['[data-jb-mode]','[data-jb-engine]'])$(selector).addEventListener('change',()=>{configurationDirty=true;});
  let addressDirty=false,preview=null,lastAccessKey=null;
  $('[data-jb-address]').addEventListener('input',()=>{addressDirty=true;});
  const note=(text,error=false)=>{const n=$('[data-jb-notice]');n.textContent=text;n.classList.toggle('error',error);};
  const mirror=createBrowserMirror({video:$('[data-jb-mirror-video]'),onState:value=>{
    $('[data-jb-end-share]').hidden=!value.active;
    $('[data-jb-share]').textContent=value.active?'更换共享画面':'共享浏览器画面';
    $('[data-jb-mirror-state]').textContent=value.active?'镜像中 · 只在本页显示，不上传 · 操作请在原窗口完成':'只读镜像 · 点击、输入请在普通浏览器中完成';
    render();
  }});
  const interactive=installInteractiveMirror({root,post,note,stopVideo:()=>mirror.stop()});
  const finderUI=installBrowserFinder({root,post,refresh,note});
  async function post(route,body={}){if(!state?.token)await refresh();return api('/api/browser/'+route,{method:'POST',headers:{'content-type':'application/json','x-job-browser-token':state.token},body:JSON.stringify(body),timeoutMs:route==='input'||route==='input-batch'?5000:75000});}
  async function action(route,body={}){if(['navigate','back','forward','reload','select','close-tab','new-tab','stop'].includes(route))inputQueue.clear();const result=await post(route,{tabId:selected()?.id,...body});if(result?.tabs)state={...state,...result};render();return result;}
  function paint(payload){
    if(payload.tabId!==streamId||!visible||document.hidden)return;
    if(selected()?.url==='about:blank'){frame=null;canvas.hidden=true;$('[data-jb-empty]').hidden=false;return;}
    pendingFrame=payload;if(!decoding)decodeFrame();
  }
  function decodeFrame(){
    if(!pendingFrame)return;const payload=pendingFrame,serial=frameSerial,img=new Image();pendingFrame=null;decoding=true;
    const next=()=>{decoding=false;if(pendingFrame)decodeFrame();};
    img.onload=()=>requestAnimationFrame(()=>{
      if(serial===frameSerial&&payload.tabId===streamId&&visible&&!document.hidden){
        frame=payload;
        if(canvas.width!==img.width||canvas.height!==img.height){canvas.width=img.width;canvas.height=img.height;canvas.style.aspectRatio=`${img.width} / ${img.height}`;$('[data-jb-stage]').style.aspectRatio=canvas.style.aspectRatio;}
        canvas.getContext('2d').drawImage(img,0,0);canvas.hidden=false;$('[data-jb-empty]').hidden=true;
      }
      next();
    });
    img.onerror=next;
    img.src='data:image/jpeg;base64,'+payload.data;
  }
  function connectStream(){
    const id=selected()?.id;
    if(native()){events?.close();events=null;streamId=null;pendingFrame=null;frame=null;frameSerial++;canvas.hidden=true;return;}
    if(!visible||document.hidden||!id){events?.close();events=null;streamId=null;pendingFrame=null;frameSerial++;if(!id){frame=null;canvas.hidden=true;$('[data-jb-empty]').hidden=false;}return;}
    if(events&&streamId===id)return;
    events?.close();frameSerial++;pendingFrame=null;streamId=id;frame=null;canvas.hidden=true;$('[data-jb-empty]').hidden=false;
    events=new EventSource('/api/browser/events?tabId='+encodeURIComponent(id));
    events.addEventListener('frame',e=>paint(JSON.parse(e.data)));
    events.addEventListener('state',e=>{state={...state,...JSON.parse(e.data)};render();});
    events.onerror=()=>{$('[data-jb-status]').textContent='画面重连中…';};
  }
  function renderAnalysis(){
    const a=state?.analysis;if(!a){$('[data-jb-analysis]').replaceChildren();return;}
    const evidence=(items,gap)=>items.map(m=>`<div class="jb-match-evidence ${gap?'gap':''}"><b>${esc(m.requirement)}</b><blockquote>JD：${esc(m.jd_evidence)}</blockquote><blockquote>${gap?'待核实：'+esc(m.note):'简历：'+esc(m.resume_evidence)}</blockquote></div>`).join('');
    $('[data-jb-analysis]').innerHTML=`<h3>${esc(a.job.title)}</h3><p>${esc(a.job.company)}</p><div class="jb-coverage"><strong>${Math.round(a.coverage*100)}%</strong><small>本次已核对要求的证据覆盖率<br>非录用概率或全岗位适配评分</small></div><p>${esc(a.summary)}</p>${evidence(a.matches,false)}${a.gaps.length?'<h3>简历尚未体现的要求</h3>'+evidence(a.gaps,true):''}${a.questions.length?'<h3>建议确认</h3><ul class="jb-permissions">'+a.questions.map(q=>`<li>${esc(q)}</li>`).join('')+'</ul>':''}<p>本次Token ${a.usage.input.toLocaleString()} / ${a.usage.output.toLocaleString()} · 估算 ¥${a.usage.estimate.toFixed(4)}（非账单）${a.droppedEvidence?' · '+a.droppedEvidence+'项无效证据已剔除':''}${a.truncatedJD?' · JD仅分析前16000字':''}</p>`;
  }
  let analysisId=null;
  function render(){
    if(!state)return;
    const tab=selected();
    const isNative=native(),management=state.browserManagement;
    $('[data-jb-mirror-controls]').hidden=!extension();
    if(!extension()&&mirror.active)mirror.stop();
    $('[data-jb-pair]').hidden=!extension()||!state.features?.extensionBridge;
    $('[data-jb-pair]').disabled=!!state.running;
    if(!extension()||state.running){$('[data-jb-setup]').hidden=true;$('[data-jb-pair-code]').value='';}
    $('[data-jb-launch]').textContent=extension()?'打开普通浏览器':'启动浏览器';
    $('[data-jb-stop]').textContent=extension()?'断开插件连接':'关闭浏览器';
    $('[data-jb-config]').hidden=!state.features?.browserSelection;
    if(management){
      const options=management.browsers.map(b=>`<option value="${esc(b.id)}" ${b.available?'':'disabled'}>${esc(b.name)}${b.available?'':'（未安装）'}</option>`).join('');
      if(options!==engineHTML){engineHTML=options;$('[data-jb-engine]').innerHTML=options;}
      if(!configurationDirty){$('[data-jb-mode]').value=management.settings.mode;$('[data-jb-engine]').value=management.settings.browserId;}
      for(const s of ['[data-jb-mode]','[data-jb-engine]','[data-jb-save-config]'])$(s).disabled=state.running||state.configurationBusy;
      $('[data-jb-launch]').disabled=state.running||configurationDirty||state.configurationBusy;
      $('[data-jb-config-status]').textContent=state.running?(extension()?'断开插件后可切换配置':'关闭浏览器后可切换配置'):configurationDirty?'配置未保存':'';
      $('[data-jb-profile]').textContent='独立登录目录：'+(state.running?state.profileDir:management.profileDir);
    }
    $('[data-jb-stage]').classList.toggle('jb-stage-native',!!isNative);
    $('[data-jb-native]').hidden=!isNative||!state.running||!tab||tab.url==='about:blank'&&!tab.unexpectedBlank;
    $('[data-jb-native-title]').textContent=tab?.unexpectedBlank?'网页已意外变为空白，请在普通浏览器中核对；工作台不会自动刷新。':tab?.title||tab?.lastURL||tab?.url||'';
    $('[data-jb-native] h2').textContent=extension()?'普通浏览器扩展已连接':'原生浏览器窗口已连接';
    if(isNative){canvas.hidden=true;ime.hidden=true;$('[data-jb-empty]').hidden=!$('[data-jb-native]').hidden;}
    else ime.hidden=false;
    $('[data-jb-reconnect]').hidden=!!isNative;
    $('[data-jb-fullscreen]').hidden=!!isNative;
    if(inputTab!==tab?.id){inputQueue.clear();inputTab=tab?.id;}
    $('[data-jb-update]').hidden=extension()?!!state.features?.unpairedBrowsing:Number(state.workspaceVersion)>=2;
    $('[data-jb-update]').textContent=extension()?'浏览器后端待重启更新：未配对直接打开网站的修复尚未加载。':'浏览器后端待重启更新：回车、新版岗位读取和连续跳转保护尚未加载。';
    const verification=tab&&(tab.navigationPaused||tab.unexpectedBlank||/Security Verification|安全验证|人机验证/i.test(tab.title||'')||/\/(?:[^/?#]*\/)*(?:403(?:\.html)?|429(?:\.html)?|verify(?:\.html)?|captcha)(?:\/|\?|$)/i.test(tab.url||''));
    const accessKey=tab?.id+':'+!!verification;
    if(accessKey!==lastAccessKey){lastAccessKey=accessKey;if(verification)note(tab.error||'网站要求安全验证，插件已暂停；请在网页中手动完成验证后再操作',true);}
    $('[data-jb-stop]').disabled=!state.running;
    $('[data-jb-stop]').hidden=!state.features?.stop;
    const nextTabs=(state.tabs||[]).map(t=>`<span class="jb-tab ${t.id===state.selectedTabId?'active':''}"><button type="button" data-jb-select="${esc(t.id)}" title="${esc(t.url)}">${esc(t.title||(t.unexpectedBlank?'访问异常页':'新标签页'))}</button><button type="button" data-jb-close="${esc(t.id)}" aria-label="关闭${esc(t.title||'标签页')}">×</button></span>`).join('')+`<button class="ghost" type="button" data-jb-new title="新建标签页">＋</button>`;
    if(nextTabs!==tabsHTML){tabsHTML=nextTabs;$('[data-jb-tabs]').innerHTML=nextTabs;}
    if(!addressDirty&&document.activeElement!==$('[data-jb-address]'))$('[data-jb-address]').value=tab?.url==='about:blank'?(tab.unexpectedBlank?tab.lastURL||'':''):tab?.url||'';
    const launch=state.extension?.launchRequest;
    $('[data-jb-empty] h2').textContent=extension()?'在独立浏览器中打开招聘网站':'在这里打开招聘网站';
    $('[data-jb-status]').textContent=tab?.error||tab?.url||(extension()?(state.running?'扩展已连接，请在普通浏览器打开招聘岗位':launch?.error||'可直接打开网站 · 岗位插件尚未连接'):'浏览器尚未启动');
    for(const cmd of ['back','forward','reload'])$('[data-jb-'+cmd+']').disabled=!tab;
    $('[data-jb-resume-state]').textContent=state.resume.configured?`简历已就绪 · ${state.resume.characters.toLocaleString()}字`:'尚未提供简历';
    $('[data-jb-match]').disabled=!tab||tab.url==='about:blank'||verification||!state.resume.configured||!state.model.configured||state.matching||state.jobFinder?.busy||state.jobFinder?.planning;
    $('[data-jb-match]').textContent=state.matching?'正在分析…':'分析当前岗位匹配度';
    $('[data-jb-read-detail]').disabled=!tab||tab.url==='about:blank'||verification;
    const nextPreview=preview&&preview.tabId===tab?.id&&preview.tabURL===tab?.url?`<h3>${esc(preview.row.title)}</h3><p>${esc(preview.row.company||'公司请在网页核对')}</p><p class="jb-jd-preview">${esc(preview.row.description)}</p>`:'';
    if(nextPreview!==previewHTML){previewHTML=nextPreview;$('[data-jb-preview]').innerHTML=nextPreview;}
    $('[data-jb-prepare-message]').disabled=!tab||tab.url==='about:blank'||verification;
    $('[data-jb-prepare-apply]').disabled=!tab||verification||state.analysis?.tabId!==tab.id;
    $('[data-jb-usage]').textContent=`匹配模型累计：${state.usage.promptTokens.toLocaleString()} 输入 / ${state.usage.completionTokens.toLocaleString()} 输出Token · 估算 ¥${state.usage.estimate.toFixed(4)}${state.usage.unknown?' · '+state.usage.unknown+'次用量待核对':''}`;
    $('[data-jb-model]').textContent=state.model.configured?'模型密钥已配置；匹配按钮手动触发付费请求。':'未配置匹配模型，请先配置岗位洞察中的Qwen密钥。';
    if(analysisId!==state.analysis?.id){analysisId=state.analysis?.id;renderAnalysis();if(state.analysis)$('[data-jb-message]').value=state.analysis.greeting;else $('[data-jb-message]').value='';}
    finderUI.render(state);
    if(!state.resume?.configured)$('[data-jb-document-preview]').replaceChildren();
    const authorizing=root.querySelector('[data-jbf-authorize]');if(authorizing&&authorizing.dataset.resumeRevision!==state.resume?.revision)root.dispatchEvent(new Event('job-browser-resume-invalidated'));
    interactive.render(state);
    $('[data-jb-preview-pages]').hidden=!state.resume?.screenshotReady;
    $('[data-jb-resume-state]').textContent=state.resume?.configured?`${state.resume.filename||'简历'} · ${state.resume.characters.toLocaleString()}字 · ${state.resume.pages?.length||0}页截图`:'尚未上传简历';
    if(mirror.active){canvas.hidden=true;ime.hidden=true;$('[data-jb-empty]').hidden=true;$('[data-jb-native]').hidden=true;}
    $('[data-jb-stage]').classList.toggle('jb-stage-mirror',mirror.active);
    connectStream();
  }
  async function refresh(){
    if(loading||disposed)return;loading=true;
    try{state=await api('/api/browser/status');
      if(!$('[data-jb-site]').options.length){$('[data-jb-site]').innerHTML=state.sites.map(s=>`<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');$('[data-jb-sites]').innerHTML=state.sites.map(s=>`<button type="button" data-jb-open="${esc(s.id)}">${esc(s.name)}</button>`).join('');$('[data-jb-permissions]').innerHTML=state.plugins.map(p=>`<li><b>${esc(p.name)}</b> · ${esc(p.permission)}</li>`).join('');}
      render();
    }catch(e){note(e.message,true);}finally{loading=false;}
  }
  const guard=fn=>async event=>{event?.preventDefault();const b=event?.currentTarget;if(b?.tagName==='BUTTON')b.disabled=true;try{await fn(event);}catch(e){note(e.message,true);toast(e.message,true);}finally{if(b?.tagName==='BUTTON')b.disabled=false;render();}};
  async function ensure(){if(configurationDirty)throw Error('请先保存浏览器配置');if(!state?.running){if(extension())throw Error('请先打开普通浏览器，点击“连接扩展”完成配对');note('正在启动本机浏览器…');await action('start');note('浏览器已连接，可点击网页手动登录');}}
  function opened(result){const via=result?.openRequest?.transport;note(via==='system-browser-launch'?'已向普通浏览器提交打开请求，请查看独立窗口；浏览网站无需连接扩展。':'已提交网页打开请求；登录和验证请在浏览器中手动完成');}
  $('[data-jb-config]').onsubmit=guard(async()=>{await post('configuration',{mode:$('[data-jb-mode]').value,browserId:$('[data-jb-engine]').value});configurationDirty=false;note('浏览器配置已保存');await refresh();});
  $('[data-jb-launch]').onclick=guard(async()=>{if(configurationDirty)throw Error('请先保存浏览器配置');if(extension())opened(await action('start'));else await ensure();await refresh();});
  $('[data-jb-share]').onclick=guard(async()=>{interactive.stop();await mirror.start();note('画面镜像已连接；请在普通浏览器中操作网页。共享画面不会发送给模型。');});
  $('[data-jb-end-share]').onclick=()=>{mirror.stop();note('镜像已停止；普通浏览器和岗位插件仍可使用');};
  $('[data-jb-extension-manager]').onclick=guard(async()=>{if(configurationDirty)throw Error('请先保存浏览器配置');await action('extension-manager');note('已提交打开扩展管理页的请求，请在普通浏览器窗口中手动安装');});
  $('[data-jb-pair]').onclick=guard(async()=>{const result=await post('extension-setup');$('[data-jb-setup]').hidden=false;$('[data-jb-extension-path]').value=result.extensionPath;$('[data-jb-pair-code]').value=result.code;$('[data-jb-pair-expires]').textContent='连接码有效至 '+new Date(result.expiresAt).toLocaleTimeString()+'，仅可使用一次';note('请在普通浏览器手动加载本地扩展并粘贴连接码');});
  $('[data-jb-focus]').onclick=guard(()=>action('focus'));
  for(const s of ['[data-jb-mode]','[data-jb-engine]'])$(s).addEventListener('change',()=>render());
  async function openSite(id){if(configurationDirty)throw Error('请先保存浏览器配置');const site=state.sites.find(s=>s.id===id);if(!site)return;addressDirty=false;if(extension()){opened(await action('open-site',{url:site.url}));$('[data-jb-site]').value=id;return;}await ensure();if(selected()?.url==='about:blank')await action('navigate',{url:site.url});else await action('new-tab',{url:site.url});$('[data-jb-site]').value=id;note('网页已打开；登录和验证请在网页中手动完成');}
  $('[data-jb-sites]').onclick=guard(e=>{const b=e.target.closest('[data-jb-open]');if(b)return openSite(b.dataset.jbOpen);});
  $('[data-jb-tabs]').onclick=guard(async e=>{const s=e.target.closest('[data-jb-select]'),c=e.target.closest('[data-jb-close]');addressDirty=false;if(s)await action('select',{tabId:s.dataset.jbSelect});else if(c)await action('close-tab',{tabId:c.dataset.jbClose});else if(e.target.closest('[data-jb-new]')){if(extension())await openSite($('[data-jb-site]').value);else if(state?.running)await action('new-tab');else await ensure();}});
  $('[data-jb-nav]').onsubmit=guard(async()=>{if(configurationDirty)throw Error('请先保存浏览器配置');const fallback=state?.sites?.find(s=>s.id===$('[data-jb-site]').value)?.url;const url=browserNavigationURL($('[data-jb-address]').value,fallback);addressDirty=false;if(extension()){opened(await action('open-site',{url}));return;}await ensure();const result=selected()?await action('navigate',{url}):await action('new-tab',{url});const failure=result.tabs?.find(t=>t.id===result.selectedTabId)?.error;note(failure||'网页已打开；登录和验证请在网页中手动完成',!!failure);});
  for(const cmd of ['back','forward','reload'])$('[data-jb-'+cmd+']').onclick=guard(()=>action(cmd));
  $('[data-jb-reconnect]').onclick=guard(async()=>{events?.close();events=null;streamId=null;await refresh();});
  $('[data-jb-stop]').onclick=guard(async()=>{const wasExtension=extension();await action('stop');note(wasExtension?'插件已断开；普通浏览器窗口保持打开，登录资料保留':'浏览器已关闭，登录资料保留在本机');await refresh();});
  $('[data-jb-fullscreen]').onclick=guard(()=>$('[data-jb-stage]').requestFullscreen());
  $('[data-jb-search]').onsubmit=guard(async()=>{if(configurationDirty)throw Error('请先保存浏览器配置');if(!extension())await ensure();const result=await action('plugin',{id:'search',site:$('[data-jb-site]').value,keyword:$('[data-jb-keyword]').value,city:$('[data-jb-city]').value});if(extension())opened(result);else note('已打开搜索结果；筛选条件也可直接在网页中调整');});

  $('[data-jb-clear]').onclick=guard(async()=>{await post('clear-resume',{tabId:selected()?.id});$('[data-jb-document-preview]').replaceChildren();note('简历与匹配结果已从内存清除');await refresh();});
  $('[data-jb-preview-pages]').onclick=guard(async()=>{const data=await post('resume-pages');const box=$('[data-jb-document-preview]');box.replaceChildren();for(const p of data.pages){const img=document.createElement('img');img.src='data:'+p.mime+';base64,'+p.base64;img.alt='原始简历第'+p.page+'页';img.style.width='100%';box.append(img);}box.dataset.revision=data.revision;box.dataset.documentHash=data.documentHash;note('请核对全部截图；发送授权将绑定此简历版本');});
  $('[data-jb-upload]').onclick=()=>{$('[data-jb-file]').click();};
  $('[data-jb-file]').onchange=guard(async e=>{const file=e.target.files?.[0];if(!file)return;try{if(file.size>3*1024*1024)throw Error('文件不得超过3MB');const bytes=new Uint8Array(await file.arrayBuffer());let str='';for(let i=0;i<bytes.length;i+=16384)str+=String.fromCharCode(...bytes.subarray(i,i+16384));await post('resume',{filename:file.name,base64:btoa(str)});$('[data-jb-document-preview]').replaceChildren();note('简历已解析并载入内存');await refresh();await finderUI.generate();}finally{e.target.value='';}});
  $('[data-jb-match]').onclick=guard(async()=>{if(!confirm('将脱敏简历和当前岗位JD发送给已配置的Qwen3.7-Flash进行匹配分析，会产生少量Token费用。不自动投递或发送消息。确认分析？'))return;note('正在读取当前岗位并核对简历…');state.matching=true;render();try{const result=await post('match',{tabId:selected().id});state.analysis=result;note('匹配分析已完成，请核对原文和沟通草稿');}finally{await refresh();}});
  $('[data-jb-read-detail]').onclick=guard(async()=>{const tab=selected(),tabId=tab?.id,tabURL=tab?.url;const result=await post('plugin',{tabId,id:'read-detail'});if(selected()?.id!==tabId||selected()?.url!==tabURL)throw Error('当前页面已变化，请重新读取');if(!result.rows?.[0])throw Error('当前页尚无可识别的岗位详情');preview={tabId,tabURL,row:result.rows[0]};note('已读取当前岗位原文；未调用模型或执行投递');render();});
  async function prepare(kind){const result=await post(kind==='apply'?'prepare-apply':'prepare-message',{tabId:selected()?.id,message:$('[data-jb-message]').value});confirmation=result;$('[data-jb-target]').textContent=`目标：${result.identity} · 操作：${result.label}`;$('[data-jb-content]').textContent=result.kind==='message'?result.body:`当前岗位：${state.analysis?.job.title||''}\n公司：${state.analysis?.job.company||'请在网页核实'}\n${result.url}`;$('[data-jb-action-note]').textContent=result.note;$('[data-jb-expires]').textContent='有效期2分钟。确认后只执行一次，结果不明时不会重试。';$('[data-jb-confirm]').showModal();}
  $('[data-jb-prepare-message]').onclick=guard(()=>prepare('message'));
  $('[data-jb-prepare-apply]').onclick=guard(()=>prepare('apply'));
  $('[data-jb-cancel]').onclick=guard(async()=>{$('[data-jb-confirm]').close();confirmation=null;await action('cancel-action');});
  $('[data-jb-confirm]').addEventListener('cancel',()=>{confirmation=null;void action('cancel-action').catch(()=>{});});
  $('[data-jb-confirm-button]').onclick=guard(async()=>{const ticket=confirmation;confirmation=null;$('[data-jb-confirm]').close();if(!ticket)throw Error('方案已失效');const result=await post('confirm-action',{tabId:ticket.tabId,ticketId:ticket.id});note(result.message,!result.confirmed);await refresh();});
  const inputQueue=createBrowserInputQueue({
    send:async inputs=>{
      const id=inputTab;if(!id||selected()?.id!==id||!visible||document.hidden)return;
      if(state.features?.inputBatch)return post('input-batch',{tabId:id,inputs});
      for(const input of inputs){if(selected()?.id!==id||!visible||document.hidden)return;await post('input',{tabId:id,input});}
    },onError:e=>note(e.message,true)
  });
  function sendInput(input){if(native()||!selected()||!visible||document.hidden)return;inputQueue.push(input);}
  function point(e){const box=canvas.getBoundingClientRect(),w=frame?.width||1280,h=frame?.height||800,scale=Math.min(box.width/w,box.height/h),left=box.left+(box.width-w*scale)/2,top=box.top+(box.height-h*scale)/2;return {x:Math.max(0,Math.min(w,(e.clientX-left)/scale)),y:Math.max(0,Math.min(h,(e.clientY-top)/scale))};}
  const mouseButton=e=>['left','middle','right'][e.button]||'none';
  canvas.oncontextmenu=e=>e.preventDefault();
  canvas.onpointerdown=e=>{e.preventDefault();ime.focus({preventScroll:true});canvas.setPointerCapture(e.pointerId);void sendInput({type:'mouse',event:'mousePressed',...point(e),button:mouseButton(e),buttons:e.buttons,clickCount:e.detail||1});};
  canvas.onpointerup=e=>{e.preventDefault();void sendInput({type:'mouse',event:'mouseReleased',...point(e),button:mouseButton(e),buttons:e.buttons,clickCount:e.detail||1});};
  canvas.onpointermove=e=>{void sendInput({type:'mouse',event:'mouseMoved',...point(e),button:'none',buttons:e.buttons});};
  canvas.addEventListener('wheel',e=>{e.preventDefault();const unit=e.deltaMode===1?16:e.deltaMode===2?(frame?.height||800):1;void sendInput({type:'mouse',event:'mouseWheel',...point(e),button:'none',deltaX:Math.max(-2000,Math.min(2000,e.deltaX*unit)),deltaY:Math.max(-2000,Math.min(2000,e.deltaY*unit))});},{passive:false});
  canvas.onfocus=()=>ime.focus({preventScroll:true});
  const special=new Set(['Backspace','Tab','Enter','Escape','Delete','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown']);
  for(const name of ['keydown','keyup'])ime.addEventListener(name,e=>{if(composing)return;if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='v')return;if(!special.has(e.key)&&!(e.ctrlKey||e.metaKey||e.altKey))return;if(e.key.length!==1&&!special.has(e.key))return;if(!special.has(e.key)&&!['a','c','x','z','y'].includes(e.key.toLowerCase()))return;e.preventDefault();void sendInput({type:'key',event:name==='keydown'?'keyDown':'keyUp',key:e.key.length===1?e.key.toLowerCase():e.key,code:e.code,keyCode:e.keyCode,modifiers:(e.altKey?1:0)|(e.ctrlKey?2:0)|(e.metaKey?4:0)|(e.shiftKey?8:0)});});
  ime.addEventListener('compositionstart',()=>{composing=true;compositionText='';});
  ime.addEventListener('compositionend',e=>{composing=false;compositionText=e.data||ime.value;if(compositionText)void sendInput({type:'text',text:compositionText});ime.value='';setTimeout(()=>{compositionText='';},100);});
  ime.oninput=e=>{if(composing||e.isComposing)return;if(compositionText&&e.data===compositionText){ime.value='';return;}const value=ime.value;if(value)void sendInput({type:'text',text:value});ime.value='';};
  ime.onpaste=e=>{e.preventDefault();const value=e.clipboardData.getData('text');if(value)void sendInput({type:'text',text:value.slice(0,20000)});};
  new ResizeObserver(()=>{clearTimeout(resizing);resizing=setTimeout(()=>{if(visible&&selected()){
    if(native())return;const width=Math.max(960,Math.min(1600,Math.round($('[data-jb-stage]').clientWidth))),height=Math.max(600,Math.min(1000,Math.round(innerHeight-$('[data-jb-stage]').getBoundingClientRect().top-60))),key=`${selected().id}:${width}:${height}`;
    if(key!==lastSize){lastSize=key;void post('resize',{tabId:selected().id,width,height}).catch(()=>{lastSize='';});}
  }},250);}).observe($('[data-jb-stage]'));
  let lastPoll=0;
  document.addEventListener('job-workspace-view',e=>{visible=e.detail.view==='browser';if(visible){void refresh();if(!timer)timer=setInterval(()=>{if(visible&&!document.hidden&&Date.now()-lastPoll>=(native()?1500:15000)){lastPoll=Date.now();void refresh();}},1500);}else{mirror.stop();inputQueue.clear();events?.close();events=null;streamId=null;pendingFrame=null;frameSerial++;}});
  document.addEventListener('visibilitychange',()=>{if(document.hidden){inputQueue.clear();events?.close();events=null;streamId=null;pendingFrame=null;frameSerial++;}else if(visible)void refresh();});
  window.addEventListener('pagehide',()=>{disposed=true;mirror.dispose();inputQueue.clear();pendingFrame=null;frameSerial++;events?.close();clearInterval(timer);clearTimeout(resizing);});
}
