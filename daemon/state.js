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

function scrollbackPath(id) { return path.join(SCROLLBACK_DIR, id + '.txt'); }
function saveScrollback(id, text) {
  try { fs.writeFileSync(scrollbackPath(id) + '.tmp', text); fs.renameSync(scrollbackPath(id) + '.tmp', scrollbackPath(id)); } catch {}
}
function loadScrollback(id) {
  try { return fs.readFileSync(scrollbackPath(id), 'utf8'); } catch { return ''; }
}
function deleteScrollback(id) { try { fs.unlinkSync(scrollbackPath(id)); } catch {} }

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
  saveScrollback, loadScrollback, deleteScrollback,
  loadUiState, rememberRecent,
};
