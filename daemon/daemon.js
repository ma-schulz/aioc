// Aioc daemon: owns all sessions, serves the web UI, accepts hook reports on /event and
// speaks the client protocol over WebSocket. The UI (Electron or browser) is just a client —
// closing it never touches the sessions.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const state = require('./state');
const { SessionManager } = require('./sessions');

const info = state.loadDaemonInfo();
const PORT = Number(process.env.AIOC_DAEMON_PORT || info.port);
const HOST = process.env.AIOC_DAEMON_HOST || info.host;

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
};

const wss = new WebSocketServer({ noServer: true });

const mgr = new SessionManager(PORT, {
  onData: (id, d) => {
    for (const ws of wss.clients) if (ws.attached?.has(id)) send(ws, { t: 'data', id, d });
  },
  onChange: () => broadcastSessions(),
  onGone: id => { for (const ws of wss.clients) send(ws, { t: 'gone', id }); },
});
mgr.adoptSaved();

function send(ws, obj) { if (ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch {} } }

function broadcastSessions() {
  const msg = { t: 'sessions', sessions: mgr.toClient(), feed: mgr.feed, recents: state.loadUiState().recents || [] };
  for (const ws of wss.clients) send(ws, msg);
}

function isLoopback(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

const server = http.createServer((req, res) => {
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
    res.end(JSON.stringify({ ok: true, name: 'aioc', pid: process.pid, sessions: mgr.sessions.size }));
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
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws' || url.searchParams.get('token') !== info.token) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return;
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

wss.on('connection', ws => {
  ws.attached = new Set();
  send(ws, { t: 'hello', sessions: mgr.toClient(), feed: mgr.feed, recents: state.loadUiState().recents || [] });
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
        case 'create': mgr.create({ agent: m.agent, cwd: m.cwd, name: m.name, args: m.args }); break;
        case 'restore': mgr.restore(m.id); break;
        case 'restoreAll': mgr.restoreAll(); break;
        case 'close': mgr.close(m.id); break;
        case 'dispose': mgr.dispose(m.id); break;
        case 'rename': mgr.rename(m.id, m.name); break;
        case 'markRead': mgr.markRead(m.id); break;
        default: break;
      }
    } catch (err) {
      send(ws, { t: 'error', message: err.message });
    }
  });
});

server.listen(PORT, HOST, () => {
  state.saveDaemonInfo({ ...info, port: PORT, host: HOST, pid: process.pid, startedAt: Date.now() });
  console.log(`[aioc] Daemon läuft auf http://${HOST}:${PORT} (PID ${process.pid})`);
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
