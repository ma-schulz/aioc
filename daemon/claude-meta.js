// Liest Claudes eigene Session-Registry (`~/.claude/sessions/<pid>.json`). Dort steht, wie die
// Session heisst und woher der Name kommt: `nameSource: 'user'` = im Agenten per /rename gesetzt,
// 'derived' = von Claude selbst erzeugter Titel. Nur damit kann Aioc einen von dir gesetzten Namen
// von einer automatischen Zusammenfassung unterscheiden. Undokumentiertes Format - alles defensiv,
// im Zweifel null; der Terminaltitel bleibt die eigentliche Quelle.
const fs = require('fs');
const os = require('os');
const path = require('path');

const TTL = 2000;
const cache = new Map(); // sessionId -> { at, value }

const dir = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'sessions');

function scan(sessionId) {
  let files;
  try { files = fs.readdirSync(dir()).filter(f => f.endsWith('.json')); } catch { return null; }
  let best = null;
  for (const f of files) {
    try {
      const o = JSON.parse(fs.readFileSync(path.join(dir(), f), 'utf8'));
      // Nach einem Resume gibt es zur selben Session eine zweite (alte) PID-Datei - die juengere gilt
      if (o.sessionId === sessionId && o.name && (!best || (o.updatedAt || 0) > (best.updatedAt || 0))) best = o;
    } catch { /* Datei wird gerade geschrieben oder hat ein anderes Format */ }
  }
  return best ? { name: String(best.name), nameSource: best.nameSource || null, nameSince: Number(best.nameSince) || 0 } : null;
}

// fresh: am Cache vorbei lesen - Claude schreibt die Registry manchmal erst kurz nach dem Titel
function lookup(sessionId, { fresh = false } = {}) {
  if (!sessionId) return null;
  const hit = cache.get(sessionId);
  if (!fresh && hit && Date.now() - hit.at < TTL) return hit.value;
  const value = scan(sessionId);
  cache.set(sessionId, { at: Date.now(), value });
  return value;
}

module.exports = { lookup };
