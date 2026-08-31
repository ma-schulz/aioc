// Aioc daemon: owns all sessions, serves the web UI, accepts hook reports on /event and
// speaks the client protocol over WebSocket. The UI (Electron or browser) is just a client —
// closing it never touches the sessions. Optional LAN listener: HTTPS/WSS on a second port.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const state = require('./state');
const { SessionManager } = require('./sessions');
const tlsUtil = require('./tls');
const { lanLinks } = require('./lan');

const info = state.loadDaemonInfo();
const PORT = Number(process.env.AIOC_DAEMON_PORT || info.port);
const HOST = process.env.AIOC_DAEMON_HOST || info.host;
info.lanPort = Number(process.env.AIOC_LAN_PORT || info.lanPort || 43443);
info.lan = !!info.lan;
const startedAt = Date.now();

const UI_DIR = path.join(__dirname, '..', 'ui');
const NM = path.join(__dirname, '..', 'node_modules');
const VENDOR = {
  '/vendor/xterm.css': [path.join(NM, '@xterm/xterm/css/xterm.css'), 'text/css'],
  '/vendor/xterm.js': [path.join(NM, '@xterm/xterm/lib/xterm.js'), 'text/javascript'],
  '/vendor/addon-fit.js': [path.join(NM, '@xterm/addon-fit/lib/addon-fit.js'), 'text/javascript'],
  '/vendor/addon-webgl.js': [path.join(NM, '@xterm/addon-webgl/lib/addon-webgl.js'), 'text/javascript'],
  '/vendor/addon-search.js': [path.join(NM, '@xterm/addon-search/lib/addon-search.js'), 'text/javascript'],
  '/vendor/addon-web-links.js': [path.join(NM, '@xterm/addon-web-links/lib/addon-web-links.js'), 'text/javascript'],
  '/vendor/addon-unicode11.js': [path.join(NM, '@xterm/addon-unicode11/lib/addon-unicode11.js'), 'text/javascript'],
};
const STATIC = {
  '/': [path.join(UI_DIR, 'index.html'), 'text/html; charset=utf-8'],
  '/app.js': [path.join(UI_DIR, 'app.js'), 'text/javascript'],
  '/style.css': [path.join(UI_DIR, 'style.css'), 'text/css'],
  '/manifest.webmanifest': [path.join(UI_DIR, 'manifest.webmanifest'), 'application/manifest+json'],
  '/icon.svg': [path.join(UI_DIR, 'icon.svg'), 'image/svg+xml'],
};

const wss = new WebSocketServer({ noServer: true });
let lanServer = null;
let lanFp = null;

// ---- Hintergrundbild (liegt beim Daemon, damit auch ferne Fenster es sehen) -----------------
const BG_EXTS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const BG_TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
function backgroundFile() {
  for (const ext of Object.keys(BG_TYPES)) {
    const f = path.join(state.DIR, 'background.' + ext);
    if (fs.existsSync(f)) return f;
  }
  return null;
}
function backgroundState() {
  const f = backgroundFile();
  const ui = state.loadUiState();
  let v = 0;
  try { v = f ? Math.floor(fs.statSync(f).mtimeMs) : 0; } catch {}
  return { url: f ? `/background?v=${v}` : null, opacity: typeof ui.backgroundOpacity === 'number' ? ui.backgroundOpacity : 0.35 };
}
function setBackground(buf, mime) {
  const ext = BG_EXTS[mime];
  if (!ext) throw new Error('Bildformat nicht unterstützt: ' + mime);
  clearBackground();
  fs.writeFileSync(path.join(state.DIR, 'background.' + ext), buf);
}
function clearBackground() {
  for (const ext of Object.keys(BG_TYPES)) { try { fs.unlinkSync(path.join(state.DIR, 'background.' + ext)); } catch {} }
}
function setBackgroundOpacity(v) {
  const ui = state.loadUiState();
  ui.backgroundOpacity = Math.min(1, Math.max(0.05, Number(v) || 0.35));
  state.saveUiState(ui);
}

const mgr = new SessionManager(PORT, {
  onData: (id, d) => {
    for (const ws of wss.clients) if (ws.attached?.has(id)) send(ws, { t: 'data', id, d });
  },
  onChange: () => broadcastSessions(),
  onGone: id => { for (const ws of wss.clients) send(ws, { t: 'gone', id }); },
});
mgr.adoptSaved();

function send(ws, obj) { if (ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch {} } }

