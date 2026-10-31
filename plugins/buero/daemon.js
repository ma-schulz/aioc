// Aioc-Plugin „Pixel-Büro" (Daemon): Liest aktive und kürzlich beendete Subagenten
// der laufenden Sessions aus (Claude Code: subagents/*.meta.json + *.jsonl;
// Antigravity: invoke_subagent in transcript.jsonl) und veröffentlicht sie an die UI,
// damit sie als kleine Helfer-Figuren im selben Cubicle wie der Haupt-Agent erscheinen.
const fs = require('fs');
const os = require('os');
const path = require('path');
const state = require('../../daemon/state');

const SCAN_INTERVAL_MS = 2500;
// Wie lange ein fertiger Subagent noch im Cubicle (oder mit Kaffee daneben) sichtbar bleibt
const RECENT_DONE_MS = 10 * 60 * 1000;
// Wann ein laufender Subagent ohne Dateibewegung als fertig/inaktiv gilt
const RUNNING_STALE_MS = 3 * 60 * 1000;

function readTail(filePath, maxBytes = 8192) {
  try {
    const st = fs.statSync(filePath);
    const size = st.size;
    if (!size) return { mtimeMs: st.mtimeMs, text: '' };
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(filePath, 'r');
    try {
      fs.readSync(fd, buf, 0, len, start);
    } finally {
      fs.closeSync(fd);
    }
    return { mtimeMs: st.mtimeMs, text: buf.toString('utf8') };
  } catch {
    return null;
  }
}

function findClaudeSubagentsDir(agentSessionId, configDirs) {
  if (!agentSessionId) return null;
  for (const cfg of configDirs) {
    const projRoot = path.join(cfg, 'projects');
    let projects;
    try { projects = fs.readdirSync(projRoot); } catch { continue; }
    for (const p of projects) {
      const subDir = path.join(projRoot, p, agentSessionId, 'subagents');
      try {
        if (fs.statSync(subDir).isDirectory()) return subDir;
      } catch {}
    }
  }
  return null;
}

function scanClaudeSubagents(session, configDirs, now) {
  const subDir = findClaudeSubagentsDir(session.agentSessionId, configDirs);
  if (!subDir) return [];
  let files;
  try { files = fs.readdirSync(subDir); } catch { return []; }
  const metas = files.filter(f => f.endsWith('.meta.json'));
  const result = [];

  for (const mf of metas) {
    const base = mf.slice(0, -'.meta.json'.length);
    const jlPath = path.join(subDir, base + '.jsonl');
    const tail = readTail(jlPath, 6144);
    if (!tail) continue;
    const ageMs = now - tail.mtimeMs;
    if (ageMs > RECENT_DONE_MS) continue;

    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(subDir, mf), 'utf8')); } catch {}

    const lines = tail.text.trim().split('\n').filter(Boolean);
    let lastObj = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      try { lastObj = JSON.parse(lines[i]); break; } catch {}
    }

    const stopReason = lastObj?.message?.stop_reason;
    const isFinished = stopReason === 'end_turn' || stopReason === 'stop_sequence';
    const isRunning = !isFinished && ageMs < RUNNING_STALE_MS;

    // Nur aktive oder in den letzten Minuten abgeschlossene Subagenten zeigen
    if (!isRunning && ageMs > 90 * 1000) continue;

    // Letztes benutztes Tool als kleines Detail auslesen
    let lastTool = '';
    const content = lastObj?.message?.content;
    if (Array.isArray(content)) {
      const tu = [...content].reverse().find(c => c.type === 'tool_use');
      if (tu?.name) lastTool = tu.name;
    }

    result.push({
      id: base,
      parentId: session.id,
      agent: session.agent,
      name: meta.description || meta.agentType || base.replace(/^agent-/, ''),
      role: meta.agentType || 'subagent',
      model: meta.model || '',
      status: isRunning ? 'running' : 'done',
      detail: isRunning ? (lastTool ? `Tool: ${lastTool}` : 'arbeitet im Cubicle') : 'Aufgabe erledigt',
      mtimeMs: tail.mtimeMs,
    });
  }

  return result.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 4);
}

function scanAgySubagents(session, now) {
  const cid = session.agentSessionId;
  if (!cid) return [];
  const tf = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain', cid, '.system_generated', 'logs', 'transcript.jsonl');
  const tail = readTail(tf, 65536);
  if (!tail || now - tail.mtimeMs > RECENT_DONE_MS) return [];

  const subMap = new Map();
  for (const line of tail.text.split('\n')) {
    if (!line.includes('invoke_subagent') && !line.includes('subagent')) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (Array.isArray(obj.tool_calls)) {
      for (const tc of obj.tool_calls) {
        if (tc.name === 'invoke_subagent' || tc.name === 'default_api:invoke_subagent') {
          const args = tc.args || tc.arguments || {};
          const key = tc.id || args.Role || 'sub';
          subMap.set(key, {
            id: `${cid}-${key}`,
            parentId: session.id,
            agent: 'agy',
            name: args.Role || args.TypeName || 'Subagent',
            role: args.TypeName || 'subagent',
            status: (now - tail.mtimeMs < 45000 && session.status === 'running') ? 'running' : 'done',
            detail: args.Role || 'Subagent',
            mtimeMs: tail.mtimeMs,
          });
        }
      }
    }
  }
  return [...subMap.values()].slice(-4);
}

function activate(ctx) {
  let lastJson = '';

  function getClaudeConfigDirs() {
    const home = os.homedir();
    const dirs = [path.join(home, '.claude'), path.join(home, '.claude-mp')];
    try {
      const saved = state.loadSessions();
      for (const s of saved) {
        if (s.env?.CLAUDE_CONFIG_DIR && !dirs.includes(s.env.CLAUDE_CONFIG_DIR)) {
          dirs.push(s.env.CLAUDE_CONFIG_DIR);
        }
      }
    } catch {}
    return dirs.filter(d => { try { return fs.existsSync(d); } catch { return false; } });
  }

  function scan() {
    const now = Date.now();
    const savedById = new Map();
    try {
      for (const e of state.loadSessions()) savedById.set(e.id, e);
    } catch {}

    const configDirs = getClaudeConfigDirs();
    const bySession = {};
    let totalActive = 0;

    for (const s of ctx.sessions.list()) {
      if (s.status === 'exited') continue;
      const saved = savedById.get(s.id);
      const merged = { ...s, agentSessionId: saved?.agentSessionId || null };
      let subs = [];
      if (s.agent === 'claude') subs = scanClaudeSubagents(merged, configDirs, now);
      else if (s.agent === 'agy') subs = scanAgySubagents(merged, now);

      if (subs.length) {
        bySession[s.id] = subs;
        totalActive += subs.filter(x => x.status === 'running').length;
      }
    }

    const payload = { subagents: bySession, totalActive };
    const json = JSON.stringify(payload);
    if (json !== lastJson) {
      lastJson = json;
      ctx.publish(payload);
    }
  }

  const timer = setInterval(scan, SCAN_INTERVAL_MS);
  timer.unref?.();
  setTimeout(scan, 300);

  return {
    sessionsChanged() {
      scan();
    },
    handle(msg) {
      if (msg.action === 'refresh') scan();
    },
  };
}

module.exports = { activate };
