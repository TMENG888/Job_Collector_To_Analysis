// Applies only to this desktop WebContentsView, not to the standalone Web app.
// No contextBridge, Node access or generic IPC is exposed to page scripts.
const {ipcRenderer} = require('electron');
if (process.isMainFrame && location.protocol === 'http:' && location.hostname === '127.0.0.1') {
  const views = new Set(['tasks','insights','assistant','browser']);
  let attached = false, lastView = null;
  const attach = () => {
    if (!document.documentElement || !document.body || attached) return false;
    attached = true;
    document.documentElement.dataset.jobDesktop = 'true';
    const style = document.createElement('style');
    style.id = 'job-desktop-layout';
    style.textContent = `
      :root[data-job-desktop] .shell > .sidebar { display:none !important; }
      :root[data-job-desktop] .shell {
        grid-template-columns:minmax(0,1fr) !important;
        grid-template-rows:minmax(0,1fr) !important;
      }
      :root[data-job-desktop] .shell > main { grid-column:1; grid-row:1; min-width:0; }
    `;
    document.documentElement.append(style);
    const sync = () => {
      const view = document.body.dataset.view;
      if (views.has(view) && view !== lastView) {
        lastView = view;
        ipcRenderer.send('job-desktop:workspace-view', view);
      }
    };
    new MutationObserver(sync).observe(document.body, {attributes:true, attributeFilter:['data-view']});
    sync();
    return true;
  };
  if (!attach()) {
    const ready = new MutationObserver(() => {if (attach()) ready.disconnect();});
    ready.observe(document, {childList:true, subtree:true});
  }
}