// ---- Groesse je Session = kleinster aktueller Betrachter (tmux-Prinzip) --------------------
// Jeder Client meldet fuer angezeigte Sessions seine Groesse; verlaesst er die Session (detach,
// Verbindungsende), faellt seine Begrenzung sofort weg.
function viewerLabel(req) {
  const ua = req.headers['user-agent'] || '';
  const kind = /Mobile|Android|iPhone|iPad/i.test(ua) ? 'Handy' : /Electron/i.test(ua) ? 'Fenster' : 'Browser';
  return req.socket.encrypted ? `${kind} (LAN)` : kind;
}

function recomputeSize(id) {
  const s = mgr.sessions.get(id);
  if (!s) return;
  const viewers = [];
  for (const ws of wss.clients) {
    const sz = ws.attached?.has(id) && ws.sizes?.get(id);
    if (sz) viewers.push({ ...sz, label: ws.label });
  }
  const before = JSON.stringify(s.entry.sizeInfo || null);
  if (!viewers.length) {
    s.entry.sizeInfo = null;
  } else {
    const cols = Math.min(...viewers.map(v => v.cols));
    const rows = Math.min(...viewers.map(v => v.rows));
    const smallest = viewers.find(v => v.cols === cols || v.rows === rows);
    const limited = viewers.some(v => v.cols > cols || v.rows > rows);
    s.resize(cols, rows);
    s.entry.sizeInfo = { cols, rows, viewers: viewers.length, limitedBy: limited ? `${smallest.label} ${smallest.cols}×${smallest.rows}` : null };
  }
  if (JSON.stringify(s.entry.sizeInfo || null) !== before) broadcastSessions();
}

let lanQr = null; // SVG-QR-Code des ersten Verbindungslinks (fuers Handy)
function lanState() {
  return { enabled: !!lanServer, port: info.lanPort, fp: lanFp, links: lanServer ? lanLinks(info, lanFp) : [], qr: lanServer ? lanQr : null };
}

function stateMsg(t) {
  return { t, sessions: mgr.toClient(), feed: mgr.feed, recents: state.loadUiState().recents || [], lan: lanState(), background: backgroundState() };
}

function broadcastSessions() {
  const msg = stateMsg('sessions');
  for (const ws of wss.clients) send(ws, msg);
}

function persistInfo() {
  state.saveDaemonInfo({ ...info, port: PORT, host: HOST, pid: process.pid, startedAt });
}

function isLoopback(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function handleRequest(req, res) {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'POST' && url.pathname === '/event') {
    if (!isLoopback(req)) { res.writeHead(403); res.end(); return; }
    let body = '';
    req.on('data', c => { if (body.length < 1024 * 1024) body += c; });
    req.on('end', () => {
      try { mgr.handleHookEvent(JSON.parse(body)); } catch {}
      res.writeHead(204); res.end();
    });
    return;
  }
  // PWA-Manifest: mit gueltigem Token bekommt start_url das Token mit (iOS-Homescreen-Apps teilen
  // keinen localStorage mit Safari, sonst stuende die installierte App ohne Zugang da)
  if (url.pathname === '/manifest.webmanifest' && req.method === 'GET' && url.searchParams.get('token') === info.token) {
    fs.readFile(STATIC['/manifest.webmanifest'][0], 'utf8', (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      let m; try { m = JSON.parse(data); } catch { m = {}; }
      m.start_url = `/?token=${encodeURIComponent(info.token)}`;
      res.writeHead(200, { 'content-type': 'application/manifest+json', 'cache-control': 'no-cache' });
      res.end(JSON.stringify(m));
    });
    return;
  }
  if (url.pathname === '/background' && req.method === 'GET') {
    const f = backgroundFile();
    if (!f) { res.writeHead(404); res.end(); return; }
    fs.readFile(f, (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': BG_TYPES[path.extname(f).slice(1)] || 'application/octet-stream', 'cache-control': 'private, max-age=86400' });
      res.end(data);
    });
    return;
  }
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, name: 'aioc', pid: process.pid, sessions: mgr.sessions.size, lan: !!lanServer }));
    return;
  }
  const entry = STATIC[url.pathname] || VENDOR[url.pathname];
  if (entry && req.method === 'GET') {
    fs.readFile(entry[0], (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': entry[1], 'cache-control': 'no-cache' });
      res.end(data);
    });
    return;
  }
  res.writeHead(404); res.end('not found');
}

function handleUpgrade(req, socket, head) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws' || url.searchParams.get('token') !== info.token) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return;
  }
  wss.handleUpgrade(req, socket, head, ws => {
    ws.viaLan = !!req.socket.encrypted;
    ws.label = viewerLabel(req);
    console.log(`[aioc] Client ${req.socket.remoteAddress} ${ws.viaLan ? 'TLS' : 'lokal'} · ${ws.label} · ${(req.headers['user-agent'] || '').slice(0, 60)}`);
    wss.emit('connection', ws, req);
  });
}

