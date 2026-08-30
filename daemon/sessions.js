// Aioc session manager: owns the PTYs (ConPTY via node-pty), a headless terminal per session
// for scrollback/serialization, and the status engine (hook events + terminal title + heuristics).
const crypto = require('crypto');
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const state = require('./state');
const agents = require('./agents');

const OSC_TITLE = /\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

class Session {
  constructor(mgr, entry) {
    this.mgr = mgr;
    this.entry = entry;
    this.proc = null;
    this.term = null;
    this.serializer = null;
    this.titleBuf = '';
    this.cols = 120;
    this.rows = 32;
    this.saveTimer = null;
    this.heurTimer = null;
    this.pendingRestoredBanner = false;
  }

  ensureTerm() {
    if (this.term) return;
    this.term = new Terminal({ cols: this.cols, rows: this.rows, scrollback: 8000, allowProposedApi: true });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer);
  }

  spawn({ resume = false } = {}) {
    if (this.proc) return;
    this.ensureTerm();
    if (resume) {
      const old = state.loadScrollback(this.entry.id);
      if (old) {
        this.term.write(old);
        this.term.write(`\r\n\x1b[90m── Aioc: wiederhergestellt ${new Date().toLocaleString('de-DE')} ──\x1b[0m\r\n`);
        this.pendingRestoredBanner = true;
      }
    }
    const spec = agents.buildSpawn(this.entry, this.mgr.port, { resume });
    try {
      this.proc = pty.spawn(spec.file, spec.args, {
        name: 'xterm-256color', cols: this.cols, rows: this.rows,
        cwd: this.entry.cwd, env: spec.env, useConpty: true,
      });
    } catch (err) {
      this.setStatus('exited', 'Start fehlgeschlagen: ' + err.message, 'system');
      return;
    }
    this.entry.exitedAt = null;
    this.setStatus('starting', 'startet…', 'system');
    this.proc.onData(d => this.onData(d));
    this.proc.onExit(e => this.onExit(e));
  }

  onData(d) {
    this.ensureTerm();
    this.term.write(d);
    this.mgr.emitData(this.entry.id, d);
    this.parseTitles(d);
    this.scheduleSave();
    if (this.entry.agent === 'pwsh') this.heuristic();
  }

  parseTitles(chunk) {
    this.titleBuf = (this.titleBuf + chunk).slice(-4096);
    let m, last = null;
    OSC_TITLE.lastIndex = 0;
    while ((m = OSC_TITLE.exec(this.titleBuf))) last = m[1];
    if (last === null || last === this.entry.title) return;
    this.entry.title = last;
    // Codex signals approval/input overlays only via the terminal title ("Action Required").
    if (this.entry.agent === 'codex') {
      if (/Action Required/i.test(last)) this.setStatus('waiting', 'Freigabe/Eingabe im Overlay', 'title');
      else if (this.entry.statusSource === 'title' && this.entry.status === 'waiting') this.setStatus('running', 'arbeitet', 'title');
      else this.mgr.persistAndBroadcast();
    } else {
      this.mgr.persistAndBroadcast();
    }
  }

  heuristic() {
    if (this.entry.status !== 'running') this.setStatus('running', 'Ausgabe läuft', 'heur');
    clearTimeout(this.heurTimer);
    this.heurTimer = setTimeout(() => {
      if (this.proc && this.entry.status === 'running' && this.entry.statusSource === 'heur') {
        this.setStatus('idle', 'bereit', 'heur');
      }
    }, 3000);
  }

  onExit(e) {
    this.proc = null;
    clearTimeout(this.heurTimer);
    this.entry.exitedAt = Date.now();
    this.setStatus('exited', `Prozess beendet (Exit ${e.exitCode})`, 'system');
    this.mgr.emitData(this.entry.id, `\r\n\x1b[90mProzess beendet (Exit ${e.exitCode}) · Scrollback bleibt erhalten\x1b[0m\r\n`);
    this.saveNow();
  }

  // ---- status engine: hook events are authoritative -------------------------------------
  handleHook(payload) {
    const ev = payload.hook_event_name || '';
    const sid = payload.session_id;
    if (sid && typeof sid === 'string') this.entry.agentSessionId = sid;
    switch (ev) {
      case 'SessionStart':
        if (this.entry.status === 'starting') this.setStatus('idle', 'bereit', 'hook');
        else this.mgr.persistAndBroadcast();
        break;
      case 'UserPromptSubmit':
        this.entry.unread = false;
        this.setStatus('running', 'arbeitet', 'hook');
        break;
      case 'PreToolUse':
        if (payload.tool_name === 'AskUserQuestion') {
          const q = payload.tool_input?.questions?.[0]?.question;
          this.setStatus('waiting', q ? `Rückfrage: ${q}` : 'Rückfrage', 'hook');
        }
        break;
      case 'PostToolUse':
        if (payload.tool_name === 'AskUserQuestion') this.setStatus('running', 'arbeitet', 'hook');
        break;
      case 'PermissionRequest': {
        const t = payload.tool_name || payload.prompt || '';
        this.setStatus('waiting', t ? `Freigabe: ${t}` : 'Freigabe angefragt', 'hook');
        break;
      }
      case 'Notification': {
        if (this.entry.status === 'done' || this.entry.status === 'exited') break;
        const msg = payload.message || 'wartet auf dich';
        if (/waiting for your input/i.test(msg) && this.entry.status !== 'running') break;
        this.setStatus('waiting', msg, 'hook');
        break;
      }
      case 'Stop': {
        let detail = 'fertig';
        const last = payload.last_assistant_message;
        if (typeof last === 'string' && last.trim()) detail = 'fertig: ' + last.trim().split('\n')[0].slice(0, 100);
        this.entry.unread = true;
        this.setStatus('done', detail, 'hook');
        break;
      }
      case 'SessionEnd':
        this.mgr.persistAndBroadcast();
        break;
      default:
        break;
    }
  }

  setStatus(status, detail, source) {
    const changed = this.entry.status !== status || this.entry.detail !== detail;
    this.entry.status = status;
    this.entry.detail = detail;
    this.entry.statusSource = source;
    if (changed && (status === 'waiting' || status === 'done' || status === 'exited')) {
      this.mgr.pushFeed(`${this.entry.name} · ${detail}`);
    }
    this.mgr.persistAndBroadcast();
  }

  // ---- io -------------------------------------------------------------------------------
  write(d) { if (this.proc) this.proc.write(d); }

  resize(cols, rows) {
    if (!cols || !rows || cols < 2 || rows < 2) return;
    this.cols = cols; this.rows = rows;
    try { if (this.term) this.term.resize(cols, rows); } catch {}
    try { if (this.proc) this.proc.resize(cols, rows); } catch {}
  }

  snapshot() {
    if (this.term && this.serializer) {
      try { return this.serializer.serialize({ scrollback: 8000 }); } catch { return ''; }
    }
    return state.loadScrollback(this.entry.id);
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.saveNow(); }, 3000);
  }

  saveNow() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (this.term) state.saveScrollback(this.entry.id, this.snapshot());
  }

  kill() { if (this.proc) { try { this.proc.kill(); } catch {} } }

  disposeFiles() { state.deleteScrollback(this.entry.id); }
}

