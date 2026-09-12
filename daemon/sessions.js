// Aioc session manager: owns the PTYs (ConPTY via node-pty), a headless terminal per session
// for scrollback/serialization, and the status engine (hook events + terminal title + heuristics).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const state = require('./state');
const agents = require('./agents');
const claudeMeta = require('./claude-meta');

const OSC_TITLE = /\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
// Taste, mit der der Agent ein Bild aus der System-Zwischenablage holt (verifiziert 31.08.2026)
const IMAGE_KEY = { claude: '\x1bv', codex: '\x16', pi: '\x16' };
const CLIP_SCRIPT = path.join(__dirname, 'set-clipboard-image.ps1');
// Tasten fuer die Steuer-API (aioc-ctl key)
const KEYS = {
  enter: '\r', esc: '\x1b', escape: '\x1b', tab: '\t', 'shift+tab': '\x1b[Z', space: ' ', backspace: '\x7f',
  up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D',
  home: '\x1b[H', end: '\x1b[F', pgup: '\x1b[5~', pgdn: '\x1b[6~', delete: '\x1b[3~',
};
// Umbenennen zurueck in den Agenten schreiben: Claude Code und Codex koennen das per Slash-Befehl
const RENAME_COMMAND = { claude: '/rename', codex: '/rename' };
const apiError = (status, message) => Object.assign(new Error(message), { status });
// Ein Checkpoint (Puffer serialisieren) kostet gemessen ~80 ms und blockiert dabei den Hauptthread,
// also alles andere - auch die Tastatureingaben. Deshalb nur selten: wenn seit dem letzten Checkpoint
// so viel Rohausgabe im Journal steht, sonst nach dieser Zeit, ausserdem beim Beenden.
const CHECKPOINT_BYTES = 2 * 1024 * 1024;
const CHECKPOINT_MS = 5 * 60 * 1000;

// Tastenname -> Sequenz; Pfeile im Application-Cursor-Modus (DECCKM) als ESC O x
function keySequence(name, appCursor) {
  const k = String(name).toLowerCase();
  if (KEYS[k] !== undefined) return appCursor && /^(up|down|right|left)$/.test(k) ? '\x1bO' + KEYS[k].slice(2) : KEYS[k];
  const ctrl = k.match(/^ctrl\+([a-z])$/);
  if (ctrl) return String.fromCharCode(ctrl[1].charCodeAt(0) - 96);
  if ([...String(name)].length === 1) return String(name);
  return null;
}

// Puffer eines (headless) Terminals als Text ohne Farben/Steuersequenzen: umgebrochene Zeilen
// werden wieder zusammengesetzt, Leerzeilen am Ende entfallen. lines = 0: alles.
function bufferText(term, lines) {
  const buf = term.buffer.active;
  const out = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (!line) continue;
    const text = line.translateToString(!buf.getLine(i + 1)?.isWrapped);
    if (line.isWrapped && out.length) out[out.length - 1] += text;
    else out.push(text);
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return (lines > 0 ? out.slice(-lines) : out).join('\n');
}

