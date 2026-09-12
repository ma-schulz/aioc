// Aioc Electron shell: a thin window around the daemon's web UI. Locally it starts the daemon if
// needed; with a connection link as argument it opens a remote daemon (HTTPS/WSS) and pins the
// certificate to the fingerprint in the link instead of showing a certificate warning.
// Closing the window never touches the daemon or its sessions.
const { app, BrowserWindow, Menu, session, dialog, shell, ipcMain } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const DAEMON = path.join(__dirname, '..', 'daemon', 'daemon.js');
const AIOC_HOME = process.env.AIOC_HOME || path.join(os.homedir(), '.aioc');
const INFO_FILE = path.join(AIOC_HOME, 'daemon.json');
app.setPath('userData', path.join(AIOC_HOME, 'electron'));

// Windows ordnet Toasts einer AppUserModelID zu. Mit einer festen eigenen taucht Aioc in den
// Windows-Benachrichtigungseinstellungen als eigener Eintrag auf (Ton, Banner, Nicht stoeren);
// ohne sie liefen die Meldungen unter der Kennung von Electron.
app.setAppUserModelId('de.mp-systeme.aioc');

const remoteUrl = process.argv.slice(1).find(a => /^https?:\/\//i.test(a)) || null;
const remote = remoteUrl ? new URL(remoteUrl) : null;

// Links aus dem Terminal im Standardbrowser des Rechners oeffnen (Chrome & Co. haben die Logins,
// ein zweites Electron-Fenster nicht). Nur http(s)/mailto: - xterm reicht OSC-8-Ziele ungeprueft
// durch, shell.openExternal wuerde sonst auch beliebige Protokoll-Handler starten.
ipcMain.on('aioc-open-external', (_e, url) => {
  if (typeof url === 'string' && /^(https?|mailto):/i.test(url)) shell.openExternal(url);
});

// Klick auf einen Toast soll das Fenster nach vorn holen - im Renderer allein reicht window.focus() dafuer nicht
ipcMain.on('aioc-focus-window', e => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

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

  // Erlaubt fuer die eigene UI: Zwischenablage lesen (Text UND Bilder erkennen) und
  // Benachrichtigungen - ohne 'notifications' bliebe der Toast aus dem Fenster still.
  const ownPerms = new Set(['clipboard-read', 'clipboard-sanitized-write', 'notifications']);
  const isOwnUi = url => /^http:\/\/127\.0\.0\.1(:\d+)?\//.test(url || '') || (remote && (url || '').startsWith(remote.origin));
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) =>
    cb(ownPerms.has(permission) && isOwnUi(details?.requestingUrl || wc.getURL())));
  session.defaultSession.setPermissionCheckHandler((wc, permission, origin) =>
    ownPerms.has(permission) && isOwnUi(origin ? origin + '/' : wc?.getURL()));

  let url;
  let pinFailure = null;
  if (remote) {
    // Fernzugriff: selbst erzeugtes Zertifikat des Daemons wird über den Fingerprint im Link gepinnt.
    // Neuer Linkstil: '#fp=<base64url>' (kein '&' im Link); alter Stil '&fp=<base64>' bleibt gültig.
    let fp = (remote.hash.match(/^#fp=([A-Za-z0-9_-]+)/) || [])[1] || remote.searchParams.get('fp') || '';
    if (fp && !fp.includes('/') && !fp.includes('+')) {
      fp = fp.replace(/-/g, '+').replace(/_/g, '/');
      while (fp.length % 4) fp += '=';
    }
    // Kein Fingerprint im Link: dann laeuft der Daemon mit einem oeffentlich vertrauenswuerdigen
    // Zertifikat (z. B. von Tailscale) und Chromium prueft ganz normal. Nur das selbst erzeugte
    // Zertifikat muss gepinnt werden.
    if (fp) session.defaultSession.setCertificateVerifyProc((request, callback) => {
      const seen = request.certificate?.fingerprint || '';
      const ok = request.hostname === remote.hostname && seen === 'sha256/' + fp;
      if (!ok) pinFailure = request.hostname !== remote.hostname
        ? `Zertifikat für anderen Host (${request.hostname})`
        : `Zertifikats-Fingerprint passt nicht.\n  Link:   ${fp}\n  Server: ${seen.replace(/^sha256\//, '')}\nAuf dem Daemon-Rechner den Link neu kopieren (LAN an → Link kopieren).`;
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
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  if (bounds?.maximized) win.maximize();
  // Sicherheitsnetz: falls doch ein window.open aus dem Renderer durchgeht, nie ein zweites
  // Electron-Fenster oeffnen, sondern die URL extern (Standardbrowser) aufmachen.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
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
    if (!remote) return;
    const why = pinFailure
      ? pinFailure
      : code === -102 ? 'Verbindung abgelehnt – ist LAN-Zugriff auf dem Daemon-Rechner eingeschaltet?'
      : code === -118 || code === -7 ? 'Zeitüberschreitung – Firewall/VPN-Route zum Port prüfen.'
      : 'Stimmt der Link (Token, Fingerprint), ist LAN-Zugriff an, lässt die Firewall den Port durch?';
    dialog.showErrorBox('Aioc', `Verbindung zu ${remote.host} fehlgeschlagen: ${desc} (${code}).\n${why}`);
  });
  win.loadURL(url);
});

app.on('window-all-closed', () => app.quit());
