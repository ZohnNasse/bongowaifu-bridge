const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  start: () => ipcRenderer.invoke('bridge:start'),
  stop: () => ipcRenderer.invoke('bridge:stop'),
  status: () => ipcRenderer.invoke('bridge:status'),
  chat: (t) => ipcRenderer.invoke('chat:send', t),
  sayManual: (t) => ipcRenderer.invoke('say:manual', t),
  askNow: () => ipcRenderer.invoke('ask:manual'),
  getMemory: () => ipcRenderer.invoke('memory:get'),
  clearMemory: () => ipcRenderer.invoke('memory:clear'),
  onLog: (cb) => ipcRenderer.on('log', (_, d) => cb(d)),
});
