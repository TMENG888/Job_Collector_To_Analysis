// Display capture is user-selected and stays in this page: no recording/upload/input.
export function createBrowserMirror({video,mediaDevices=globalThis.navigator?.mediaDevices,onState=()=>{}}){
  let stream=null,opening=false,closed=false;
  function stop(){const previous=stream;stream=null;video.srcObject=null;video.hidden=true;for(const track of previous?.getTracks()||[])track.stop();onState({active:false});}
  return {
    async start(){
      if(opening)throw Error('正在等待画面共享授权');
      if(!mediaDevices?.getDisplayMedia)throw Error('当前工作台不支持画面共享；请用普通Chrome/Edge打开本机工作台后点击共享');
      opening=true;
      try{
        const captured=await mediaDevices.getDisplayMedia({video:{frameRate:{ideal:15,max:24}},audio:false});
        if(closed){captured.getTracks().forEach(t=>t.stop());return;}
        stop();stream=captured;const track=stream.getVideoTracks()[0];
        if(!track){stop();throw Error('未获得视频画面');}
        track.addEventListener('ended',()=>{if(stream===captured)stop();},{once:true});
        video.srcObject=stream;video.hidden=false;await video.play();if(stream!==captured)throw Error('画面共享已结束');
        onState({active:true,label:track.label||'已授权窗口',surface:track.getSettings?.().displaySurface||'unknown'});
      }catch(e){stop();if(e.name==='NotAllowedError'||e.name==='AbortError')throw Error('已取消画面共享；普通浏览器及岗位插件不受影响');throw e;}
      finally{opening=false;}
    },
    stop,
    dispose(){closed=true;stop();},
    get active(){return !!stream;}
  };
}
