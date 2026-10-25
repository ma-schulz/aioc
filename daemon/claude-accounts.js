// Claude-Konten: jedes Konto ist ein eigener Claude-Konfigurationsordner mit eigener Anmeldung
// (CLAUDE_CONFIG_DIR). Standard ist ~/.claude; weitere Konten sind Ordner ~/.claude-<name> mit einer
// .claude.json darin - so legt Claude sie selbst an, wenn man es mit CLAUDE_CONFIG_DIR startet.
// Organisation und Mailadresse stammen aus oauthAccount der jeweiligen .claude.json.
const fs = require('fs');
const os = require('os');
const path = require('path');

const STANDARD = 'standard';
const TTL = 10000;
let cache = null;

function describe(id, dir, configFile) {
  let a = null;
  try { a = JSON.parse(fs.readFileSync(configFile, 'utf8')).oauthAccount || null; } catch {}
  return {
    id, dir,
    org: a?.organizationName || null,
    email: a?.emailAddress || null,
    angemeldet: !!a && fs.existsSync(path.join(dir, '.credentials.json')),
  };
}

// fresh: am Cache vorbei, z. B. wenn der Dialog „Neue Session“ aufgeht
function list({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < TTL) return cache.value;
  const home = os.homedir();
  const out = [describe(STANDARD, path.join(home, '.claude'), path.join(home, '.claude.json'))];
  let names = [];
  try {
    names = fs.readdirSync(home, { withFileTypes: true })
      .filter(d => d.isDirectory() && /^\.claude-[\w.-]+$/.test(d.name)).map(d => d.name).sort();
  } catch {}
  for (const n of names) {
    const dir = path.join(home, n);
    if (fs.existsSync(path.join(dir, '.claude.json'))) out.push(describe(n, dir, path.join(dir, '.claude.json')));
  }
  cache = { at: Date.now(), value: out };
  return out;
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

const toClient = opts => list(opts).map(({ dir, ...k }) => k);

module.exports = { list, envFor, forDir, toClient };
