// Aioc Electron shell: a thin window around the daemon's web UI. Starts the daemon if it is
// not running; closing the window never touches the daemon or its sessions.
const { app, BrowserWindow, Menu } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const DAEMON = path.join(__dirname, '..', 'daemon', 'daemon.js');
const INFO_FILE = path.join(os.homedir(), '.aioc', 'daemon.json');
app.setPath('userData', path.join(os.homedir(), '.aioc', 'electron'));

function readInfo() {
  try { return JSON.parse(fs.readFileSync(INFO_FILE, 'utf8')); } catch { return null; }
}

function health(port) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1000 }, res => {
      res.resume(); resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function ensureDaemon() {
  let info = readInfo();
  if (info && (await health(info.port))) return info;
  spawn('node', [DAEMON], { detached: true, stdio: 'ignore', windowsHide: true, cwd: path.dirname(DAEMON) }).unref();
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 250));
    info = readInfo();
    if (info && (await health(info.port))) return info;
  }
  throw new Error('Aioc-Daemon konnte nicht gestartet werden (node im PATH?)');
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null); // keine Accelerators – alle Tasten gehören dem Terminal
  let info;
  try { info = await ensureDaemon(); } catch (err) {
    const { dialog } = require('electron');
    dialog.showErrorBox('Aioc', err.message);
    app.quit();
    return;
  }
  const BOUNDS_FILE = path.join(os.homedir(), '.aioc', 'window.json');
  let bounds = null;
  try { bounds = JSON.parse(fs.readFileSync(BOUNDS_FILE, 'utf8')); } catch {}
  const win = new BrowserWindow({
    width: bounds?.width || 1500, height: bounds?.height || 950,
    x: bounds?.x, y: bounds?.y, minWidth: 900, minHeight: 500,
    backgroundColor: '#0C0C0C', autoHideMenuBar: true, title: 'Aioc',
  });
  if (bounds?.maximized) win.maximize();
  win.on('close', () => {
    try {
      const b = win.isMaximized() ? { ...(bounds || {}), maximized: true } : { ...win.getBounds(), maximized: false };
      fs.writeFileSync(BOUNDS_FILE, JSON.stringify(b));
    } catch {}
  });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') { win.webContents.toggleDevTools(); e.preventDefault(); }
  });
  win.loadURL(`http://127.0.0.1:${info.port}/?token=${encodeURIComponent(info.token)}`);
});

app.on('window-all-closed', () => app.quit());
