const {contextBridge, ipcRenderer} = require('electron');
const commands = new Set(['state','workspace','browser','open','select','close','navigate','back','forward','reload','stop','read','models','classify','recruiter-state','recruiter-upload','recruiter-preview','recruiter-ack','recruiter-plan','recruiter-start','recruiter-cancel','recruiter-clear']);
contextBridge.exposeInMainWorld('jobDesktop', Object.freeze({
  command: async (command, value = {}) => {
    if (!commands.has(command)) throw Error('不支持的桌面操作');
    const result = await ipcRenderer.invoke('job-desktop:command', command, value);
    if (!result.ok) throw Error(result.error);
    return result.value;
  },
  onState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('job-desktop:state', listener);
    return () => ipcRenderer.removeListener('job-desktop:state', listener);
  }
}));
