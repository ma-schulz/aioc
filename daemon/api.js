// Aioc-Steuer-API fuer Skripte und Agenten (Kommandozeile: bin/aioc-ctl): Sessions auflisten,
// Terminal lesen, Prompt oder Tasten senden, auf einen Status warten. Nur ueber Loopback und nur
// mit Token - wer Text in ein Terminal schicken kann, hat vollen Zugriff auf den Rechner.
const STATES = ['starting', 'running', 'waiting', 'done', 'idle', 'exited'];
// Ohne `until` wartet `wait`, bis die Session nicht mehr arbeitet
const DEFAULT_UNTIL = ['waiting', 'done', 'idle', 'exited'];
// Eine Warte-Anfrage haelt hoechstens so lange; die CLI fragt danach einfach erneut
const WAIT_CHUNK_MAX = 4 * 60 * 1000;

const httpError = (status, message) => Object.assign(new Error(message), { status });

function createApi({ mgr, info, git, isLoopback }) {
  const waiters = new Set();

  function json(res, code, obj) {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', c => {
        body += c;
        if (body.length > 1024 * 1024) { reject(httpError(413, 'Anfrage zu groß (max. 1 MB)')); req.destroy(); }
      });
      req.on('end', () => {
        try { resolve(body ? JSON.parse(body) : {}); } catch { reject(httpError(400, 'Ungültiges JSON')); }
      });
      req.on('error', reject);
    });
  }

  function authorized(req) {
    const h = String(req.headers.authorization || '');
    const tok = h.startsWith('Bearer ') ? h.slice(7) : req.headers['x-aioc-token'];
    return !!info.token && tok === info.token;
  }

  function describe(s) {
    const e = s.entry;
    return {
      id: e.id, name: e.name, agent: e.agent, cwd: e.cwd, status: e.status, detail: e.detail || '',
      running: !!s.proc, unread: !!e.unread, seq: e.statusSeq || 0, agentSessionId: e.agentSessionId || null,
      title: e.title || '', nameSource: e.nameSource || 'auto',
      git: git.get(e.cwd),
    };
  }

  const nameOf = id => (id && mgr.sessions.get(id)?.entry.name) || null;
  const oneLine = (text, n) => String(text).replace(/\s+/g, ' ').trim().slice(0, n);

  function finish(w, code, body) {
    waiters.delete(w);
    clearTimeout(w.timer);
    json(w.res, code, body);
  }

  // Nach jedem Statuswechsel: Warte-Anfragen bedienen, deren Bedingung jetzt erfuellt ist
  function checkWaiters() {
    for (const w of [...waiters]) {
      const s = mgr.sessions.get(w.id);
      if (!s) { finish(w, 410, { error: 'Session wurde entfernt' }); continue; }
      if (!s.pendingTurn && (s.entry.statusSeq || 0) > w.after && w.until.has(s.entry.status)) finish(w, 200, { ...describe(s), timedOut: false });
    }
  }

  async function route(req, res, url) {
    const q = url.searchParams;
    switch (`${req.method} ${url.pathname}`) {
      case 'GET /api/sessions':
        return json(res, 200, { sessions: mgr.toClient().map(e => describe(mgr.sessions.get(e.id))) });

      case 'GET /api/read': {
        const s = mgr.resolve(q.get('session'));
        if (q.get('answer')) return json(res, 200, { ...describe(s), answer: s.lastAnswer });
        const lines = q.has('lines') ? Math.max(0, Number(q.get('lines')) || 0) : 60;
        return json(res, 200, { ...describe(s), text: await s.readText(lines) });
      }

      case 'POST /api/prompt': {
        const b = await readBody(req);
        const s = mgr.resolve(b.session);
        if (typeof b.text !== 'string') throw httpError(400, 'text fehlt');
        const seq = s.entry.statusSeq || 0; // `wait` mit after=seq sieht nur, was nach dem Prompt passiert
        s.sendPrompt(b.text, { enter: b.enter !== false });
        mgr.pushFeed(`${s.entry.name} · Prompt von ${nameOf(b.from) || 'aioc-ctl'}: ${oneLine(b.text, 60)}`);
        mgr.persistAndBroadcast();
        return json(res, 200, { ...describe(s), seq });
      }

      case 'POST /api/keys': {
        const b = await readBody(req);
        const s = mgr.resolve(b.session);
        if (!Array.isArray(b.keys) || !b.keys.length) throw httpError(400, 'keys fehlt');
        const seq = s.entry.statusSeq || 0;
        s.sendKeys(b.keys.map(String));
        mgr.pushFeed(`${s.entry.name} · Tasten von ${nameOf(b.from) || 'aioc-ctl'}: ${oneLine(b.keys.join(' '), 60)}`);
        mgr.persistAndBroadcast();
        return json(res, 200, { ...describe(s), seq });
      }

      case 'GET /api/wait': {
        const s = mgr.resolve(q.get('session'));
        const until = new Set((q.get('until') || DEFAULT_UNTIL.join(',')).split(',').map(x => x.trim()).filter(Boolean));
        for (const u of until) if (!STATES.includes(u)) throw httpError(400, `Unbekannter Status „${u}" (erlaubt: ${STATES.join(', ')})`);
        const w = { id: s.entry.id, until, after: q.has('after') ? Number(q.get('after')) : -1, res };
        const timeout = Math.min(WAIT_CHUNK_MAX, Math.max(1, Number(q.get('timeout')) || WAIT_CHUNK_MAX));
        w.timer = setTimeout(() => {
          const cur = mgr.sessions.get(w.id);
          finish(w, 200, { ...(cur ? describe(cur) : {}), timedOut: true });
        }, timeout);
        res.on('close', () => { waiters.delete(w); clearTimeout(w.timer); });
        waiters.add(w);
        checkWaiters(); // schon erfuellt? dann sofort antworten
        return undefined;
      }

      default:
        throw httpError(404, `Unbekannter Aufruf: ${req.method} ${url.pathname}`);
    }
  }

  function handle(req, res, url) {
    // Nur lokal - auch nicht ueber den LAN-Listener, selbst wenn man ihn von 127.0.0.1 aus anspricht
    if (!isLoopback(req) || req.socket.encrypted) return json(res, 403, { error: 'Die Steuer-API ist nur lokal erreichbar' });
    if (!authorized(req)) return json(res, 401, { error: 'Token fehlt oder ist falsch' });
    route(req, res, url).catch(err => json(res, err.status || 500, { error: err.message }));
    return undefined;
  }

  return { handle, checkWaiters };
}

module.exports = { createApi, STATES };
