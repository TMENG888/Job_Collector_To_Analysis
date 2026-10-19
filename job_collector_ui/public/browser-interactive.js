// Viewport-only extension mirror: no video-window coordinates, debugger, recording or uploads.
export function installInteractiveMirror({root,post,note,stopVideo=()=>{}}){
  const stage=root.querySelector('[data-jb-stage]'),controls=root.querySelector('[data-jb-mirror-controls]');
  const button=document.createElement('button');button.type='button';button.dataset.jbInteractive='';button.textContent='开启可交互镜像';controls.prepend(button);
  const canvas=document.createElement('canvas');canvas.className='jb-interactive-canvas';canvas.hidden=true;canvas.tabIndex=0;canvas.setAttribute('aria-label','招聘网页交互镜像');
  const input=document.createElement('textarea');input.className='jb-ime';input.setAttribute('aria-label','交互镜像文字输入');input.autocomplete='off';input.hidden=true;stage.append(canvas,input);
  let active=false,state=null,frame=null,timer=null,capturing=false,sending=false,pending=null,epoch=0,composing=false;
  const tab=()=>state?.tabs?.find(t=>t.id===state.selectedTabId);
  function stop(message){active=false;epoch++;clearTimeout(timer);frame=null;if(pending){pending.resolve(false);pending=null;}canvas.hidden=true;input.hidden=true;button.textContent='开启可交互镜像';controls.querySelector('[data-jb-mirror-state]').textContent='只读共享或交互镜像可按需开启';stage.classList.remove('jb-stage-interactive');if(message)note(message,true);}
  function schedule(){clearTimeout(timer);if(active)timer=setTimeout(()=>void capture(),800);}
  async function capture(){
    if(!active||capturing||sending||pending)return;const version=epoch,id=tab()?.id;
    if(document.hidden||!id){stop('镜像已暂停，请重新选中招聘标签');return;}
    capturing=true;
    try{const f=await post('mirror-frame',{tabId:id});const image=new Image();image.src=f.dataURL;await image.decode();if(!active||version!==epoch||tab()?.id!==id||pending)return;
      canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;canvas.getContext('2d').drawImage(image,0,0);frame=f;canvas.hidden=false;input.hidden=false;
      root.querySelector('[data-jb-empty]').hidden=true;root.querySelector('[data-jb-native]').hidden=true;stage.classList.add('jb-stage-interactive');
    }catch(e){if(/截图期间网页发生变化|采样过快/.test(e.message)){if(!pending)frame=null;}else stop(e.message);}finally{capturing=false;if(active&&pending){const next=pending;pending=null;void dispatch(next.value,next.frame,next.version).then(next.resolve);}else schedule();}
  }
  async function dispatch(value,f,version){
    if(!active||version!==epoch||tab()?.id!==f.tabId)return false;
    sending=true;clearTimeout(timer);frame=null;
    try{await post('mirror-input',{tabId:f.tabId,frameId:f.frameId,input:value});if(active&&version===epoch)note('操作已转发，请以网页变化为准');return true;}
    catch(e){if(active&&version===epoch)note(e.message,true);return false;}finally{sending=false;if(active){clearTimeout(timer);timer=setTimeout(()=>void capture(),100);}}
  }
  function send(value){
    if(!active)return Promise.resolve(false);
    if(sending||pending){note('上一操作正在处理，本次未执行；请稍候再操作',true);return Promise.resolve(false);}
    if(!frame){note('正在获取新画面，本次未执行；请画面更新后操作',true);return Promise.resolve(false);}
    clearTimeout(timer);
    if(capturing)return new Promise(resolve=>{pending={value,frame,version:epoch,resolve};});
    return dispatch(value,frame,epoch);
  }
  const point=e=>{const box=canvas.getBoundingClientRect();return {x:(e.clientX-box.left)*frame.width/box.width,y:(e.clientY-box.top)*frame.height/box.height};};
  canvas.onclick=e=>{e.preventDefault();if(!frame){void send({type:'click'});return;}input.focus({preventScroll:true});void send({type:'click',...point(e)});};
  canvas.addEventListener('wheel',e=>{e.preventDefault();if(!frame){void send({type:'scroll'});return;}const scale=e.deltaMode===1?16:e.deltaMode===2?frame.height:1;void send({type:'scroll',...point(e),deltaX:Math.max(-2000,Math.min(2000,e.deltaX*scale)),deltaY:Math.max(-2000,Math.min(2000,e.deltaY*scale))});},{passive:false});
  // Keep typing in a local box until the user commits a complete chunk, never drop IME characters.
  input.hidden=true;input.placeholder='点击网页输入框后，在这里输入，Enter发送到该输入框；Ctrl+Enter触发网页回车';input.className='jb-remote-text';
  input.addEventListener('compositionstart',()=>{composing=true;});input.addEventListener('compositionend',()=>{composing=false;});
  input.addEventListener('keydown',e=>{if(composing||e.isComposing)return;if(e.key!=='Enter'||e.shiftKey)return;e.preventDefault();
    if(e.ctrlKey){if(input.value){note('请先按Enter将文字写入网页，再按Ctrl+Enter触发网页回车',true);return;}void send({type:'key',key:'Enter'});return;}
    if(input.value){const text=input.value;void send({type:'text',text}).then(ok=>{if(ok&&input.value.startsWith(text))input.value=input.value.slice(text.length);});}});
  button.onclick=()=>{if(active){stop();note('交互镜像已停止');return;}if(!state?.running||state.mode!=='extension'){note('请先连接1.2.0扩展',true);return;}stopVideo();active=true;epoch++;button.textContent='停止交互镜像';controls.querySelector('[data-jb-mirror-state]').textContent='交互镜像 · 点击/滚动网页 · 下方输入文字';note('交互镜像已开启；密码、验证码和不支持的网页控件请在原窗口操作');void capture();};
  document.addEventListener('job-workspace-view',e=>{if(e.detail.view!=='browser')stop();});document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();});window.addEventListener('pagehide',()=>stop());
  return {render(next){const previous=tab()?.id;state=next;button.disabled=!next.running||next.mode!=='extension'||!!next.jobFinder?.busy;button.hidden=!next.features?.interactiveMirror;
    if(active&&(!next.running||next.mode!=='extension'||next.jobFinder?.busy||previous!==tab()?.id))stop('自动筛选或页面切换期间已停止交互镜像');
    if(active&&frame){root.querySelector('[data-jb-empty]').hidden=true;root.querySelector('[data-jb-native]').hidden=true;controls.querySelector('[data-jb-mirror-state]').textContent='交互镜像 · 点击/滚动网页 · 下方输入文字';}
  },stop,get active(){return active;}};
}
