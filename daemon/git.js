// Aioc Git-Anzeige: Branch und Arbeitsstand je Session-Ordner - nur lesend, fuer Sidebar und
// Pane-Kopfzeilen. `--no-optional-locks` sorgt dafuer, dass `git status` weder die index.lock
// nimmt noch den Index neu schreibt; sonst koennte die Anzeige einem Agenten, der gerade
// committet, ein "index.lock exists" einbrocken.
const { execFile } = require('child_process');

const keyOf = cwd => String(cwd || '').replace(/[\\/]+$/, '').toLowerCase();

// Ausgabe von `git status --porcelain=v2 --branch` auswerten
function parseStatus(out) {
  const g = { repo: true, branch: null, detached: false, upstream: null, ahead: 0, behind: 0, changed: 0, untracked: 0, conflicts: 0 };
  let oid = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('# branch.oid ')) oid = line.slice(13).trim();
    else if (line.startsWith('# branch.head ')) {
      const head = line.slice(14).trim();
      if (head === '(detached)') g.detached = true; else g.branch = head;
    } else if (line.startsWith('# branch.upstream ')) g.upstream = line.slice(18).trim();
    else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) { g.ahead = Number(m[1]); g.behind = Number(m[2]); }
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) g.changed++;
    else if (line.startsWith('u ')) g.conflicts++;
    else if (line.startsWith('? ')) g.untracked++;
  }
  if (g.detached) g.branch = oid && oid !== '(initial)' ? oid.slice(0, 8) : 'detached';
  if (!g.branch) g.branch = '?';
  return g;
}

class GitWatcher {
  constructor(onChange) {
    this.onChange = onChange;
    this.info = new Map(); // Ordner (klein, ohne Schlussstrich) -> Stand
    this.busy = new Set();
  }

  // Stand neu holen, wenn der letzte aelter als minAge ms ist und gerade keine Abfrage laeuft
  refresh(cwd, minAge = 15000) {
    const k = keyOf(cwd);
    const cur = this.info.get(k);
    if (!k || this.busy.has(k) || (cur && Date.now() - cur.at < minAge)) return;
    this.busy.add(k);
    // Erst die Wurzel des Worktrees: daran erkennt die Oberflaeche, ob ein Agent in einem anderen
    // Worktree arbeitet als dem seiner Gruppe - ein Unterordner desselben Worktrees zaehlt nicht.
    execFile('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { windowsHide: true, timeout: 10000 }, (rootErr, rootOut) => {
      const root = rootErr ? null : String(rootOut).trim() || null;
      execFile('git', ['--no-optional-locks', '-C', cwd, 'status', '--porcelain=v2', '--branch'],
      { windowsHide: true, timeout: 20000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
        this.busy.delete(k);
        let next;
        if (!err) next = { ...parseStatus(stdout), root };
        // Zeitlimit/Riesenausgabe: alten Stand behalten statt "kein Repo" anzuzeigen
        else if (err.killed || err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') next = cur ? { ...cur } : { repo: false };
        else next = { repo: false }; // kein Repo, Ordner fehlt oder git nicht im PATH
        next.at = Date.now();
        const same = cur && JSON.stringify({ ...cur, at: 0 }) === JSON.stringify({ ...next, at: 0 });
        this.info.set(k, next);
        if (!same && this.onChange) this.onChange();
      });
    });
  }

  get(cwd) {
    const g = this.info.get(keyOf(cwd));
    if (!g || !g.repo) return null;
    const { at, repo, ...rest } = g;
    return rest;
  }

  // Ordner vergessen, zu denen es keine Session mehr gibt
  prune(cwds) {
    const keep = new Set(cwds.map(keyOf));
    for (const k of this.info.keys()) if (!keep.has(k)) this.info.delete(k);
  }
}

module.exports = { GitWatcher, parseStatus };
