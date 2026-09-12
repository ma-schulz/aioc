#!/usr/bin/env node
// aioc-ctl: Aioc von der Kommandozeile steuern - fuer Skripte und fuer Agenten, die andere
// Sessions lesen, anschreiben oder auf sie warten sollen. Spricht die lokale Steuer-API des
// Daemons (nur 127.0.0.1, Token aus daemon.json). Veraendert nichts ausser den Terminals, in die
// man ausdruecklich schreibt.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HELP = `aioc-ctl – Aioc-Sessions lesen, anschreiben und auf sie warten

  aioc-ctl list                               alle Sessions mit Status
  aioc-ctl read <session> [--lines N|--all]   Terminalinhalt als Text (Standard: letzte 60 Zeilen)
  aioc-ctl read <session> --answer            letzte Antwort des Agenten (Claude/Codex, aus dem Stop-Hook)
  aioc-ctl prompt <session> <text…>           Text eingeben und absenden ("-" = Text von stdin)
      --no-enter                              nur eingeben, nicht absenden
      --wait [--timeout S]                    danach warten, bis der Agent fertig ist oder fragt,
                                              und seine Antwort ausgeben
  aioc-ctl key <session> <taste…>             Tasten senden: enter esc tab shift+tab up down left right
                                              space backspace pgup pgdn ctrl+c … oder ein einzelnes Zeichen
  aioc-ctl wait <session> [--until S,S] [--timeout S]
                                              warten, bis die Session einen der Status erreicht
                                              (Standard: waiting,done,idle,exited)

  <session>  ID, Name, eindeutiger Teil des Namens oder "self" (die eigene Aioc-Session)
  --json     Ausgabe als JSON
  Status:    starting running waiting done idle exited
  Exit-Code: 0 ok · 1 Fehler · 2 falscher Aufruf · 124 Zeitlimit beim Warten erreicht`;

const VALUE_FLAGS = new Set(['--lines', '--timeout', '--until']);
const BOOL_FLAGS = new Set(['--all', '--answer', '--json', '--no-enter', '--wait', '--help', '-h']);

const out = s => process.stdout.write(s + '\n');
function fail(msg, code = 1) {
  process.stderr.write(`aioc-ctl: ${msg}\n`);
  process.exit(code);
}
const usage = msg => fail(`${msg}\n\n${HELP}`, 2);

function parseArgs(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (VALUE_FLAGS.has(a)) {
      if (i + 1 >= argv.length) usage(`${a} braucht einen Wert`);
      opt[a.slice(2)] = argv[++i];
    } else if (eq > 0 && VALUE_FLAGS.has(a.slice(0, eq))) opt[a.slice(2, eq)] = a.slice(eq + 1);
    else if (BOOL_FLAGS.has(a)) opt[a.replace(/^-+/, '')] = true;
    else if (a.startsWith('--')) usage(`Unbekannte Option ${a}`);
    else pos.push(a);
  }
  return { pos, opt };
}

// Port und Token stehen in daemon.json (AIOC_HOME oder ~/.aioc) - dieselbe Datei, aus der auch die
// Fenster ihren Zugang beziehen
let conn = null;
function connection() {
  if (conn) return conn;
  const file = path.join(process.env.AIOC_HOME || path.join(os.homedir(), '.aioc'), 'daemon.json');
  let d;
  try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail(`kein Aioc-Daemon eingerichtet (${file} fehlt)`); }
  if (!d.token) fail(`${file} enthält kein Token`);
  conn = { port: Number(d.port || process.env.AIOC_PORT || 43117), token: d.token };
  return conn;
}

function api(method, pathname, body) {
  const { port, token } = connection();
  const data = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method,
      headers: { authorization: 'Bearer ' + token, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) },
    }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        if (res.statusCode === 404 && raw === 'not found') {
          reject(new Error('der laufende Daemon kennt die Steuer-API noch nicht – einmal aioc-restart.cmd ausführen'));
          return;
        }
        let obj;
        try { obj = JSON.parse(raw); } catch { obj = { error: raw || `HTTP ${res.statusCode}` }; }
        if (res.statusCode >= 400) reject(new Error(obj.error || `HTTP ${res.statusCode}`));
        else resolve(obj);
      });
    });
    req.on('error', err => reject(new Error(err.code === 'ECONNREFUSED' ? `Aioc-Daemon antwortet nicht (Port ${port})` : err.message)));
    req.end(data || undefined);
  });
}

function seconds(v) {
  const n = Number(String(v).replace(',', '.'));
  if (!(n > 0)) usage(`--timeout erwartet Sekunden > 0, nicht „${v}"`);
  return n * 1000;
}

function readStdin() {
  return new Promise(resolve => {
    let d = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => { d += c; });
    process.stdin.on('end', () => resolve(d.replace(/\r?\n$/, '')));
  });
}

const gitShort = g => {
  const changes = (g.changed || 0) + (g.untracked || 0) + (g.conflicts || 0);
  return [g.branch, changes ? '±' + changes : '', g.ahead ? '↑' + g.ahead : '', g.behind ? '↓' + g.behind : ''].filter(Boolean).join(' ');
};
const statusLine = w => `${w.timedOut ? 'Zeitlimit erreicht – ' : ''}${w.name ? w.name + ': ' : ''}${w.status || '?'}${w.detail ? ' · ' + w.detail : ''}`;

