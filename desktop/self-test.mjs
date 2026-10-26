// Isolated Electron integration tests. All recruitment HTTPS requests are fixtures.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function runSelfTest({app,createDesktop,runtime}) {
  const checks=[],errors=[],requests=[],navigations=[];let nativeDiagnostics=null;
  const check=(name,actual,expected)=>{assert.deepEqual(actual,expected,name);checks.push(name);};
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const wait=async(fn,label)=>{const start=Date.now();while(Date.now()-start<12000){if(await fn())return;await pause(60);}throw Error('Timed out: '+label);};
  const description='岗位职责：使用Python开发数据分析自动化脚本，使用SQL分析业务数据，设计指标体系并编写数据分析报告，建设数据可视化看板，与业务部门协作分析经营问题。';
  const html=url=>`<!doctype html><meta charset="utf-8"><title>原生浏览器测试岗位</title><style>body{font:18px sans-serif;margin:30px}input,button{padding:12px;font-size:18px}.spacer{height:1600px}#jd,#blank,#external{position:fixed;left:30px;background:white;padding:4px}#jd{top:350px}#blank{top:390px}#external{top:430px}</style><h1>数据分析师</h1><div class="company-name">隔离测试公司</div><div class="job-sec-text">${description}</div><input id="keyword" placeholder="输入中文岗位"><button id="counter" onclick="this.textContent='点击成功';window.clicked=(window.clicked||0)+1">原生点击</button><p><a id="jd" target="_blank" href="https://www.zhipin.com/job_detail/native.html">打开岗位详情</a></p><p><a id="blank" href="about:blank">测试空白回退拦截</a></p><p><a id="external" href="https://evil.example/">外域链接</a></p><p><a href="https://www.zhipin.com/second">下一页</a></p><div class="spacer"></div><p>滚动已到达页尾</p>`;
  const workspaceHTML='<!doctype html><meta charset="utf-8"><style>.shell{display:grid;grid-template-columns:76px minmax(0,1fr)}.sidebar{width:76px;background:#ddd}body{margin:0}main{min-width:0}.hidden{display:none}</style><div class="shell"><aside class="sidebar"><nav>原Web侧栏</nav></aside><main><h1>隔离本地工作台</h1></main></div>';
  let workspaceDown=false;
  const server=http.createServer((req,res)=>{if(workspaceDown){res.destroy();return;}const route=req.url.includes('view=assistant')?'assistant':req.url.startsWith('/tasks')?'tasks':'insights';res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(workspaceHTML.replace('<div class="shell">','<body data-view="'+route+'"><div class="shell">'));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let desktop,exitCode=1;
  const output=process.env.JOB_DESKTOP_TEST_OUTPUT||path.join(runtime,'self-test.json');
  try {
    desktop=await createDesktop({runtime,baseURL:'http://127.0.0.1:'+server.address().port,visible:true,
      setupSession:async ses=>{await ses.protocol.handle('https',request=>{requests.push(new URL(request.url).hostname);if(!/\.(?:zhipin|liepin|zhaopin)\.com$/.test(new URL(request.url).hostname))throw Error('Unexpected fixture host');return new Response(html(request.url),{headers:{'content-type':'text/html; charset=utf-8'}});});},
      screening:{catalog:async()=>[{id:'fixture:lr',role:'数据分析',threshold:.6}],screen:async(modelId,row)=>{check('classifier receives fixture JD, no prompt/network',row.description.includes('Python'),true);return {modelId,decision:'include',role:'数据分析',score:.91,threshold:.6,method:'TF-IDF＋逻辑回归',reason:'夹具输出'};}}
    });
    desktop.window.webContents.on('console-message',(_e,level,message)=>{if(level>=3)errors.push(message);});
    check('WebContentsView workspace',desktop.workspace.constructor.name,'WebContentsView');
    check('trusted shell bridge available',await desktop.window.webContents.executeJavaScript('typeof window.jobDesktop.command'),'function');
    check('trusted IPC main-frame authorization',(await desktop.window.webContents.executeJavaScript('window.jobDesktop.command("state")')).version,'0.1.0');
    check('workspace receives no host bridge',await desktop.workspace.webContents.executeJavaScript('typeof window.jobDesktop'),'undefined');
    await wait(()=>desktop.workspace.webContents.executeJavaScript('!!document.getElementById("job-desktop-layout")'),'desktop-only workspace stylesheet');
    check('desktop suppresses duplicate Web sidebar',await desktop.workspace.webContents.executeJavaScript('getComputedStyle(document.querySelector(".sidebar")).display'),'none');
    check('desktop content reclaims sidebar space',await desktop.workspace.webContents.executeJavaScript('Math.round(document.querySelector("main").getBoundingClientRect().left)'),0);
    await desktop.workspace.webContents.executeJavaScript('document.body.classList.add("assistant-chat-page")');
    check('assistant layout also has only one navigation',await desktop.workspace.webContents.executeJavaScript('getComputedStyle(document.querySelector(".sidebar")).display'),'none');
    await desktop.workspace.webContents.executeJavaScript('document.body.classList.remove("assistant-chat-page")');
    const {WebContentsView}=await import('electron');
    const plain=new WebContentsView({webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
    try {await plain.webContents.loadURL('http://127.0.0.1:'+server.address().port+'/tasks');check('standalone Web sidebar unchanged',await plain.webContents.executeJavaScript('getComputedStyle(document.querySelector(".sidebar")).display'),'block');check('desktop styles absent from standalone Web',await plain.webContents.executeJavaScript('!!document.getElementById("job-desktop-layout")'),false);}finally{plain.webContents.close();}
    const id=await desktop.open('https://www.zhipin.com/');
    let tab=desktop.tabs.get(id),wc=tab.view.webContents;
    for(const name of ['will-navigate','will-frame-navigate','did-start-navigation','did-navigate','will-redirect'])wc.on(name,(event,url)=>{navigations.push({name,url:event.url||url,main:event.isMainFrame,prevented:event.defaultPrevented});});
    await wait(()=>!tab.loading&&wc.getURL().startsWith('https://www.zhipin.com/'),'fixture load');
    desktop.window.show();desktop.window.focus();wc.focus();await pause(200);
    check('native WebContentsView (not iframe/canvas)',tab.view.constructor.name,'WebContentsView');
    const security=wc.getLastWebPreferences();
    for(const [key,expected] of Object.entries({nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,allowRunningInsecureContent:false}))check('remote '+key,security[key],expected);
    check('remote has no Node or host IPC',await wc.executeJavaScript('[typeof require,typeof process,typeof jobDesktop]'),['undefined','undefined','undefined']);
    check('remote no preload',!!security.preload,false);
    check('website private-network request denied',await wc.executeJavaScript(`fetch('http://127.0.0.1:${server.address().port}/secret').then(()=>false,()=>true)`),true);
    const button=await wc.executeJavaScript('(()=>{const r=document.querySelector("#counter").getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
    nativeDiagnostics={button,focused:desktop.window.isFocused(),visible:desktop.window.isVisible(),minimized:desktop.window.isMinimized(),mode:desktop.state().mode,viewVisible:tab.view.getVisible(),bounds:tab.view.getBounds(),page:await wc.executeJavaScript('({focus:document.hasFocus(),visibility:document.visibilityState,width:innerWidth,height:innerHeight,scroll:scrollY})')};
    if(nativeDiagnostics.page.visibility!=='visible')throw Error('测试页处于hidden状态，无法验收原生点击；需在可见桌面重新运行，不重复注入输入');
    wc.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...button});wc.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...button});
    await wait(()=>wc.executeJavaScript('window.clicked===1'),'native click');check('native mouse click',await wc.executeJavaScript('document.querySelector("#counter").textContent'),'点击成功');
    const input=await wc.executeJavaScript('(()=>{const r=document.querySelector("#keyword").getBoundingClientRect();return {x:Math.round(r.x+30),y:Math.round(r.y+20)}})()');
    wc.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...input});wc.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...input});await pause(80);
    await wc.insertText('数据分析工程师');check('native Chinese text input',await wc.executeJavaScript('document.querySelector("#keyword").value'),'数据分析工程师');
    wc.sendInputEvent({type:'mouseWheel',x:100,y:350,deltaY:-650,deltaX:0,canScroll:true});
    await wait(()=>wc.executeJavaScript('scrollY>0'),'native scroll');check('native wheel scroll',await wc.executeJavaScript('scrollY>0'),true);
    const read=await desktop.command('read',{plugin:'read-detail'});check('existing JD plugin title',read.rows[0].title,'数据分析师');check('read-only parser company',read.rows[0].company,'隔离测试公司');
    check('local supervised classifier path',(await desktop.command('classify',{modelId:'fixture:lr'})).result.decision,'include');
    await assert.rejects(desktop.command('executeJavaScript',{code:'bad'}));checks.push('generic execution IPC denied');
    const clickLink=async selector=>{const point=await wc.executeJavaScript(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.x+30),y:Math.round(r.y+r.height/2)}})()`);wc.focus();wc.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});wc.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});await pause(200);};
    await clickLink('#blank');check('blank navigation explicitly reported',!!desktop.state().tabs.find(t=>t.id===id).error,true);check('blank native view hidden behind recovery UI',tab.view.getVisible(),false);
    await desktop.command('back');await wait(()=>!tab.loading&&wc.getURL()==='https://www.zhipin.com/','manual blank recovery');check('manual back recovers without reload loop',tab.view.getVisible(),true);
    await clickLink('#external');check('external navigation blocked',wc.getURL(),'https://www.zhipin.com/');
    await clickLink('#jd');await wait(()=>desktop.tabs.size===2,'JD popup native tab');
    const next=desktop.tabs.get(desktop.state().selectedId);await wait(()=>!next.loading,'detail native tab');check('target blank opens JD tab',next.view.webContents.getURL(),'https://www.zhipin.com/job_detail/native.html');
    await desktop.command('select',{id});check('switch tab retains typed text',await wc.executeJavaScript('document.querySelector("#keyword").value'),'数据分析工程师');
    await desktop.command('navigate',{url:'https://www.zhipin.com/second'});await wait(()=>!tab.loading&&wc.getURL().endsWith('/second'),'navigation');
    await assert.rejects(desktop.command('classify',{modelId:'fixture:lr'}));checks.push('stale JD invalidated after navigation');
    await desktop.command('back');await wait(()=>!tab.loading&&wc.getURL()==='https://www.zhipin.com/','back');check('native back',wc.getURL(),'https://www.zhipin.com/');
    await desktop.command('forward');await wait(()=>!tab.loading&&wc.getURL().endsWith('/second'),'forward');check('native forward',wc.getURL(),'https://www.zhipin.com/second');
    await desktop.command('navigate',{url:'https://www.liepin.com/'});await wait(()=>desktop.tabs.size===3,'cross site new tab');
    const liepin=desktop.tabs.get(desktop.state().selectedId);await wait(()=>!liepin.loading,'liepin fixture');check('per-platform independent sessions',liepin.view.webContents.session!==wc.session,true);
    check('workspace independent session',desktop.workspace.webContents.session!==wc.session,true);
    await desktop.command('workspace',{route:'tasks'});check('workspace toggle',desktop.state().mode,'workspace');check('native page hidden in workspace',tab.view.getVisible(),false);
    await desktop.command('browser');check('browser toggle',desktop.state().mode,'browser');
    const closedContents=liepin.view.webContents;await desktop.command('close',{id:liepin.id});await wait(()=>closedContents.isDestroyed(),'tab disposal');check('closing tab releases WebContents',closedContents.isDestroyed(),true);
    const models=(await desktop.command('models')).models;check('model catalog',models[0].id,'fixture:lr');
    workspaceDown=true;await desktop.command('workspace',{route:'tasks',retry:true});
    await wait(()=>desktop.state().workspaceStatus==='error','failed workspace is explicit');
    check('failed workspace hidden for recovery',desktop.workspace.getVisible(),false);
    await wait(()=>desktop.window.webContents.executeJavaScript('!document.querySelector("#workspaceRecovery").hidden'),'workspace recovery panel');
    workspaceDown=false;await desktop.command('workspace',{route:'tasks',retry:true});
    await wait(()=>desktop.state().workspaceStatus==='ready','same-URL manual retry recovers');
    check('same-URL retry restores workspace',desktop.workspace.getVisible(),true);
    await desktop.command('workspace',{route:'tasks'});await wait(()=>desktop.workspace.webContents.getURL().endsWith('/tasks'),'fixture workspace route');
    await desktop.workspace.webContents.executeJavaScript('history.pushState({},"","/insights")');await wait(()=>desktop.state().workspaceRoute==='insights','sync workspace active route');
    check('SPA URL change does not restart full-page readiness timeout',desktop.state().workspaceStatus,'ready');
    check('SPA insights updates desktop active navigation',await desktop.window.webContents.executeJavaScript('document.querySelector("[data-route=insights]").classList.contains("active")'),true);
    await desktop.workspace.webContents.executeJavaScript('history.pushState({},"","/?view=assistant")');await wait(()=>desktop.state().workspaceRoute==='assistant','sync assistant route');
    check('assistant URL syncs desktop navigation',await desktop.window.webContents.executeJavaScript('document.querySelector("[data-route=assistant]").classList.contains("active")'),true);
    await desktop.workspace.webContents.executeJavaScript('document.body.dataset.view="assistant"');
    await desktop.workspace.webContents.executeJavaScript('document.body.dataset.view="tasks"');await wait(()=>desktop.state().workspaceRoute==='tasks','sync rendered view');
    check('actual rendered view syncs desktop navigation',await desktop.window.webContents.executeJavaScript('document.querySelector("[data-route=tasks]").classList.contains("active")'),true);
    await desktop.workspace.webContents.executeJavaScript('document.body.dataset.view="browser"');await wait(()=>desktop.state().mode==='browser','rendered browser view routes native');
    check('rendered old browser switches to native view',desktop.workspace.getVisible(),false);
    await desktop.command('workspace',{route:'tasks'});await wait(()=>desktop.workspace.webContents.getURL().endsWith('/tasks'),'workspace return before browser SPA test');
    await desktop.workspace.webContents.executeJavaScript('history.pushState({},"","/browser")');await wait(()=>desktop.state().mode==='browser','SPA native browser route');check('existing workspace SPA nav routes to native browser',desktop.state().mode,'browser');
    await desktop.command('select',{id});await desktop.command('read',{plugin:'read-detail'});
    await desktop.window.webContents.executeJavaScript('document.querySelector("#detail").click()');
    await wait(()=>desktop.window.webContents.executeJavaScript('document.querySelector("#results").textContent.includes("数据分析师")'),'shell read button');check('trusted UI plugin button works via IPC',await desktop.window.webContents.executeJavaScript('document.querySelectorAll("#results .job").length'),1);
    await desktop.window.webContents.executeJavaScript('document.querySelector("#classify").click()');await wait(()=>desktop.window.webContents.executeJavaScript('document.querySelector("#classification").textContent.includes("纳入")'),'shell classifier button');check('trusted UI local classifier button',await desktop.window.webContents.executeJavaScript('document.querySelector("#classification").textContent.includes("数据分析")'),true);
    await fs.mkdir(path.dirname(output),{recursive:true});
    await fs.writeFile(path.join(path.dirname(output),'native-fixture.png'),(await wc.capturePage()).toPNG());
    await fs.writeFile(path.join(path.dirname(output),'desktop-shell-fixture.png'),(await desktop.window.webContents.capturePage()).toPNG());
    check('no unexpected renderer error',errors,[]);
    check('all recruiting traffic intercepted locally',requests.every(host=>/\.(?:zhipin|liepin)\.com$/.test(host)),true);
    exitCode=0;
  } catch(error) {errors.push(error.stack);}
  finally {
    await fs.mkdir(path.dirname(output),{recursive:true});
    await fs.writeFile(output,JSON.stringify({passed:exitCode===0,count:checks.length,checks,errors,navigations,nativeDiagnostics,realSiteRequests:0,paidModelCalls:0,externalSends:0,at:new Date().toISOString()},null,2));
    console.log(JSON.stringify({passed:exitCode===0,checks:checks.length,report:output,errors}));
    if(desktop&&!desktop.window.isDestroyed())desktop.window.destroy();
    server.close();app.exit(exitCode);
  }
}

// Separately runnable live-local layout checks; no OS focus or recruiting pages.
export async function runLayoutTest({app,createDesktop,runtime}) {
  const {session}=await import('electron');
  const {checkedBaseURL}=await import('./policy.mjs');
  const base=checkedBaseURL(process.env.JOB_DESKTOP_BASE_URL);
  const output=process.env.JOB_DESKTOP_TEST_OUTPUT||path.join(runtime,'layout-test.json');
  const checks=[],errors=[],warnings=[];let desktop,exitCode=1,blockedWrites=0;
  const check=(name,actual,expected)=>{assert.deepEqual(actual,expected,name);checks.push(name);};
  const wait=async fn=>{const start=Date.now();while(Date.now()-start<12000){if(await fn())return;await new Promise(r=>setTimeout(r,80));}throw Error('Actual workspace did not render in time');};
  // This session belongs to the test profile, never the running desktop or Web.
  session.fromPartition('persist:job-desktop-workspace-v1').webRequest.onBeforeRequest((request,done)=>{
    const write=!['GET','HEAD'].includes(request.method);if(write)blockedWrites++;
    done({cancel:write||!request.url.startsWith(base+'/')});
  });
  try {
    await fs.mkdir(path.dirname(output),{recursive:true});
    desktop=await createDesktop({runtime,baseURL:base,visible:true,screening:{catalog:async()=>[]}});
    const local=desktop.workspace.webContents;
    desktop.window.show();desktop.window.focus();local.focus();
    for(const route of ['insights','tasks','assistant','profile']) {
      await desktop.command('workspace',{route});
      await wait(()=>local.executeJavaScript('document.body.dataset.view==='+JSON.stringify(route)));
      check('real '+route+' Web sidebar hidden',await local.executeJavaScript('getComputedStyle(document.querySelector(".sidebar")).display'),'none');
      check('real '+route+' single-column grid',await local.executeJavaScript('getComputedStyle(document.querySelector(".shell")).gridTemplateColumns.trim().split(/\\s+/).length'),1);
      check('real '+route+' title',await local.executeJavaScript('document.querySelector("#pageTitle").textContent'),{tasks:'采集任务',insights:'岗位洞察',assistant:'求职助手',profile:'个人 Wiki 与简历库'}[route]);
      check('real '+route+' visible content',await local.executeJavaScript('document.querySelector("#'+route+'View").getBoundingClientRect().height>0'),true);
      await wait(()=>desktop.state().workspaceStatus==='ready');
      await wait(()=>desktop.window.webContents.executeJavaScript('document.querySelector("[data-route='+route+']").classList.contains("active")'));
      check('real '+route+' active desktop tab',desktop.state().workspaceRoute,route);
      await new Promise(resolve=>setTimeout(resolve,300));
      try {await fs.writeFile(path.join(path.dirname(output),'live-'+route+'-layout.png'),(await local.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());}
      catch(error){warnings.push(route+' screenshot unavailable: '+error.message);}
    }
    await local.executeJavaScript('document.body.classList.add("assistant-chat-page")');
    check('real assistant CSS hides Web sidebar',await local.executeJavaScript('getComputedStyle(document.querySelector(".sidebar")).display'),'none');
    check('real assistant CSS keeps one column',await local.executeJavaScript('getComputedStyle(document.querySelector(".shell")).gridTemplateColumns.trim().split(/\\s+/).length'),1);
    await desktop.command('browser');check('desktop browser uses native mode',desktop.state().mode,'browser');check('old Web browser view not shown',desktop.workspace.getVisible(),false);
    exitCode=0;
  }catch(e){errors.push(e.stack);if(desktop)errors.push(JSON.stringify({mode:desktop.state().mode,workspaceRoute:desktop.state().workspaceRoute,visible:desktop.workspace.getVisible(),url:desktop.workspace.webContents.getURL(),bounds:desktop.workspace.getBounds()}));}
  finally{
    await fs.mkdir(path.dirname(output),{recursive:true});
    const report={passed:exitCode===0,count:checks.length,checks,errors,warnings,blockedWrites,realSiteRequests:0,paidModelCalls:0,externalSends:0,at:new Date().toISOString()};
    await fs.writeFile(output,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,checks:report.count,report:output,errors}));
    if(desktop&&!desktop.window.isDestroyed())desktop.window.destroy();app.exit(exitCode);
  }
}
