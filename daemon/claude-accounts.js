// Claude-Konten: jedes Konto ist ein eigener Claude-Konfigurationsordner mit eigener Anmeldung
// (CLAUDE_CONFIG_DIR). Standard ist ~/.claude; weitere Konten sind Ordner ~/.claude-<name> mit einer
// .claude.json darin - so legt Claude sie selbst an, wenn man es mit CLAUDE_CONFIG_DIR startet.
// Organisation und Mailadresse stammen aus oauthAccount der jeweiligen .claude.json, das Ende der
// Anmeldung aus claudeAiOauth.refreshTokenExpiresAt in .credentials.json (gilt rund einen Monat).
const fs = require('fs');
const os = require('os');
const path = require('path');
const state = require('./state');

const STANDARD = 'standard';
const TTL = 10000;
const TAG = 864e5;
const WARN_TAGE = 5;
// Organisation, die Aioc je Konto erwartet: die erste, die es dort angemeldet sieht. Meldet sich ein
// Ordner später bei einer anderen an (gleiche Mail, falsche Organisation im Browser gewählt), warnt Aioc.
const erwartetFile = path.join(state.DIR, 'claude-konten.json');
let cache = null;

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }

function describe(id, dir, configFile) {
  const a = readJson(configFile)?.oauthAccount || null;
  const credFile = path.join(dir, '.credentials.json');
  const o = readJson(credFile)?.claudeAiOauth || null;
  let credMtime = 0;
  try { credMtime = fs.statSync(credFile).mtimeMs; } catch {}
  return {
    id, dir,
    org: a?.organizationName || null,
    orgId: a?.organizationUuid || null,
    email: a?.emailAddress || null,
    angemeldet: !!a && !!o?.refreshToken,
    loginBis: Number(o?.refreshTokenExpiresAt) || null,
    credMtime,
  };
}

// ok | bald (≤ WARN_TAGE) | abgelaufen | abgemeldet (war schon angemeldet) | fremdeOrg | offen (nie angemeldet)
function statusOf(k, e, now) {
  if (!k.angemeldet) return e ? 'abgemeldet' : 'offen';
  if (e && k.orgId && e.orgId !== k.orgId) return 'fremdeOrg';
  if (k.loginBis && k.loginBis <= now) return 'abgelaufen';
  if (k.loginBis && k.loginBis - now <= WARN_TAGE * TAG) return 'bald';
  return 'ok';
}

// fresh: am Cache vorbei, z. B. wenn der Dialog „Neue Session“ aufgeht
function list({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < TTL) return cache.value;
  const home = os.homedir();
  const raw = [describe(STANDARD, path.join(home, '.claude'), path.join(home, '.claude.json'))];
  let names = [];
  try {
    names = fs.readdirSync(home, { withFileTypes: true })
      .filter(d => d.isDirectory() && /^\.claude-[\w.-]+$/.test(d.name)).map(d => d.name).sort();
  } catch {}
  for (const n of names) {
    const dir = path.join(home, n);
    if (fs.existsSync(path.join(dir, '.claude.json'))) raw.push(describe(n, dir, path.join(dir, '.claude.json')));
  }
  const erw = readJson(erwartetFile) || {};
  let neu = false;
  for (const k of raw) {
    if (k.angemeldet && k.orgId && !erw[k.id]) { erw[k.id] = { orgId: k.orgId, org: k.org }; neu = true; }
  }
  if (neu) { try { fs.writeFileSync(erwartetFile, JSON.stringify(erw, null, 2)); } catch {} }
  const now = Date.now();
  const value = raw.map(k => ({ ...k, status: statusOf(k, erw[k.id], now), erwartetOrg: erw[k.id]?.org || null }));
  cache = { at: now, value };
  return value;
}

// Die jetzt angemeldete Organisation des Kontos ist richtig („Passt so“ im Warnband)
function acceptOrg(id) {
  const k = list({ fresh: true }).find(x => x.id === id);
  if (!k?.orgId) throw new Error('Konto ist nicht angemeldet: ' + id);
  const erw = readJson(erwartetFile) || {};
  erw[id] = { orgId: k.orgId, org: k.org };
  fs.writeFileSync(erwartetFile, JSON.stringify(erw, null, 2));
  cache = null;
}

// Umgebung für eine neue Session; das Standardkonto braucht keine
function envFor(id) {
  if (!id || id === STANDARD) return undefined;
  const k = list({ fresh: true }).find(x => x.id === id);
  if (!k) throw new Error('Unbekanntes Claude-Konto: ' + id);
  return { CLAUDE_CONFIG_DIR: k.dir };
}

// Konto einer laufenden Session, für die Anzeige (nur bei eigenem CLAUDE_CONFIG_DIR)
function forDir(dir) {
  if (!dir) return null;
  const norm = p => path.resolve(p).toLowerCase();
  const k = list().find(x => norm(x.dir) === norm(dir));
  return { id: k?.id || path.basename(dir), label: k?.org || path.basename(dir) };
}

// Kurzname für Meldungen: das Standardkonto heißt so, die anderen nach ihrer Organisation
function labelOf(k) { return k.id === STANDARD ? 'Standard' : (k.erwartetOrg || k.org || k.id); }

const toClient = opts => list(opts).map(({ dir, orgId, credMtime, ...k }) => k);

module.exports = { STANDARD, WARN_TAGE, list, envFor, forDir, labelOf, acceptOrg, toClient };
