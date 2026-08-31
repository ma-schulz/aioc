// Aioc Electron shell: a thin window around the daemon's web UI. Locally it starts the daemon if
// needed; with a connection link as argument it opens a remote daemon (HTTPS/WSS) and pins the
// certificate to the fingerprint in the link instead of showing a certificate warning.
// Closing the window never touches the daemon or its sessions.
const { app, BrowserWindow, Menu, session, dialog } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const DAEMON = path.join(__dirname, '..', 'daemon', 'daemon.js');
const AIOC_HOME = process.env.AIOC_HOME || path.join(os.homedir(), '.aioc');
const INFO_FILE = path.join(AIOC_HOME, 'daemon.json');
app.setPath('userData', path.join(AIOC_HOME, 'electron'));

const remoteUrl = process.argv.slice(1).find(a => /^https?:\/\//i.test(a)) || null;
const remote = remoteUrl ? new URL(remoteUrl) : null;

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
  spawn('node', [DAEMON], { detached: true, stdio: 'ignore', windowsHide: true, cwd: path.dirname(DAEMON), env: process.env }).unref();
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 250));
    info = readInfo();
    if (info && (await health(info.port))) return info;
  }
  throw new Error('Aioc-Daemon konnte nicht gestartet werden (node im PATH?)');
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null); // keine Accelerators – alle Tasten gehören dem Terminal

  // Zwischenablage lesen (Text UND Bilder erkennen) ist für die eigene UI erlaubt
  const clipboardPerms = new Set(['clipboard-read', 'clipboard-sanitized-write']);
  const isOwnUi = url => /^http:\/\/127\.0\.0\.1(:\d+)?\//.test(url || '') || (remote && (url || '').startsWith(remote.origin));
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) =>
    cb(clipboardPerms.has(permission) && isOwnUi(details?.requestingUrl || wc.getURL())));
  session.defaultSession.setPermissionCheckHandler((wc, permission, origin) =>
    clipboardPerms.has(permission) && isOwnUi(origin ? origin + '/' : wc?.getURL()));

  let url;
  if (remote) {
    // Fernzugriff: selbst erzeugtes Zertifikat des Daemons wird über den Fingerprint im Link gepinnt
    const fp = remote.searchParams.get('fp');
    session.defaultSession.setCertificateVerifyProc((request, callback) => {
      const ok = request.hostname === remote.hostname && !!fp && request.certificate?.fingerprint === 'sha256/' + fp;
      callback(ok ? 0 : -2);
    });
    url = remoteUrl;
  } else {
    let info;
    try { info = await ensureDaemon(); } catch (err) {
      dialog.showErrorBox('Aioc', err.message);
      app.quit();
      return;
    }
    url = `http://127.0.0.1:${info.port}/?token=${encodeURIComponent(info.token)}`;
  }

  const BOUNDS_FILE = path.join(AIOC_HOME, 'window.json');
  let bounds = null;
  try { bounds = JSON.parse(fs.readFileSync(BOUNDS_FILE, 'utf8')); } catch {}
  const win = new BrowserWindow({
    width: bounds?.width || 1500, height: bounds?.height || 950,
    x: bounds?.x, y: bounds?.y, minWidth: 900, minHeight: 500,
    backgroundColor: '#0C0C0C', autoHideMenuBar: true, title: remote ? `Aioc – ${remote.hostname}` : 'Aioc',
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
  win.webContents.on('did-fail-load', (e, code, desc) => {
    if (remote) dialog.showErrorBox('Aioc', `Verbindung zu ${remote.host} fehlgeschlagen: ${desc} (${code}).\nStimmt der Link (Token, Fingerprint), ist LAN-Zugriff an, lässt die Firewall den Port durch?`);
  });
  win.loadURL(url);
});

app.on('window-all-closed', () => app.quit());
