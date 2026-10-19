import net from 'node:net';
export const browserSites=[
  {id:'boss',name:'BOSS直聘',domain:'zhipin.com',url:'https://www.zhipin.com/'},
  {id:'liepin',name:'猎聘',domain:'liepin.com',url:'https://www.liepin.com/'},
  {id:'zhaopin',name:'智联招聘',domain:'zhaopin.com',url:'https://www.zhaopin.com/'},
  {id:'job51',name:'前程无忧',domain:'51job.com',url:'https://www.51job.com/'},
  {id:'iguopin',name:'国聘',domain:'iguopin.com',url:'https://www.iguopin.com/'},
  {id:'shixiseng',name:'实习僧',domain:'shixiseng.com',url:'https://www.shixiseng.com/'},
];
export function siteForURL(value){try{const u=new URL(value);return browserSites.find(s=>u.hostname===s.domain||u.hostname.endsWith('.'+s.domain))||null;}catch{return null;}}
export function safeBrowserURL(value,{blank=false}={}){
  if(blank&&value==='about:blank')return value;
  let u;try{u=new URL(String(value));}catch{throw Error('招聘网站地址不完整，请填写有效的HTTPS网址');}
  if(u.protocol!=='https:'||u.username||u.password||u.port||!siteForURL(u.href))throw Error('仅允许访问已接入招聘网站的HTTPS地址');
  return u.href;
}
export function privateAddress(value){
  const ip=String(value).replace(/^\[|\]$/g,'').toLowerCase();
  if(net.isIPv4(ip)){const [a,b]=ip.split('.').map(Number);return a===0||a===10||a===127||a>=224||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||(a===100&&b>=64&&b<=127)||(a===198&&(b===18||b===19));}
  if(net.isIPv6(ip)){if(ip.startsWith('::ffff:'))return true;return ip==='::'||ip==='::1'||ip.startsWith('fc')||ip.startsWith('fd')||/^fe[89ab]/.test(ip)||ip.startsWith('ff');}
  return true;
}
export function publicResourceURL(value){
  try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!u.port&&u.hostname!=='localhost'&&!u.hostname.endsWith('.localhost')&&!u.hostname.endsWith('.local')&&(!net.isIP(u.hostname.replace(/^\[|\]$/g,''))||!privateAddress(u.hostname));}catch{return false;}
}
export function cleanJobURL(value){
  const u=new URL(safeBrowserURL(value));const keep=new Set(['id','jobId','positionId','securityId']);
  for(const key of [...u.searchParams.keys()])if(!keep.has(key))u.searchParams.delete(key);
  u.hash='';return u.href;
}
export function validateInput(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('无效输入事件');
  if(input.type==='text'){if(typeof input.text!=='string'||input.text.length>20000)throw Error('输入内容过长');return {type:'text',text:input.text};}
  if(input.type==='mouse'){
    if(!['mousePressed','mouseReleased','mouseMoved','mouseWheel'].includes(input.event)||![input.x,input.y].every(n=>Number.isFinite(n)&&n>=0&&n<=2000))throw Error('无效鼠标事件');
    if(!['none','left','right','middle'].includes(input.button||'none'))throw Error('无效鼠标按键');
    return {type:'mouse',event:input.event,x:input.x,y:input.y,button:input.button||'none',buttons:Number(input.buttons)||0,clickCount:input.event==='mouseMoved'||input.event==='mouseWheel'?0:Math.min(2,Number(input.clickCount)||1),deltaX:Math.max(-2000,Math.min(2000,Number(input.deltaX)||0)),deltaY:Math.max(-2000,Math.min(2000,Number(input.deltaY)||0))};
  }
  if(input.type==='key'){
    const keys=['Backspace','Tab','Enter','Escape','Delete','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown','Control','Shift','Alt','Meta','a','c','v','x','z','y'];
    if(!keys.includes(input.key)||!['keyDown','keyUp'].includes(input.event))throw Error('该键盘事件不受支持');
    return {type:'key',event:input.event,key:input.key,code:String(input.code||'').slice(0,30),modifiers:(Number(input.modifiers)||0)&15,windowsVirtualKeyCode:Math.max(0,Math.min(255,Number(input.keyCode)||0))};
  }
  throw Error('未知输入事件');
}
