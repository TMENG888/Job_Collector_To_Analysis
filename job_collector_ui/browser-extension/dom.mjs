// Executed only on a user-requested operation, in the extension's ISOLATED world.
// No page globals, browser fingerprint changes, auth data, or injected site patches.
export async function pageOperation(args){
  try {
  const sites={boss:'zhipin.com',liepin:'liepin.com',zhaopin:'zhaopin.com',job51:'51job.com',iguopin:'iguopin.com',shixiseng:'shixiseng.com'};
  const site=Object.keys(sites).find(k=>location.hostname===sites[k]||location.hostname.endsWith('.'+sites[k]));
  if(location.protocol!=='https:'||!site)throw Error('当前页不是已接入招聘网站');
  const visible=e=>!!e&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none';
  const all=s=>[...document.querySelectorAll(s)].filter(visible),get=s=>all(s)[0]?.innerText?.trim()||'';
  const documentId=globalThis.__localJobDocumentId??=crypto.randomUUID();
  if(!globalThis.__localJobMirrorObserver){globalThis.__localJobMirrorRevision=0;const observer=new MutationObserver(()=>{globalThis.__localJobMirrorRevision++;});observer.observe(document,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['href','disabled','aria-disabled','src','value']});globalThis.__localJobMirrorObserver=observer;}
  const nodeIds=globalThis.__localJobMirrorNodes??=new WeakMap();
  const nodeId=e=>{if(!nodeIds.has(e))nodeIds.set(e,crypto.randomUUID());return nodeIds.get(e);};
  const actionable='a,button,input,textarea,select,[role="button"],[contenteditable="true"]';
  function targetState(e){const b=e.getBoundingClientRect();return {id:nodeId(e),rect:[b.x,b.y,b.width,b.height].map(n=>Math.round(n*10)/10),signature:JSON.stringify([e.tagName,e.getAttribute('type'),e.getAttribute('role'),e.getAttribute('href'),e.getAttribute('aria-label'),e.getAttribute('aria-disabled'),!!e.disabled,e.isContentEditable,e.matches(actionable)?(e.innerText||'').slice(0,512):''])};}
  function viewport(){const elements=[...document.querySelectorAll('*')].filter(visible);return {documentId,revision:globalThis.__localJobMirrorRevision,url:location.href,width:innerWidth,height:innerHeight,dpr:devicePixelRatio,scroll:[scrollX,scrollY],panels:elements.filter(e=>(e.scrollHeight>e.clientHeight+2||e.scrollWidth>e.clientWidth+2)&&/auto|scroll/.test(getComputedStyle(e).overflow+getComputedStyle(e).overflowY+getComputedStyle(e).overflowX)).slice(0,60).map(e=>[nodeId(e),e.scrollLeft,e.scrollTop,e.clientWidth,e.clientHeight]),targets:elements.filter(e=>{const b=e.getBoundingClientRect();return b.bottom>0&&b.right>0&&b.top<innerHeight&&b.left<innerWidth;}).slice(0,4000).map(targetState),focus:document.activeElement?nodeId(document.activeElement):null};}
  if(args.op==='viewport')return viewport();
  const text=(document.body?.innerText||'').slice(0,15000);
  if(/\/(?:403|429|verify|captcha)(?:\.html)?(?:\/|$)/i.test(location.pathname)||/Security Verification|Just a moment|安全验证|人机验证/i.test(document.title)||/请完成安全验证|请拖动滑块|请按住滑块|访问过于频繁|访问异常|账号存在异常|请求过于频繁|确认您是真人|正在验证连接安全性/.test(text)||all('#WAF_NC_WRAPPER,.geetest_panel,.aliyunCaptcha-sliding-body,.nc-container,.captcha-dialog,[class*="captcha-container"],.verify-wrap').length)throw Error('网站要求验证或限制访问；请手动处理，插件不执行或重试');
  if(/\/(?:login|passport|web\/user)(?:\/|$)/i.test(location.pathname)||all('.login-dialog,.login-modal').length)throw Error('请在网站手动登录，再读取岗位');
  const spec={boss:{links:'a[href*="/job_detail/"]',title:'.job-detail-header .job-title,.job-detail-info .job-title,.job-detail-box h1,.job-banner h1,h1',details:'.job-sec-text,.job-detail-section .text,.job-detail-body .job-desc'},liepin:{links:'a[href*="/job/"],a[href*="/a/"]',title:'h1,.name-box .job-title',company:'.job-title-container .company-name,.job-title-content .company-name,.company-info .company-name',details:'.job-intro-container,.job-intro-content,.job-description'},zhaopin:{links:'a[href*="jobs.zhaopin.com/"],a[href*="/jobdetail/"]',details:'.describtion__detail-content,.job-detail-describe,.job-description'},job51:{links:'a[href*="jobs.51job.com/"],a[href*="/jobdetail"]',details:'.job_msg,.job-detail-description,.job-description'},iguopin:{links:'a[href*="/job/detail"],a[href*="/job_detail"],a[href*="/jobs/detail"]',details:'.job-description,.job-content,.position-description'},shixiseng:{links:'a[href*="/intern/"],a[href*="/job/"]',details:'.job_detail,.job-desc,.job-description'}}[site];
  if(args.op==='mirror-input'){
    const expected=args.expected,current=viewport(),geometry=v=>JSON.stringify([v?.documentId,v?.url,v?.width,v?.height,v?.dpr,v?.scroll,v?.panels]);
    if(!expected||geometry(current)!==geometry(expected))throw Error('画面位置已变化，未执行输入；请等新画面再操作');
    const input=args.input||{};
    if(['click','scroll'].includes(input.type)){
      if(!Number.isFinite(input.x)||!Number.isFinite(input.y)||input.x<0||input.y<0||input.x>=innerWidth||input.y>=innerHeight)throw Error('坐标无效');
      const el=document.elementFromPoint(input.x,input.y);if(!visible(el)||el.closest('iframe,input[type=password],input[type=file]'))throw Error('此元素请在原窗口操作');
      const target=el.closest(actionable)||el,actual=targetState(target),old=expected.targets?.find(t=>t.id===actual.id);
      if(!old||JSON.stringify(old)!==JSON.stringify(actual))throw Error('目标元素已变化，未执行输入；请等新画面再操作');
      if(input.type==='click'){el.focus?.({preventScroll:true});el.click();return {ok:true,dispatched:true,trusted:false};}
      const dx=Number(input.deltaX),dy=Number(input.deltaY);if(!Number.isFinite(dx)||!Number.isFinite(dy)||Math.abs(dx)>2000||Math.abs(dy)>2000)throw Error('滚动量无效');
      let scroll=el;while(scroll&&scroll!==document.documentElement){const style=getComputedStyle(scroll);if((dy&&scroll.scrollHeight>scroll.clientHeight+2&&/auto|scroll/.test(style.overflowY))||(dx&&scroll.scrollWidth>scroll.clientWidth+2&&/auto|scroll/.test(style.overflowX)))break;scroll=scroll.parentElement;}
      (scroll||document.scrollingElement).scrollBy({left:dx,top:dy,behavior:'instant'});return {ok:true};
    }
    const el=document.activeElement;
    if(!el||expected.focus!==nodeId(el))throw Error('网页焦点已变化，未输入；请重新点击输入框');
    if(!visible(el)||!(el instanceof HTMLTextAreaElement||el instanceof HTMLInputElement||el.isContentEditable)||el.disabled||el.readOnly||el instanceof HTMLInputElement&&!['text','search','email','tel','url'].includes(el.type))throw Error('请先点击可编辑文本框；密码、文件和特殊输入仅在原窗口操作');
    if(input.type==='text'){
      if(typeof input.text!=='string'||input.text.length>2000)throw Error('输入文字过长');
      if(el.isContentEditable){document.execCommand('insertText',false,input.text);return {ok:true};}
      const start=el.selectionStart??el.value.length,end=el.selectionEnd??start;
      const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto,'value').set.call(el,el.value.slice(0,start)+input.text+el.value.slice(end));el.setSelectionRange(start+input.text.length,start+input.text.length);el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:input.text}));return {ok:true};
    }
    if(input.type==='key'){
      if(input.key==='Enter'){el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));el.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));return {ok:true,dispatched:true,trusted:false};}
      if(el.isContentEditable)throw Error('此编辑操作请在原窗口完成');
      const start=el.selectionStart??0,end=el.selectionEnd??start;
      if(input.key==='SelectAll'){el.select();return {ok:true};}
      if(!['Backspace','Delete'].includes(input.key))throw Error('此按键请在原窗口操作');
      el.setSelectionRange(start===end&&input.key==='Backspace'?Math.max(0,start-1):start,start===end&&input.key==='Delete'?end+1:end);
      el.setRangeText('',el.selectionStart,el.selectionEnd,'end');el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward'}));return {ok:true};
    }
    throw Error('不支持的镜像输入');
  }
  function detail(){const row={url:location.href,title:get(spec.title||'h1'),company:site==='liepin'&&location.pathname.startsWith('/a/')?'':get(spec.company||'.company-name,.company__title,.companyName'),salary:get('.salary,.job-salary,.job-salary__text'),city:get('.job-area,.job-address,.work-city'),description:get(spec.details).slice(0,30000)};if(!row.title||row.description.length<30)throw Error('当前页不是完整岗位详情，请打开具体岗位');return row;}
  if(args.op==='read-detail')return {rows:[detail()],documentId};
  if(args.op==='advance-results'){
    if(site!=='boss'||!/^\/web\/geek\/jobs?(?:\/|$)/.test(location.pathname))throw Error('仅允许在BOSS检索结果页继续遍历');
    const next=all('.options-pages .next,.pagination .next,.pagination-next,[aria-label="下一页"],button,a').filter(e=>e.matches('.options-pages .next,.pagination .next,.pagination-next,[aria-label="下一页"]')||/^(?:下一页|下一页\s*[>›»])$/.test(e.innerText.trim()));
    if(next.length>1)throw Error('无法唯一确认下一页，停止遍历');
    if(next.length===1){const e=next[0];if(e.disabled||e.getAttribute('aria-disabled')==='true'||e.matches('.disabled,.is-disabled')||e.closest('.disabled,.is-disabled'))return {advanced:false,exhausted:true,reason:'next-disabled'};if(e.tagName==='A'&&e.href){const u=new URL(e.href);if(u.origin!==location.origin||u.pathname!==location.pathname)throw Error('下一页跳转不在当前检索路径，停止');}e.click();return {advanced:true,method:'next-page'};}
    const lists=all('.job-list-container,.job-list-box,.job-list,.search-job-result');
    if(lists.some(e=>/没有更多(?:了|岗位)?|暂无更多|已经到底|已到底/.test(e.innerText.slice(-160))))return {advanced:false,exhausted:true,reason:'explicit-end'};
    const scrollables=lists.filter(e=>e.scrollHeight>e.clientHeight+2&&/auto|scroll/.test(getComputedStyle(e).overflowY));
    if(scrollables.length>1)throw Error('存在多个可滚动岗位列表，停止，不猜测目标');
    const container=scrollables[0]||document.scrollingElement;
    if(!container||container.scrollHeight<=container.clientHeight+2)return {advanced:false,exhausted:false,reason:'no-pagination'};
    // Continue near the last rendered job, not an arbitrary document bottom:
    // this advances ordinary lists without skipping unrendered virtual cards.
    const links=all(spec.links).filter(a=>container===document.scrollingElement||container.contains(a));
    const top=container===document.scrollingElement?0:container.getBoundingClientRect().top;
    const last=links.at(-1)?.getBoundingClientRect().bottom;
    const target=Math.max(container.scrollTop+Math.max(200,Math.round(container.clientHeight*.85)),Number.isFinite(last)?container.scrollTop+last-top-container.clientHeight*.3:0);
    container.scrollTo({top:target,behavior:'instant'});return {advanced:true,method:'scroll-results'};
  }
  if(args.op==='collect-page'){
    const limit=Number.isInteger(args.limit)&&args.limit>=1&&args.limit<=300?args.limit:100;
    const seen=new Set();const rows=all(spec.links).map(a=>{const card=a.closest('article,li,.job-card-wrapper,.job-card-box,.joblist-box__item,.job-card,.job-list-item,.job-item')||a.parentElement;const read=s=>card?.querySelector(s)?.innerText?.trim()||'';return {url:a.href,title:(a.title||read('.job-name,.job-title,.jobinfo__title')||a.innerText).trim().slice(0,180),company:read('.company-name,.company__title'),salary:read('.salary,.job-salary'),city:read('.job-area,.city'),description:''};}).filter(r=>r.title&&!seen.has(r.url)&&seen.add(r.url)).slice(0,limit);if(!rows.length)throw Error('当前页没有可识别的岗位卡片');return {rows,documentId};
  }
  if(['delivery-context','delivery-message','delivery-image'].includes(args.op)){
    if(site!=='boss')throw Error('批次发送仅适配BOSS；其他网站请手动操作');
    function context(){
      const t=target('message','本批授权沟通');
      const panel=t.input.closest('.chat-container,.chat-dialog,.chat-conversation,.chat-wrap');
      if(!panel||!args.job?.title||!args.job?.company)throw Error('无法核对独立会话与岗位公司，未发送');
      const links=[...panel.querySelectorAll('.chat-job-card a[href],.chat-position a[href],.chat-job-info a[href],.job-card a[href]')].filter(visible);
      const key=value=>{const u=new URL(value,location.href);return u.origin+u.pathname+'?'+['id','jobId','positionId','securityId'].filter(k=>u.searchParams.has(k)).map(k=>k+'='+u.searchParams.get(k)).join('&');};
      const link=links.find(a=>key(a.href)===key(args.job.url));
      const card=link?.closest('.chat-job-card,.chat-position,.chat-job-info,.job-card');
      if(!card||!card.innerText.includes(args.job.title)||!card.innerText.includes(args.job.company))throw Error('会话岗位卡片与本次JD无法对应，停止，未发送');
      const header=all('.chat-user-name,.chat-title,.conversation-title,.chat-info .name,.chat-head .name')[0];
      const profile=header?.querySelector('a[href]');let recipientId=header?.getAttribute('data-boss-id')||'';
      if(profile){const u=new URL(profile.href);if(u.protocol==='https:'&&u.hostname===location.hostname&&/^\/(?:boss|boss_detail)\//.test(u.pathname))recipientId=u.origin+u.pathname;}
      if(!recipientId||recipientId.length>300)throw Error('无法读取唯一招聘方标识，停止，未发送');
      const binding=JSON.stringify([documentId,location.href,key(args.job.url),args.job.title,args.job.company,recipientId,t.identity]);
      return {...t,panel,recipientId,binding};
    }
    const c=context();
    if(args.op==='delivery-context')return {recipientId:c.recipientId,identity:c.identity,binding:c.binding};
    if(args.binding!==c.binding)throw Error('收件人或岗位已变化，未发送');
    const outgoing=()=>[...c.panel.querySelectorAll('.message-item.is-self,.message-item.sent,.message-list .item-myself,.message-list .message-right')].filter(visible);
    const acknowledged=row=>row.matches('[data-status="sent"],[data-status="success"],[data-delivery-state="sent"]')||!!row.querySelector('.send-success,.message-status-sent');
    const previous=new Set(outgoing());
    // One operation per binding and content, even if the local acknowledgement is lost.
    const attempted=globalThis.__localDeliveryAttempts??=new Set();
    const once=JSON.stringify([c.binding,args.op,args.op==='delivery-message'?args.body:args.image?.sha256]);
    if(attempted.has(once))throw Error('此消息已有尝试，未重复发送');
    if(args.op==='delivery-message'){
      if(typeof args.body!=='string'||args.body.trim().length<2||args.body.length>2000)throw Error('招呼内容无效');
      if(outgoing().some(e=>e.innerText.trim()===args.body.trim()))throw Error('当前会话已存在相同招呼，未重复发送');
      const t=target('message',args.body);if(t.button.disabled||t.button.getAttribute('aria-disabled')==='true')throw Error('发送按钮不可用');
      if(t.input.isContentEditable)t.input.textContent=args.body;else Object.getOwnPropertyDescriptor(t.input instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(t.input,args.body);
      t.input.dispatchEvent(new Event('input',{bubbles:true}));
      if(context().binding!==args.binding)throw Error('输入后收件人变化，未点击发送');
      attempted.add(once);t.button.click();
      for(let i=0;i<20;i++){await new Promise(r=>setTimeout(r,200));if(context().binding!==args.binding)throw Error('发送后会话变化，结果待人工核对');
        if(outgoing().some(e=>!previous.has(e)&&acknowledged(e)&&e.innerText.trim()===args.body.trim()&&!e.querySelector('.send-fail,.sending,.send-error')))return {attempted:true,confirmed:true};}
      return {attempted:true,confirmed:false};
    }
    const image=args.image;
    if(!image||image.mime!=='image/jpeg'||typeof image.base64!=='string'||image.base64.length>4*1024*1024||!/^resume-[a-f\d]{12}-[1-6]\.jpg$/.test(image.filename))throw Error('原版式图片参数无效');
    const raw=Uint8Array.from(atob(image.base64),c=>c.charCodeAt(0));
    const sha=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
    if(await sha(raw)!==image.sha256)throw Error('简历图片校验失败');
    const files=[...c.panel.querySelectorAll('.chat-input input[type=file],.chat-editor-area input[type=file]')].filter(e=>/image|\.jpg|\.jpeg/.test(e.accept)&&!e.disabled);
    if(files.length!==1)throw Error('无法唯一确认当前会话的图片上传控件，未上传');
    if(context().binding!==args.binding)throw Error('上传前会话变化，未上传');
    const transfer=new DataTransfer();transfer.items.add(new File([raw],image.filename,{type:image.mime}));
    attempted.add(once);files[0].files=transfer.files;files[0].dispatchEvent(new Event('change',{bubbles:true}));
    for(let i=0;i<20;i++){await new Promise(r=>setTimeout(r,200));if(context().binding!==args.binding)throw Error('上传后会话变化，结果待人工核对');
      for(const row of outgoing().filter(e=>!previous.has(e)&&acknowledged(e)&&!e.querySelector('.send-fail,.sending,.send-error'))){
        for(const img of row.querySelectorAll('img')){
          // Only compare in-memory blob/data images; never fetch arbitrary site URLs or infer
          // successful delivery from dimensions, an upload preview, or a clicked button.
          const src=img.currentSrc||img.src;if(src.startsWith('blob:'+location.origin+'/')||src.startsWith('data:image/jpeg;base64,')){
            try{if(await sha(await(await fetch(src)).arrayBuffer())===image.sha256)return {attempted:true,confirmed:true};}catch{}
          }
        }
      }
    }
    return {attempted:true,confirmed:false};
  }
  if(!['boss','liepin','zhaopin'].includes(site))throw Error('此网站请手动沟通和投递');
  function target(kind,body){
    if(kind==='message'){
      if(typeof body!=='string'||body.trim().length<2||body.length>2000)throw Error('请填写2–2000字消息');
      const headers=all('.chat-user-name,.chat-title,.conversation-title,.chat-info .name,.chat-head .name'),inputs=all('textarea[placeholder*="消息"],textarea[placeholder*="说点"],.chat-input textarea,.chat-input [contenteditable="true"],.chat-editor[contenteditable="true"]');
      const buttons=all('button,[role="button"],.chat-input .btn-send,.chat-editor-area .btn-send').filter(e=>/^发送(?:消息)?$/.test(e.innerText.trim()));
      if(headers.length!==1||!headers[0].innerText.trim()||inputs.length!==1||buttons.length!==1)throw Error('无法唯一确认收件人、输入框或发送按钮，请手动操作');
      return {identity:headers[0].innerText.trim().slice(0,120),label:buttons[0].innerText.trim(),input:inputs[0],button:buttons[0]};
    }
    if(kind!=='apply')throw Error('无效操作类型');const job=detail();
    const buttons=all('button,a,[role="button"]').filter(e=>/^(?:立即沟通|立即投递|投递简历|立即应聘|申请职位|立即申请|申请该职位|立即聊聊)$/.test(e.innerText.trim()));
    if(buttons.length!==1)throw Error('无法唯一确认投递/沟通按钮，请手动操作');return {identity:`${job.company||'公司待网页确认'} · ${job.title}`,label:buttons[0].innerText.trim(),job,button:buttons[0]};
  }
  const signature=t=>JSON.stringify([t.identity,t.label,t.job||null]);
  if(args.op==='prepare'){
    const t=target(args.kind,args.body);if(t.button.disabled||t.button.getAttribute('aria-disabled')==='true')throw Error('按钮尚未就绪');
    const ticket={id:crypto.randomUUID(),documentId,url:location.href,kind:args.kind,body:args.body||'',identity:t.identity,label:t.label,signature:signature(t),expires:Date.now()+120000};
    globalThis.__localJobTicket=ticket;return {...ticket,job:t.job,site};
  }
  if(args.op==='confirm'){
    const ticket=globalThis.__localJobTicket;delete globalThis.__localJobTicket;
    if(!ticket||ticket.id!==args.ticketId||ticket.expires<Date.now()||ticket.documentId!==documentId||ticket.url!==location.href)throw Error('确认已失效，未执行');
    let t=target(ticket.kind,ticket.body);if(signature(t)!==ticket.signature)throw Error('目标已变化，未执行');
    if(ticket.kind==='message'){
      if(t.input.isContentEditable)t.input.textContent=ticket.body;
      else{const proto=t.input instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(t.input,ticket.body);}
      t.input.dispatchEvent(new Event('input',{bubbles:true}));
    }
    t=target(ticket.kind,ticket.body);if(signature(t)!==ticket.signature||t.button.disabled||t.button.getAttribute('aria-disabled')==='true')throw Error('目标或按钮变化，未点击');
    t.button.click();return {attempted:true,confirmed:false,message:'已点击一次；请在网页核对最终结果，不会重试或处理后续弹窗'};
  }
  if(args.op==='cancel'){delete globalThis.__localJobTicket;return {ok:true};}
  throw Error('不支持的岗位插件操作');
  } catch(error) {
    // Chrome may discard rejected executeScript promises. Return an explicit envelope
    // only on the extension transport; direct callers retain normal rejections.
    if(args?.__localJobEnvelope===true)return {__localJobError:String(error?.message||error).slice(0,700)};
    throw error;
  }
}
