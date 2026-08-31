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

const mgr = new SessionManager(PORT, {
  onData: (id, d) => {
    for (const ws of wss.clients) if (ws.attached?.has(id)) send(ws, { t: 'data', id, d });
  },
  onChange: () => broadcastSessions(),
  onGone: id => { for (const ws of wss.clients) send(ws, { t: 'gone', id }); },
});
mgr.adoptSaved();

function send(ws, obj) { if (ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch {} } }

function lanState() {
  return { enabled: !!lanServer, port: info.lanPort, fp: lanFp, links: lanServer ? lanLinks(info, lanFp) : [] };
}

function stateMsg(t) {
  return { t, sessions: mgr.toClient(), feed: mgr.feed, recents: state.loadUiState().recents || [], lan: lanState() };
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
    console.log(`[aioc] Client ${req.socket.remoteAddress} ${ws.viaLan ? 'TLS' : 'lokal'} · ${(req.headers['user-agent'] || '').slice(0, 70)}`);
    wss.emit('connection', ws, req);
  });
}

wss.on('connection', ws => {
  ws.attached = new Set();
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
        case 'detach': ws.attached.delete(m.id); break;
        case 'input': if (s) s.write(m.d); break;
        case 'image':
          if (s && typeof m.data === 'string' && m.data.length <= 40 * 1024 * 1024) s.pasteImage(Buffer.from(m.data, 'base64'), m.mime);
          break;
        case 'resize': if (s) s.resize(m.cols, m.rows); break;
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