// Spinner- und Statuszeichen am Anfang des Terminaltitels (Claude: "✳ Name", "◐ Name"; Codex: "[ ! ] …")
const TITLE_PREFIX = /^(?:[\s*·•…⏺✳✻✽◐◑◒◓◜◝◞◟⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|\[\s*!\s*\])+/u;
// Titel, die keinen Sessionnamen tragen, sondern nur das Programm oder einen Hinweis nennen
const TITLE_GENERIC = [/^claude( code)?$/i, /^codex$/i, /^pi$/i, /^action required$/i, /^pwsh(\.exe)?$/i, /^powershell$/i];

const folderOf = cwd => String(cwd || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
const defaultName = entry => `${entry.agent} · ${folderOf(entry.cwd)}`;

// Namensvorschlag aus dem Terminaltitel: Claude schreibt dort seinen Sessionnamen - nach /rename den
// von dir gesetzten, sonst seinen selbst erzeugten Titel. Codex schreibt nur den Ordner, pwsh einen
// Pfad; beides taugt nicht als Name.
function nameFromTitle(entry) {
  if (entry.agent === 'pwsh') return null;
  let raw = String(entry.title || '').replace(TITLE_PREFIX, '').trim();
  // Codex haengt den Ordner an: "Codex-Blau | aioc" (ohne eigenen Namen steht dort nur "aioc")
  if (entry.agent === 'codex') raw = raw.split('|')[0].trim();
  if (!raw || raw.length > 80) return null;
  if (TITLE_GENERIC.some(re => re.test(raw))) return null;
  if (/[\\/]|^[A-Za-z]:/.test(raw)) return null;
  if (raw.toLowerCase() === folderOf(entry.cwd).toLowerCase()) return null;
  return raw;
}

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
    this.lastAnswer = null; // letzte Agenten-Antwort aus dem Stop-Hook (aioc-ctl read --answer)
    this.pendingTurn = null; // 'run' | 'change': Eingabe per API, Reaktion des Agenten steht noch aus
    this.lastTitleName = null; // zuletzt aus dem Titel gelesener Name (Spinner-Wechsel ignorieren)
    this.nameRetryTimer = null;
    this.pendingNameWrite = null; // F2-Name, der noch in den Agenten getippt werden muss
    this.nameWriteTimer = null;
    this.spawnedAt = 0;
    this.pendingTimer = null;
    this.journalBytes = 0; // Rohausgabe seit dem letzten Checkpoint
    this.checkpointAt = 0;
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
        // Neuere ConPTY-DLL aus node-pty statt der System-ConPTY: die System-Variante zerlegt
        // SGR-Maus-Sequenzen unter win32-input-mode (?9001h, von Claude aktiviert) in
        // zeichenweise Tastatur-Records - Mausrad-Scrollen kommt dann nie als Maus an.
        useConptyDll: true,
      });
    } catch (err) {
      this.setStatus('exited', 'Start fehlgeschlagen: ' + err.message, 'system');
      return;
    }
    this.entry.exitedAt = null;
    this.spawnedAt = Date.now();
    this.setStatus('starting', 'startet…', 'system');
    this.proc.onData(d => this.onData(d));
    this.proc.onExit(e => this.onExit(e));
  }

  onData(d) {
    this.ensureTerm();
    this.term.write(d);
    this.mgr.emitData(this.entry.id, d);
    this.parseTitles(d);
    this.journalBytes += state.appendScrollback(this.entry.id, d); // anhaengen statt serialisieren
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
    this.syncName();
    // Codex signals approval/input overlays only via the terminal title ("Action Required").
    if (this.entry.agent === 'codex') {
      if (/Action Required/i.test(last)) this.setStatus('waiting', 'Freigabe/Eingabe im Overlay', 'title');
      else if (this.entry.statusSource === 'title' && this.entry.status === 'waiting') this.setStatus('running', 'arbeitet', 'title');
      else this.mgr.persistAndBroadcast();
    } else {
      this.mgr.persistAndBroadcast();
    }
  }

  // Namen dem Agenten nachziehen. Ein in Aioc vergebener Name bleibt stehen - nur ein neuerer, im
  // Agenten selbst gesetzter Name setzt sich darueber hinweg (Claude-Registry: nameSource 'user',
  // gegen 'derived' fuer Claudes eigene Zusammenfassung).
  syncName() {
    const cand = nameFromTitle(this.entry);
    if (!cand || cand === this.lastTitleName) return; // reiner Spinner-Wechsel: Text unveraendert
    this.lastTitleName = cand;
    clearTimeout(this.nameRetryTimer);
    this.applyName(cand, 2);
  }

  // Claude schreibt Titel und Registry nicht im selben Moment (gemessen: Registry ~ms spaeter).
  // Deshalb wird kurz nachgefasst - sonst bliebe ein /rename gegenueber einem in Aioc vergebenen
  // Namen liegen, und ein uebernommener Name behielte faelschlich die Einstufung "automatisch".
  applyName(cand, retries) {
    if (nameFromTitle(this.entry) !== cand) return; // Titel ist inzwischen weitergezogen
    const meta = this.entry.agent === 'claude' ? claudeMeta.lookup(this.entry.agentSessionId, { fresh: retries < 2 }) : null;
    // Codex schreibt nur dann einen Namen in den Titel, wenn die Unterhaltung umbenannt wurde (sonst
    // steht dort der Ordner) - dort ist jeder Titelname also von dir. Bei Claude beweist das die Registry.
    const since = this.entry.agent === 'codex' ? Date.now()
      : meta && meta.nameSource === 'user' && meta.name === cand ? meta.nameSince : null;
    const byUser = since !== null;
    const retry = () => {
      if (retries > 0) this.nameRetryTimer = setTimeout(() => this.applyName(cand, retries - 1), 1500);
    };
    if (this.entry.nameSource === 'user' && !(byUser && since > (this.entry.nameAt || 0))) { retry(); return; }
    if (this.entry.name !== cand) {
      const before = this.entry.name;
      this.entry.name = cand;
      this.mgr.pushFeed(`${before} · heißt jetzt „${cand}"`);
    }
    this.entry.nameSource = byUser ? 'user' : 'auto';
    this.entry.nameAt = byUser ? since : 0;
    this.mgr.persistAndBroadcast();
    if (!byUser) retry(); // die Registry kann den /rename noch nachreichen
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
    this.pendingNameWrite = null;
    clearTimeout(this.nameWriteTimer);
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
        this.lastAnswer = null;
        this.setStatus('running', 'arbeitet', 'hook');
        break;
      case 'PreToolUse':
        if (payload.tool_name === 'AskUserQuestion') {
          const qs = payload.tool_input?.questions || [];
          const q = qs[0]?.question;
          const prefix = qs.length > 1 ? `Rückfragen (${qs.length})` : 'Rückfrage';
          this.setStatus('waiting', q ? `${prefix}: ${q}` : prefix, 'hook');
        }
        break;
      case 'Elicitation':
        this.setStatus('waiting', 'Eingabe angefragt (MCP)', 'hook');
        break;
      case 'PostToolUse':
        if (payload.tool_name === 'AskUserQuestion') this.setStatus('running', 'arbeitet', 'hook');
        break;
      case 'PermissionRequest': {
        const tool = payload.tool_name || '';
        if (tool === 'AskUserQuestion') {
          // Folgt direkt auf PreToolUse: dieselbe Rückfrage, keine Freigabe
          if (this.entry.status === 'waiting') break;
          const q = payload.tool_input?.questions?.[0]?.question;
          this.setStatus('waiting', q ? `Rückfrage: ${q}` : 'Rückfrage', 'hook');
          break;
        }
        const t = tool || payload.prompt || '';
        this.setStatus('waiting', t ? `Freigabe: ${t}` : 'Freigabe angefragt', 'hook');
        break;
      }
      case 'Notification': {
        // Kommt bei Rückfragen/Freigaben ~6 s NACH PreToolUse/PermissionRequest nochmal generisch
        // ("Claude needs your permission") - die spezifischere Meldung nie überschreiben.
        if (this.entry.status === 'done' || this.entry.status === 'exited' || this.entry.status === 'waiting') break;
        const type = payload.notification_type || '';
        const msg = payload.message || '';
        if (type === 'idle_prompt' || /waiting for your input/i.test(msg)) break;
        const detail = type === 'permission_prompt' || /permission/i.test(msg) ? 'Freigabe oder Rückfrage offen' : (msg || 'wartet auf dich');
        this.setStatus('waiting', detail, 'hook');
        break;
      }
      case 'Stop': {
        let detail = 'fertig';
        const last = payload.last_assistant_message;
        if (typeof last === 'string' && last.trim()) {
          detail = 'fertig: ' + last.trim().split('\n')[0].slice(0, 100);
          this.lastAnswer = last.slice(0, 200000);
        }
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
    // Laufende Nummer je Wechsel: `aioc-ctl wait` erkennt daran Wechsel NACH einem Prompt
    if (changed) this.entry.statusSeq = (this.entry.statusSeq || 0) + 1;
    if (this.pendingTurn && (status === 'running' || status === 'exited' || (changed && this.pendingTurn === 'change'))) {
      this.pendingTurn = null;
      clearTimeout(this.pendingTimer);
    }
    // Wartende F2-Umbenennung nachreichen, sobald die Session zur Ruhe gekommen ist
    if (this.pendingNameWrite && (status === 'idle' || status === 'done')) setTimeout(() => this.flushNameWrite(), 300);
    if (changed && (status === 'waiting' || status === 'done' || status === 'exited')) {
      this.mgr.pushFeed(`${this.entry.name} · ${detail}`);
    }
    this.mgr.persistAndBroadcast();
    if (changed) this.mgr.emitStatus(this.entry);
  }

  // ---- io -------------------------------------------------------------------------------
  write(d) { if (this.proc) this.proc.write(d); }

  // Text wie getippt ins Terminal: als Einfuegung, wenn der Agent Bracketed Paste aktiviert hat -
  // sonst wuerden Zeilenumbrueche vorzeitig absenden.
  typeText(text) {
    const t = String(text).replace(/\r\n?/g, '\n').replace(/\x1b\[20[01]~/g, '');
    if (t) this.write(this.term?.modes?.bracketedPasteMode ? `\x1b[200~${t}\x1b[201~` : t.replace(/\n/g, '\r'));
    return t;
  }

  // Enter getrennt und leicht verzoegert - zusammen mit dem Text wertet Claude Code beides als Einfuegung
  pressEnter(t = '') {
    setTimeout(() => this.write('\r'), t ? Math.min(1000, 150 + t.length / 20) : 0);
  }

  sendPrompt(text, { enter = true } = {}) {
    if (!this.proc) throw apiError(409, `${this.entry.name} läuft nicht (beendet oder vor Neustart)`);
    const t = this.typeText(text);
    if (!enter) return;
    this.pressEnter(t);
    this.markPending('run');
  }

  // Umbenennen in Aioc auch im Agenten setzen (Claude Code und Codex: `/rename <Name>`). Getippt
  // wird nur, wenn die Session gerade nichts tut - waehrend eines Turns oder bei offener Rueckfrage
  // landete die Zeile sonst als Nachricht oder im Dialog. Sonst wird sie nachgereicht (setStatus).
  renameInAgent(name) {
    if (!RENAME_COMMAND[this.entry.agent] || !this.proc) return;
    const line = String(name).replace(/[\r\n]+/g, ' ').trim().slice(0, 80);
    if (!line) return;
    this.pendingNameWrite = line;
    this.flushNameWrite();
  }

  flushNameWrite() {
    const line = this.pendingNameWrite;
    if (!line || !this.proc) return;
    const st = this.entry.status;
    if (st === 'running' || st === 'waiting') return; // erst nach dem Turn bzw. dem Dialog (setStatus reicht nach)
    // Codex meldet SessionStart erst beim ersten Prompt und steht bis dahin auf "startet…" - nach
    // kurzer Anlaufzeit des TUI trotzdem tippen, sonst kaeme die Umbenennung dort nie an
    if (st === 'starting' && Date.now() - (this.spawnedAt || 0) < 3000) {
      clearTimeout(this.nameWriteTimer);
      this.nameWriteTimer = setTimeout(() => this.flushNameWrite(), 2000);
      return;
    }
    this.pendingNameWrite = null;
    this.pressEnter(this.typeText(`${RENAME_COMMAND[this.entry.agent]} ${line}`));
  }

  // Nach Prompt/Tasten per API ist ein alter Status kein Ergebnis fuer `wait`, bis sich etwas tut.
  // 'run' (Prompt): bis der Agent arbeitet - Codex meldet beim ersten Prompt erst SessionStart
  // (-> bereit) und danach UserPromptSubmit. 'change' (Tasten): bis zum naechsten Statuswechsel,
  // z. B. Rueckfrage beantwortet. Tut sich nichts (Eingabe ging ins Leere), faellt die Sperre nach 15 s.
  markPending(mode) {
    this.pendingTurn = mode;
    clearTimeout(this.pendingTimer);
    this.pendingTimer = setTimeout(() => {
      if (!this.pendingTurn) return;
      this.pendingTurn = null;
      this.mgr.emitStatus(this.entry);
    }, 15000);
  }

  sendKeys(names) {
    if (!this.proc) throw apiError(409, `${this.entry.name} läuft nicht (beendet oder vor Neustart)`);
    const appCursor = !!this.term?.modes?.applicationCursorKeysMode;
    const seqs = names.map(n => {
      const s = keySequence(n, appCursor);
      if (s === null) throw apiError(400, `Unbekannte Taste „${n}"`);
      return s;
    });
    // Einzeln mit kurzem Abstand: ein ESC direkt vor der naechsten Taste laese die TUI sonst als Alt+Taste
    seqs.forEach((s, i) => setTimeout(() => this.write(s), i * 60));
    this.markPending('change');
  }

  // Terminalinhalt als Text fuer die Steuer-API; im Vollbild (Alternate Screen) der sichtbare Bildschirm
  async readText(lines = 60) {
    if (this.term) {
      await new Promise(r => this.term.write('', r)); // noch ausstehende Ausgabe erst verarbeiten
      return bufferText(this.term, lines);
    }
    const data = state.loadScrollback(this.entry.id);
    if (!data) return '';
    const tmp = new Terminal({ cols: this.cols, rows: this.rows, scrollback: 8000, allowProposedApi: true });
    try {
      await new Promise(r => tmp.write(data, r));
      return bufferText(tmp, lines);
    } finally {
      tmp.dispose();
    }
  }

  // Bild von einem (entfernten) Fenster: in die Zwischenablage DIESES Rechners legen und dem
  // Agenten seine Bild-Taste schicken - derselbe Weg wie beim lokalen Ctrl+V.
  pasteImage(buf, mime) {
    const key = IMAGE_KEY[this.entry.agent];
    if (!this.proc || !key) return;
    const file = path.join(state.DIR, 'clipboard-image' + (mime === 'image/jpeg' ? '.jpg' : '.png'));
    try { fs.writeFileSync(file, buf); } catch (err) { this.mgr.pushFeed(`${this.entry.name} · Bild konnte nicht gespeichert werden`); this.mgr.persistAndBroadcast(); return; }
    execFile('powershell.exe', ['-STA', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', CLIP_SCRIPT, file],
      { windowsHide: true, timeout: 20000 }, err => {
        if (err) {
          this.mgr.pushFeed(`${this.entry.name} · Bild-Einfügen fehlgeschlagen: ${err.message.split('\n')[0].slice(0, 80)}`);
          this.mgr.persistAndBroadcast();
          return;
        }
        this.write(key);
      });
  }

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

  // Ist das Journal gross geworden, sofort einen Checkpoint ziehen; sonst in Ruhe nach CHECKPOINT_MS
  scheduleSave() {
    if (this.journalBytes >= CHECKPOINT_BYTES) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.saveNow();
      return;
    }
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.saveNow(); }, CHECKPOINT_MS);
  }

  // Checkpoint: Puffer serialisieren, Journal leeren
  saveNow() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.term) return;
    if (!this.journalBytes && this.checkpointAt) return; // seither nichts passiert
    state.saveScrollback(this.entry.id, this.snapshot());
    this.journalBytes = 0;
    this.checkpointAt = Date.now();
  }

  kill() { if (this.proc) { try { this.proc.kill(); } catch {} } }

  disposeFiles() { state.deleteScrollback(this.entry.id); }
}