class SessionManager {
  constructor(port, { onData, onChange, onGone }) {
    this.port = port;
    this.sessions = new Map();
    this.feed = [];
    this.onData = onData;
    this.onChange = onChange;
    this.onGone = onGone;
  }

  adoptSaved() {
    for (const entry of state.loadSessions()) {
      if (!entry.id) continue;
      if (entry.status !== 'exited') {
        entry.status = 'exited';
        entry.detail = 'vor Neustart · wiederherstellbar';
      }
      entry.unread = false;
      this.sessions.set(entry.id, new Session(this, entry));
    }
  }

  create({ agent, cwd, name, args }) {
    if (!agents.AGENTS.includes(agent)) throw new Error('Unbekannter Agent: ' + agent);
    const id = crypto.randomBytes(5).toString('hex');
    const entry = {
      id, agent, cwd, args: args || '',
      name: name || `${agent} · ${cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop()}`,
      createdAt: Date.now(), status: 'starting', detail: 'startet…', statusSource: 'system',
      unread: false, title: '', agentSessionId: null, exitedAt: null,
    };
    const s = new Session(this, entry);
    this.sessions.set(id, s);
    state.rememberRecent(cwd);
    s.spawn();
    this.pushFeed(`${entry.name} · gestartet`);
    this.persistAndBroadcast();
    return s;
  }

  restore(id) {
    const s = this.sessions.get(id);
    if (!s || s.proc) return;
    s.spawn({ resume: true });
    this.pushFeed(`${s.entry.name} · wiederhergestellt`);
    this.persistAndBroadcast();
  }

  restoreAll() {
    for (const s of this.sessions.values()) if (!s.proc && s.entry.status === 'exited') this.restore(s.entry.id);
  }

  close(id) { this.sessions.get(id)?.kill(); }

  dispose(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.kill();
    s.disposeFiles();
    this.sessions.delete(id);
    this.persistAndBroadcast();
    if (this.onGone) this.onGone(id);
  }

  rename(id, name) {
    const s = this.sessions.get(id);
    if (s && name) { s.entry.name = String(name).slice(0, 80); this.persistAndBroadcast(); }
  }

  markRead(id) {
    const s = this.sessions.get(id);
    if (s && s.entry.unread) { s.entry.unread = false; this.persistAndBroadcast(); }
  }

  handleHookEvent(body) {
    const s = this.sessions.get(body.session);
    if (s) s.handleHook(body.payload || {});
  }

  emitData(id, d) { if (this.onData) this.onData(id, d); }

  pushFeed(text) {
    this.feed.unshift({ t: Date.now(), text: String(text).slice(0, 160) });
    this.feed = this.feed.slice(0, 30);
  }

  persistAndBroadcast() {
    state.saveSessionsDebounced(this.toPersist());
    if (this.onChange) this.onChange();
  }

  toPersist() { return [...this.sessions.values()].map(s => s.entry); }

  toClient() {
    return [...this.sessions.values()]
      .map(s => ({ ...s.entry, running: !!s.proc }))
      .sort((a, b) => a.cwd.toLowerCase().localeCompare(b.cwd.toLowerCase()) || a.createdAt - b.createdAt);
  }

  saveAllNow() {
    for (const s of this.sessions.values()) { try { s.saveNow(); } catch {} }
    state.saveSessionsNow(this.toPersist());
  }
}

module.exports = { SessionManager };