function table(head, rows) {
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const max = [12, 9, 7, 32, 56];
  const cells = [head, ...rows].map(r => r.map((c, i) => (i < max.length ? clip(String(c ?? ''), max[i]) : String(c ?? ''))));
  const w = head.map((_, i) => Math.max(...cells.map(r => r[i].length)));
  for (const r of cells) out(r.map((c, i) => (i < r.length - 1 ? c.padEnd(w[i]) : c)).join('  ').trimEnd());
}

// Warten in Etappen: jede Anfrage haelt der Daemon hoechstens einige Minuten, danach erneut fragen
async function waitFor(session, { until, after, timeoutMs }) {
  const deadline = timeoutMs ? Date.now() + timeoutMs : Infinity;
  for (;;) {
    const left = Math.round(Math.min(240000, deadline - Date.now()));
    const qs = new URLSearchParams({ session, timeout: String(Math.max(1, left)) });
    if (until) qs.set('until', until);
    if (after !== undefined) qs.set('after', String(after));
    const r = await api('GET', '/api/wait?' + qs);
    if (!r.timedOut || Date.now() >= deadline) return r;
  }
}

async function cmdList(opt) {
  const { sessions } = await api('GET', '/api/sessions');
  if (opt.json) return out(JSON.stringify(sessions, null, 2));
  if (!sessions.length) return out('Keine Sessions.');
  const self = process.env.AIOC_SESSION;
  table(['ID', 'STATUS', 'AGENT', 'NAME', 'ORDNER', 'DETAIL'], sessions.map(s => [
    s.id + (s.id === self ? '*' : ''), s.status, s.agent, s.name,
    s.cwd + (s.git ? ` [${gitShort(s.git)}]` : ''), s.detail,
  ]));
  if (sessions.some(s => s.id === self)) out('\n* = diese Session');
  return undefined;
}

async function cmdRead(target, opt) {
  const qs = new URLSearchParams({ session: target });
  if (opt.answer) qs.set('answer', '1');
  else if (opt.all) qs.set('lines', '0');
  else if (opt.lines !== undefined) {
    const n = Number(opt.lines);
    if (!(n > 0)) usage(`--lines erwartet eine Zahl > 0, nicht „${opt.lines}"`);
    qs.set('lines', String(Math.floor(n)));
  }
  const r = await api('GET', '/api/read?' + qs);
  if (opt.json) return out(JSON.stringify(r, null, 2));
  if (opt.answer) {
    if (r.answer == null) fail('keine Antwort gespeichert – die gibt es erst nach einem abgeschlossenen Turn (Claude, Codex)');
    return out(r.answer);
  }
  return out(r.text);
}

async function cmdPrompt(target, words, opt) {
  if (!words.length) usage('prompt: Text fehlt');
  const text = words.length === 1 && words[0] === '-' ? await readStdin() : words.join(' ');
  const r = await api('POST', '/api/prompt', { session: target, text, enter: !opt['no-enter'], from: process.env.AIOC_SESSION || null });
  if (!opt.wait) return out(opt.json ? JSON.stringify(r, null, 2) : `gesendet an ${r.name} (${r.id})`);
  const w = await waitFor(r.id, { after: r.seq, timeoutMs: opt.timeout !== undefined ? seconds(opt.timeout) : 0 });
  let answer = null;
  if (!w.timedOut && w.status === 'done') {
    answer = (await api('GET', '/api/read?' + new URLSearchParams({ session: r.id, answer: '1' }))).answer;
  }
  if (opt.json) out(JSON.stringify({ ...w, answer }, null, 2));
  else {
    out(statusLine(w));
    if (answer) out('\n' + answer);
  }
  process.exitCode = w.timedOut ? 124 : 0;
  return undefined;
}

async function cmdKey(target, keys, opt) {
  if (!keys.length) usage('key: Taste fehlt');
  const r = await api('POST', '/api/keys', { session: target, keys, from: process.env.AIOC_SESSION || null });
  out(opt.json ? JSON.stringify(r, null, 2) : `gesendet an ${r.name} (${r.id}): ${keys.join(' ')}`);
}

async function cmdWait(target, opt) {
  const w = await waitFor(target, { until: opt.until, timeoutMs: opt.timeout !== undefined ? seconds(opt.timeout) : 0 });
  out(opt.json ? JSON.stringify(w, null, 2) : statusLine(w));
  process.exitCode = w.timedOut ? 124 : 0;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return out(HELP);
  const { pos, opt } = parseArgs(rest);
  if (opt.help || opt.h) return out(HELP);
  let target = null;
  if (['read', 'prompt', 'key', 'wait'].includes(cmd)) {
    target = pos.shift();
    if (!target) usage(`${cmd}: Session fehlt`);
    if (target === 'self') target = process.env.AIOC_SESSION || fail('"self" gibt es nur innerhalb einer Aioc-Session');
  }
  switch (cmd) {
    case 'list': return cmdList(opt);
    case 'read': return cmdRead(target, opt);
    case 'prompt': return cmdPrompt(target, pos, opt);
    case 'key': return cmdKey(target, pos, opt);
    case 'wait': return cmdWait(target, opt);
    default: return usage(`Unbekannter Befehl „${cmd}"`);
  }
}

main().catch(err => fail(err.message));