wss.on('connection', ws => {
  ws.attached = new Set();
  ws.sizes = new Map();
  ws.on('close', () => {
    const ids = [...ws.attached];
    ws.attached.clear(); ws.sizes.clear();
    for (const id of ids) recomputeSize(id);
  });
  send(ws, stateMsg('hello'));
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const s = m.id ? mgr.sessions.get(m.id) : null;
    try {
      switch (m.t) {
        case 'attach':
          if (!s) break;
          ws.attached.add(m.id);
          send(ws, { t: 'snapshot', id: m.id, data: s.snapshot(), running: !!s.proc });
          break;
        case 'detach': ws.attached.delete(m.id); ws.sizes.delete(m.id); recomputeSize(m.id); break;
        case 'input': if (s) s.write(m.d); break;
        case 'image':
          if (s && typeof m.data === 'string' && m.data.length <= 40 * 1024 * 1024) s.pasteImage(Buffer.from(m.data, 'base64'), m.mime);
          break;
        case 'resize':
          if (s && m.cols > 1 && m.rows > 1) { ws.attached.add(m.id); ws.sizes.set(m.id, { cols: m.cols, rows: m.rows }); recomputeSize(m.id); }
          break;
        case 'create': mgr.create({ agent: m.agent, cwd: m.cwd, name: m.name, args: m.args, cols: m.cols, rows: m.rows }); break;
        case 'restore': mgr.restore(m.id, m.cols, m.rows); break;
        case 'restoreAll': mgr.restoreAll(m.cols, m.rows); break;
        case 'close': mgr.close(m.id); break;
        case 'dispose': mgr.dispose(m.id); break;
        case 'rename': mgr.rename(m.id, m.name); break;
        case 'markRead': mgr.markRead(m.id); break;
        case 'lan':
          if (m.enabled) startLan().catch(err => { mgr.pushFeed('LAN-Zugriff konnte nicht gestartet werden: ' + err.message); broadcastSessions(); });
          else stopLan();
          break;
        case 'background':
          if (typeof m.data === 'string' && m.data.length <= 30 * 1024 * 1024) { setBackground(Buffer.from(m.data, 'base64'), m.mime); broadcastSessions(); }
          break;
        case 'backgroundOpacity': setBackgroundOpacity(m.value); broadcastSessions(); break;
        case 'backgroundClear': clearBackground(); broadcastSessions(); break;
        default: break;
      }
    } catch (err) {
      send(ws, { t: 'error', message: err.message });
    }
  });
});

// ---- LAN: zweiter Listener mit HTTPS/WSS auf 0.0.0.0:lanPort ----------------------------------
async function startLan() {
  if (lanServer) return;
  const { key, cert, fp } = await tlsUtil.ensureCert();
  const server = https.createServer({ key, cert }, handleRequest);
  server.on('upgrade', handleUpgrade);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(info.lanPort, '0.0.0.0', resolve);
  });
  lanServer = server;
  lanFp = fp;
  info.lan = true;
  persistInfo();
  try {
    const first = lanLinks(info, fp)[0];
    lanQr = first ? await require('qrcode').toString(first, { type: 'svg', margin: 1, color: { dark: '#000000', light: '#ffffff' } }) : null;
  } catch { lanQr = null; }
  mgr.pushFeed(`LAN-Zugriff EIN · HTTPS-Port ${info.lanPort} · Firewall muss node.exe eingehend erlauben`);
  console.log(`[aioc] LAN-Listener auf https://0.0.0.0:${info.lanPort} (Fingerprint ${fp})`);
  broadcastSessions();
}

function stopLan() {
  if (!lanServer) return;
  for (const ws of wss.clients) if (ws.viaLan) { try { ws.close(); } catch {} }
  lanServer.close();
  lanServer = null;
  lanFp = null;
  info.lan = false;
  persistInfo();
  mgr.pushFeed('LAN-Zugriff AUS');
  console.log('[aioc] LAN-Listener gestoppt');
  broadcastSessions();
}

const server = http.createServer(handleRequest);
server.on('upgrade', handleUpgrade);
server.listen(PORT, HOST, () => {
  persistInfo();
  console.log(`[aioc] Daemon läuft auf http://${HOST}:${PORT} (PID ${process.pid})`);
  if (info.lan) startLan().catch(err => console.error('[aioc] LAN-Start fehlgeschlagen:', err.message));
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try { mgr.saveAllNow(); } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);
setInterval(() => { try { mgr.saveAllNow(); } catch {} }, 30000).unref();
