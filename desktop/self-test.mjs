import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function runSelfTest({app,createDesktop,runtime}) {
  const checks=[],errors=[];
  const check=(name,actual,expected)=>{assert.deepEqual(actual,expected,name);checks.push(name);};
  const wait=async(fn,label)=>{const start=Date.now();while(Date.now()-start<12000){if(await fn())return;await new Promise(r=>setTimeout(r,60));}throw Error('Timed out: '+label);};
  let workspaceDown=false,desktop,exitCode=1;
  const server=http.createServer((req,res)=>{
    if(workspaceDown){res.destroy();return;}
    const route=req.url.includes('view=assistant')?'assistant':req.url.startsWith('/tasks')?'tasks':req.url.startsWith('/matching')?'matching':req.url.startsWith('/quality')?'quality':'insights';
    res.writeHead(200,{'content-type':'text/html; charset=utf-8'});
    res.end('<!doctype html><meta charset="utf-8"><style>body{margin:0}.shell{display:grid;grid-template-columns:76px minmax(0,1fr)}.sidebar{display:block;width:76px}main{min-width:0}</style><body data-view="'+route+'"><div class="shell"><aside class="sidebar">Web导航</aside><main><h1>隔离本地工作台</h1></main></div>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const output=process.env.JOB_DESKTOP_TEST_OUTPUT||path.join(runtime,'self-test.json');
  try {
    desktop=await createDesktop({runtime,baseURL:base,visible:false});
    await wait(()=>desktop.state().workspaceStatus==='ready','initial workspace');
    check('workspace uses WebContentsView',desktop.workspace.constructor.name,'WebContentsView');
    check('one local content view',desktop.window.contentView.children.length,1);
    check('trusted shell bridge',await desktop.window.webContents.executeJavaScript('typeof window.jobDesktop.command'),'function');
    check('trusted IPC version',(await desktop.window.webContents.executeJavaScript('window.jobDesktop.command("state")')).version,'0.2.0');
    check('workspace receives no host bridge',await desktop.workspace.webContents.executeJavaScript('typeof window.jobDesktop'),'undefined');
    check('five desktop navigation items',await desktop.window.webContents.executeJavaScript('Array.from(document.querySelectorAll("[data-route]")).map(x=>x.dataset.route)'),['tasks','quality','insights','matching','assistant']);
    check('retired browser controls absent',await desktop.window.webContents.executeJavaScript('!!document.querySelector("#browserChrome,#tools,#recruiterStart,[data-route=browser]")'),false);
    const {Menu}=await import('electron');
    const zoomMenu=id=>Menu.getApplicationMenu().getMenuItemById('workspace-zoom-'+id).click();
    zoomMenu('reset');zoomMenu('in');
    check('menu zoom targets business page',desktop.workspace.webContents.getZoomFactor(),1.1);
    check('menu zoom targets shell',desktop.window.webContents.getZoomFactor(),1.1);
    check('scaled page stays below navigation',desktop.workspace.getBounds().y,Math.round(56*1.1));
    await desktop.command('workspace',{route:'matching'});await wait(()=>desktop.state().workspaceStatus==='ready','zoom navigation');
    check('zoom survives route navigation',desktop.workspace.webContents.getZoomFactor(),1.1);
    desktop.workspace.webContents.reload();await wait(()=>desktop.state().workspaceStatus==='ready','zoom reload');
    check('zoom survives refresh',desktop.workspace.webContents.getZoomFactor(),1.1);
    zoomMenu('reset');
    for(const content of [desktop.window.webContents,desktop.workspace.webContents]){
      let prevented=false;content.emit('before-input-event',{preventDefault(){prevented=true;}},{type:'keyDown',control:true,key:'-',code:'Minus'});
      check('shortcut cancels default target '+content.id,prevented,true);
    }
    check('shortcuts from both views share scale',desktop.workspace.webContents.getZoomFactor(),.8);
    desktop.workspace.webContents.emit('zoom-changed',{},'in');
    check('wheel zoom targets business page',desktop.workspace.webContents.getZoomFactor(),.9);
    check('wheel zoom keeps shell in sync',desktop.window.webContents.getZoomFactor(),.9);
    await wait(async()=>JSON.parse(await fs.readFile(path.join(runtime,'workspace-zoom.json'),'utf8')).factor===.9,'saved zoom');
    checks.push('zoom preference saved outside source');
    zoomMenu('reset');
    check('reset restores both views',[desktop.window.webContents.getZoomFactor(),desktop.workspace.webContents.getZoomFactor()],[1,1]);
    for(const [key,value] of Object.entries({nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}))check('workspace '+key,desktop.workspace.webContents.getLastWebPreferences()[key],value);
    for(const route of ['tasks','quality','insights','matching','assistant']) {
      await desktop.command('workspace',{route});
      await wait(()=>desktop.state().workspaceStatus==='ready'&&desktop.state().workspaceRoute===route,'route '+route);
      check(route+' rendered',await desktop.workspace.webContents.executeJavaScript('document.body.dataset.view'),route);
      check(route+' single navigation',await desktop.workspace.webContents.executeJavaScript('getComputedStyle(document.querySelector(".sidebar")).display'),'none');
      check(route+' fills workspace',await desktop.workspace.webContents.executeJavaScript('Math.round(document.querySelector("main").getBoundingClientRect().left)'),0);
      await wait(()=>desktop.window.webContents.executeJavaScript('document.querySelector("[data-route='+route+']").classList.contains("active")'),'active '+route);
    }
    for(const name of ['browser','open','navigate','read','classify','models','recruiter-start','executeJavaScript']) {
      await assert.rejects(desktop.command(name));checks.push('retired IPC rejected: '+name);
    }
    await assert.rejects(desktop.command('workspace',{route:'browser'}));checks.push('retired workspace route rejected');
    check('preload rejects browser command',await desktop.window.webContents.executeJavaScript('window.jobDesktop.command("browser").then(()=>false,()=>true)'),true);
    await desktop.workspace.webContents.executeJavaScript('history.pushState({},"","/browser")');
    await wait(()=>desktop.workspace.webContents.getURL()===base+'/tasks'&&desktop.state().workspaceStatus==='ready','legacy route redirects');
    check('legacy route returns to tasks',desktop.state().workspaceRoute,'tasks');
    await desktop.workspace.webContents.executeJavaScript('history.pushState({},"","/insights")');
    await wait(()=>desktop.state().workspaceRoute==='insights','SPA navigation sync');
    check('SPA navigation stays ready',desktop.state().workspaceStatus,'ready');
    workspaceDown=true;await desktop.command('workspace',{route:'tasks',retry:true});
    await wait(()=>desktop.state().workspaceStatus==='error','failed workspace');
    check('failed content hidden',desktop.workspace.getVisible(),false);
    await wait(()=>desktop.window.webContents.executeJavaScript('!document.querySelector("#workspaceRecovery").hidden'),'recovery panel');
    workspaceDown=false;await desktop.command('workspace',{route:'tasks',retry:true});
    await wait(()=>desktop.state().workspaceStatus==='ready','retry workspace');
    check('manual retry restores content',desktop.workspace.getVisible(),true);
    check('no recruitment tabs created',desktop.state().tabs,[]);
    exitCode=0;
  }catch(error){errors.push(error.stack);}
  finally {
    await fs.mkdir(path.dirname(output),{recursive:true});
    await fs.writeFile(output,JSON.stringify({passed:exitCode===0,count:checks.length,checks,errors,realSiteRequests:0,paidModelCalls:0,at:new Date().toISOString()},null,2));
    console.log(JSON.stringify({passed:exitCode===0,checks:checks.length,report:output,errors}));
    if(desktop&&!desktop.window.isDestroyed())desktop.window.destroy();
    await new Promise(resolve=>server.close(resolve));app.exit(exitCode);
  }
}

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
    desktop=await createDesktop({runtime,baseURL:base,visible:false});
    const local=desktop.workspace.webContents;
    const {Menu}=await import('electron');
    const zoomMenu=id=>Menu.getApplicationMenu().getMenuItemById('workspace-zoom-'+id).click();
    await wait(()=>desktop.state().workspaceStatus==='ready');
    for(const [factor,commands] of [[.75,['out','out','out']],[1.25,['in','in']],[2,['in','in','in','in','in']]]){
      zoomMenu('reset');for(const command of commands)zoomMenu(command);
      check('real content scale '+factor,local.getZoomFactor(),factor);
      check('real shell scale '+factor,desktop.window.webContents.getZoomFactor(),factor);
      check('real toolbar fits at '+factor,await desktop.window.webContents.executeJavaScript('document.documentElement.scrollWidth<=innerWidth'),true);
      check('real scaled toolbar boundary '+factor,Math.round(await desktop.window.webContents.executeJavaScript('document.querySelector(".appbar").getBoundingClientRect().bottom')*factor),desktop.workspace.getBounds().y);
    }
    zoomMenu('reset');
    for(const route of ['insights','tasks','quality','matching','assistant']) {
      await desktop.command('workspace',{route});
      await wait(()=>local.executeJavaScript('document.body.dataset.view==='+JSON.stringify(route)));
      check('real '+route+' Web sidebar hidden',await local.executeJavaScript('getComputedStyle(document.querySelector(".sidebar")).display'),'none');
      check('real '+route+' single-column grid',await local.executeJavaScript('getComputedStyle(document.querySelector(".shell")).gridTemplateColumns.trim().split(/\\s+/).length'),1);
      check('real '+route+' title',await local.executeJavaScript('document.querySelector("#pageTitle").textContent'),{tasks:'采集任务',quality:'数据质量报告',insights:'岗位洞察',matching:'简历匹配',assistant:'求职助手'}[route]);
      if(route==='quality'){
        await wait(()=>local.executeJavaScript('!!document.querySelector("#qualityReport .quality-metrics")'));
        check('real quality report loaded',await local.executeJavaScript('document.querySelectorAll("#qualityReport .quality-metrics strong").length'),4);
      }
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
    await assert.rejects(desktop.command('browser'));check('removed browser command rejected',desktop.state().mode,'workspace');check('no browser navigation',await desktop.window.webContents.executeJavaScript('!!document.querySelector("[data-route=browser],#browserChrome,#tools")'),false);
    exitCode=0;
  }catch(e){errors.push(e.stack);if(desktop)errors.push(JSON.stringify({mode:desktop.state().mode,workspaceRoute:desktop.state().workspaceRoute,visible:desktop.workspace.getVisible(),url:desktop.workspace.webContents.getURL(),bounds:desktop.workspace.getBounds()}));}
  finally{
    await fs.mkdir(path.dirname(output),{recursive:true});
    const report={passed:exitCode===0,count:checks.length,checks,errors,warnings,blockedWrites,realSiteRequests:0,paidModelCalls:0,externalSends:0,at:new Date().toISOString()};
    await fs.writeFile(output,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,checks:report.count,report:output,errors}));
    if(desktop&&!desktop.window.isDestroyed())desktop.window.destroy();app.exit(exitCode);
  }
}
