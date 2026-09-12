// Aioc agent launch configs: how claude / codex / pi / pwsh are spawned, with per-invocation
// status hooks injected. Nothing here touches global agent configs (~/.claude, ~/.codex, ~/.pi).
const fs = require('fs');
const path = require('path');
const state = require('./state');

const HOOK = path.join(__dirname, 'hooks', 'agent-hook.js');
const PI_EXT = path.join(__dirname, 'hooks', 'aioc-pi-ext.ts');
const BIN = path.join(__dirname, '..', 'bin');
const fwd = p => p.replace(/\\/g, '/');

const AGENTS = ['claude', 'codex', 'pi', 'pwsh'];

// Environment for spawned sessions: inherit, but strip CLAUDE* markers (a claude session that
// spawned the daemon must not make child claudes think they are nested) and add Aioc markers.
function buildEnv(port, sessionId, agent) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^CLAUDE/i.test(k)) continue;
    env[k] = v;
  }
  env.AIOC_PORT = String(port);
  env.AIOC_SESSION = sessionId;
  // bin/ (aioc-ctl) nur fuer Aioc-Sessions vorne in den PATH - global wird nichts installiert
  const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH';
  env[pathKey] = BIN + path.delimiter + (env[pathKey] || '');
  return env;
}

// ~/.aioc/claude-settings.json — passed via `claude --settings`. Verified 2026-08-30: hooks from
// --settings run IN ADDITION to global/project hooks, so nothing of the user's setup is replaced.
function writeClaudeSettings() {
  const H = { type: 'command', command: `node "${HOOK}" claude` };
  const plain = () => [{ hooks: [H] }];
  const settings = {
    hooks: {
      SessionStart: plain(),
      UserPromptSubmit: plain(),
      PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [H] }],
      PostToolUse: [{ matcher: 'AskUserQuestion', hooks: [H] }],
      PermissionRequest: plain(),
      Notification: plain(),
      Stop: plain(),
      SessionEnd: plain(),
    },
  };
  fs.writeFileSync(state.claudeSettingsFile, JSON.stringify(settings, null, 2));
  return state.claudeSettingsFile;
}

// Codex hooks per invocation via -c overrides. Verified 2026-08-30 (exec): UserPromptSubmit and
// Stop fire, env + session_id arrive. TOML literal strings + forward slashes are mandatory.
function codexHookArgs() {
  const cmd = `node ${fwd(HOOK)} codex`;
  const mk = ev => `hooks.${ev}=[{hooks=[{type='command',command='${cmd}'}]}]`;
  const out = [];
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Stop']) out.push('-c', mk(ev));
  return out;
}

function splitArgs(str) {
  if (!str) return [];
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(str))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// Build the spawn spec for a session. entry: {agent, cwd, args, agentSessionId}; resume: reuse
// the agent's own conversation persistence after daemon/PC restart.
function buildSpawn(entry, port, { resume = false } = {}) {
  const extra = splitArgs(entry.args);
  const env = buildEnv(port, entry.id, entry.agent);
  switch (entry.agent) {
    case 'claude': {
      const settings = writeClaudeSettings();
      const args = ['/c', 'claude', '--settings', settings];
      if (resume && entry.agentSessionId) args.push('--resume', entry.agentSessionId);
      return { file: 'cmd.exe', args: [...args, ...extra], env };
    }
    case 'codex': {
      const args = ['/c', 'codex'];
      if (resume && entry.agentSessionId) args.push('resume', entry.agentSessionId);
      // Codex' Hook-Trust-Dialog ist one-shot: einmal weggeklickt, laufen Hooks still nie.
      // Die Aioc-Hooks sind unsere eigenen -c-Injektionen, daher Trust hier bewusst umgehen.
      args.push('--dangerously-bypass-hook-trust');
      return { file: 'cmd.exe', args: [...args, ...codexHookArgs(), ...extra], env };
    }
    case 'pi': {
      const args = ['/c', 'pi', '-e', PI_EXT];
      if (resume) args.push(...(entry.agentSessionId ? ['--session', entry.agentSessionId] : ['--continue']));
      return { file: 'cmd.exe', args: [...args, ...extra], env };
    }
    case 'pwsh':
    default:
      return { file: 'pwsh.exe', args: ['-NoLogo', ...extra], env };
  }
}

module.exports = { AGENTS, buildSpawn, writeClaudeSettings };
