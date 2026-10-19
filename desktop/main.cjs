const {app, dialog} = require('electron');
const fs = require('node:fs');
const path = require('node:path');

// Set storage before Chromium starts. Never use Chrome's or the Web worker's profile.
const runtime = path.resolve(process.env.JOB_DESKTOP_RUNTIME || 'E:/Codex/work/20261019-job-desktop/runtime');
const selfTest = process.argv.includes('--self-test');
try {
  if (!fs.existsSync(path.parse(runtime).root)) throw Error('桌面版运行盘不可用，请指定可用的E盘目录');
  fs.mkdirSync(runtime, {recursive:true});
  app.setPath('userData', path.join(runtime, selfTest ? 'test-profile' : 'profile'));
  app.setPath('sessionData', path.join(runtime, selfTest ? 'test-session' : 'sessions'));
  fs.mkdirSync(path.join(runtime,'logs'), {recursive:true});
  app.setPath('logs',path.join(runtime,'logs'));
  fs.mkdirSync(path.join(runtime,'crashes'), {recursive:true});
  app.setPath('crashDumps',path.join(runtime,'crashes'));
  app.setAppUserModelId('local.job-workspace.desktop');
} catch (error) {
  dialog.showErrorBox('岗位工作台无法启动', error.message);
  app.exit(1);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  let desktop;
  app.on('second-instance', () => {if (desktop) {if (desktop.window.isMinimized()) desktop.window.restore();desktop.window.show();desktop.window.focus();}});
  app.whenReady().then(async () => {
    const {createDesktop} = await import('./host.mjs');
    if (selfTest) {
      const {runSelfTest,runLayoutTest} = await import('./self-test.mjs');
      await (process.argv.includes('--check-live-layout')?runLayoutTest:runSelfTest)({app, createDesktop, runtime});
      return;
    }
    desktop = await createDesktop({runtime});
  }).catch(error => {
    // Do not log page content, credentials or browser URLs.
    console.error('Desktop startup failed:', error.code || error.name);
    if (!selfTest) dialog.showErrorBox('岗位工作台启动失败', error.message);
    app.exit(1);
  });
  app.on('window-all-closed', () => app.quit());
}
