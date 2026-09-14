// Aioc state: persistence under ~/.aioc (sessions list, scrollback snapshots, daemon info, UI state).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// AIOC_HOME erlaubt ein zweites, isoliertes Profil (z. B. zum Testen) neben ~/.aioc
const DIR = process.env.AIOC_HOME || path.join(os.homedir(), '.aioc');
const SCROLLBACK_DIR = path.join(DIR, 'scrollback');
for (const d of [DIR, SCROLLBACK_DIR]) fs.mkdirSync(d, { recursive: true });

const sessionsFile = path.join(DIR, 'sessions.json');
const daemonFile = path.join(DIR, 'daemon.json');
const uiFile = path.join(DIR, 'ui-state.json');
const claudeSettingsFile = path.join(DIR, 'claude-settings.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function loadDaemonInfo() {
  const d = readJson(daemonFile, {});
  if (!d.token) d.token = crypto.randomBytes(24).toString('hex');
  if (!d.port) d.port = 43117;
  if (!d.host) d.host = '127.0.0.1';
  return d;
}

function saveDaemonInfo(info) { writeJsonAtomic(daemonFile, info); }

function loadSessions() { return readJson(sessionsFile, []); }

let saveTimer = null;
function saveSessionsDebounced(list) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveSessionsNow(list), 400);
}
function saveSessionsNow(list) {
  clearTimeout(saveTimer);
  writeJsonAtomic(sessionsFile, list);
}

// Scrollback = Checkpoint + Journal. Der Checkpoint (<id>.txt, wie bisher der serialisierte Puffer)
// wird nur noch selten geschrieben; die laufende Ausgabe haengt als Rohtext im Journal (<id>.log).
// Vorher serialisierte der Daemon alle 3 s je Session und alle 30 s alle Sessions den ganzen Puffer -
// gemessene ~80 ms je Session, die synchron den Hauptthread blockierten und das Tippen verzoegerten.
// Der Checkpoint behaelt seinen Dateinamen, aeltere Profile laufen also ohne Umstellung weiter.
function scrollbackPath(id) { return path.join(SCROLLBACK_DIR, id + '.txt'); }
function journalPath(id) { return path.join(SCROLLBACK_DIR, id + '.log'); }

const journals = new Map(); // id -> WriteStream (asynchron, blockiert den Hauptthread nicht)

function appendScrollback(id, chunk) {
  if (!chunk) return 0;
  let stream = journals.get(id);
  if (!stream) {
    try { stream = fs.createWriteStream(journalPath(id), { flags: 'a' }); } catch { return 0; }
    stream.on('error', () => journals.delete(id));
    journals.set(id, stream);
  }
  try { stream.write(chunk); } catch {}
  return Buffer.byteLength(chunk);
}

function closeJournal(id) {
  const stream = journals.get(id);
  if (!stream) return;
  journals.delete(id);
  try { stream.end(); } catch {}
}

function closeAllJournals() { for (const id of [...journals.keys()]) closeJournal(id); }

function journalSize(id) {
  try { return fs.statSync(journalPath(id)).size; } catch { return 0; }
}

// Checkpoint schreiben und das Journal leeren - alles darin steckt jetzt im Checkpoint
function saveScrollback(id, text) {
  try {
    fs.writeFileSync(scrollbackPath(id) + '.tmp', text);
    fs.renameSync(scrollbackPath(id) + '.tmp', scrollbackPath(id));
    closeJournal(id);
    fs.writeFileSync(journalPath(id), '');
  } catch {}
}

// Wiederherstellen: erst der Checkpoint, dann die seither angefallene Rohausgabe
function loadScrollback(id) {
  let out = '';
  try { out = fs.readFileSync(scrollbackPath(id), 'utf8'); } catch {}
  try { out += fs.readFileSync(journalPath(id), 'utf8'); } catch {}
  return out;
}

function deleteScrollback(id) {
  closeJournal(id);
  for (const file of [scrollbackPath(id), journalPath(id)]) { try { fs.unlinkSync(file); } catch {} }
}

// Scrollback-Dateien, zu denen keine Session mehr gehoert, blieben sonst fuer immer liegen (Sessions,
// die nicht ueber dispose verschwunden sind). Nur beim Start aufrufen, bevor Journale geoeffnet werden.
function pruneScrollback(keepIds) {
  let files = 0, bytes = 0, names = [];
  try { names = fs.readdirSync(SCROLLBACK_DIR); } catch { return { files, bytes }; }
  for (const name of names) {
    const m = name.match(/^([0-9a-z]+)\.(?:txt|log)(?:\.tmp)?$/i);
    if (!m || keepIds.has(m[1])) continue;
    const file = path.join(SCROLLBACK_DIR, name);
    try { const size = fs.statSync(file).size; fs.unlinkSync(file); files++; bytes += size; } catch {}
  }
  return { files, bytes };
}

function loadUiState() { return readJson(uiFile, { recents: [] }); }
function saveUiState(s) { writeJsonAtomic(uiFile, s); }
function rememberRecent(cwd) {
  const s = loadUiState();
  s.recents = [cwd, ...(s.recents || []).filter(r => r.toLowerCase() !== cwd.toLowerCase())].slice(0, 12);
  saveUiState(s);
  return s.recents;
}

module.exports = {
  DIR, sessionsFile, daemonFile, claudeSettingsFile,
  readJson, writeJsonAtomic,
  loadDaemonInfo, saveDaemonInfo,
  loadSessions, saveSessionsDebounced, saveSessionsNow,
  saveScrollback, loadScrollback, deleteScrollback, pruneScrollback,
  appendScrollback, journalSize, closeAllJournals,
  loadUiState, saveUiState, rememberRecent,
};