class SessionManager {
  constructor(port, { onData, onChange, onStatus, onGone }) {
    this.port = port;
    this.sessions = new Map();
    this.feed = [];
    this.onData = onData;
    this.onChange = onChange;
    this.onStatus = onStatus;
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
      entry.sizeInfo = null;
      if (typeof entry.order !== 'number') entry.order = entry.createdAt || Date.now();
      // Altbestand ohne Vermerk: ein vom Standard abweichender Name gilt als selbst vergeben
      if (!entry.nameSource) entry.nameSource = entry.name === defaultName(entry) ? 'auto' : 'user';
      this.sessions.set(entry.id, new Session(this, entry));
    }
  }

  create({ agent, cwd, name, args, cols, rows }) {
    if (!agents.AGENTS.includes(agent)) throw new Error('Unbekannter Agent: ' + agent);
    const id = crypto.randomBytes(5).toString('hex');
    const entry = {
      id, agent, cwd, args: args || '',
      name: name || defaultName({ agent, cwd }),
      nameSource: name ? 'user' : 'auto', nameAt: name ? Date.now() : 0,
      createdAt: Date.now(), order: Date.now(), status: 'starting', detail: 'startet…', statusSource: 'system',
      unread: false, title: '', agentSessionId: null, exitedAt: null, sizeInfo: null,
    };
    const s = new Session(this, entry);
    this.sessions.set(id, s);
    state.rememberRecent(cwd);
    s.resize(cols, rows); // Groesse des anzeigenden Panes, damit die erste Ausgabe passt
    s.spawn();
    this.pushFeed(`${entry.name} · gestartet`);
    this.persistAndBroadcast();
    return s;
  }

  restore(id, cols, rows) {
    const s = this.sessions.get(id);
    if (!s || s.proc) return;
    s.resize(cols, rows);
    s.spawn({ resume: true });
    this.pushFeed(`${s.entry.name} · wiederhergestellt`);
    this.persistAndBroadcast();
  }

  restoreAll(cols, rows) {
    for (const s of this.sessions.values()) if (!s.proc && s.entry.status === 'exited') this.restore(s.entry.id, cols, rows);
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

  rename(id, name, { toAgent = true } = {}) {
    const s = this.sessions.get(id);
    if (!s || !name) return;
    s.entry.name = String(name).slice(0, 80);
    s.entry.nameSource = 'user'; // ab jetzt nicht mehr automatisch nachziehen
    s.entry.nameAt = Date.now();
    if (toAgent) s.renameInAgent(s.entry.name);
    this.persistAndBroadcast();
  }

  // Neuer Platz in der Sidebar (per Drag gesetzt): danach den Ordner sauber durchnummerieren, damit
  // die Werte nicht mit jeder Verschiebung weiter zusammenruecken
  setOrder(id, order) {
    const s = this.sessions.get(id);
    if (!s || typeof order !== 'number' || !Number.isFinite(order)) return;
    s.entry.order = order;
    [...this.sessions.values()]
      .filter(x => x.entry.cwd === s.entry.cwd)
      .sort((a, b) => (a.entry.order ?? 0) - (b.entry.order ?? 0) || a.entry.createdAt - b.entry.createdAt)
      .forEach((x, i) => { x.entry.order = (i + 1) * 1000; });
    this.persistAndBroadcast();
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

  emitStatus(entry) { if (this.onStatus) this.onStatus(entry); }

  // Session fuer die Steuer-API finden: ID, exakter Name, ID-Anfang oder eindeutiger Namensteil
  resolve(query) {
    const q = String(query ?? '').trim();
    if (!q) throw apiError(400, 'Session fehlt');
    const low = q.toLowerCase();
    const all = [...this.sessions.values()];
    const tries = [
      s => s.entry.id === q,
      s => s.entry.name.toLowerCase() === low,
      s => s.entry.id.startsWith(low),
      s => s.entry.name.toLowerCase().includes(low),
    ];
    for (const match of tries) {
      const hits = all.filter(match);
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) throw apiError(409, `„${q}" ist mehrdeutig: ${hits.map(h => `${h.entry.id} (${h.entry.name})`).join(', ')}`);
    }
    throw apiError(404, `Keine Session „${q}"`);
  }

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
      .sort((a, b) => a.cwd.toLowerCase().localeCompare(b.cwd.toLowerCase()) || (a.order ?? a.createdAt) - (b.order ?? b.createdAt));
  }

  // Laufender Takt: nur die Sessionliste sichern. Die Checkpoints laufen je Session nach eigenem
  // Takt - alle auf einmal zu serialisieren hat den Daemon fuer eine halbe Sekunde angehalten.
  flushNow() { state.saveSessionsNow(this.toPersist()); }

  // Beim Beenden: von jeder Session einen Checkpoint ziehen und die Journale sauber schliessen
  saveAllNow() {
    for (const s of this.sessions.values()) { try { s.saveNow(); } catch {} }
    state.closeAllJournals();
    state.saveSessionsNow(this.toPersist());
  }
}

module.exports = { SessionManager };
