// Aioc-Preload: einzige Bruecke vom Renderer in den Main-Prozess - Links im Standardbrowser
// oeffnen (dort liegen die Logins, ein zusaetzliches Electron-Fenster haette keine Cookies).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aioc', {
  openExternal: url => { if (typeof url === 'string') ipcRenderer.send('aioc-open-external', url); },
});
