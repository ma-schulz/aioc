// Aioc UI client: sidebar + xterm.js terminals, one or two panes (Split), connected via WS.
/* global Terminal, FitAddon, WebglAddon, SearchAddon, WebLinksAddon, Unicode11Addon */
(() => {
  const params = new URLSearchParams(location.search);
  const token = params.get('token') || '';
  const $ = id => document.getElementById(id);

  const THEME = {
    background: '#0C0C0C', foreground: '#CCCCCC', cursor: '#FFFFFF', selectionBackground: '#264F78',
    black: '#0C0C0C', red: '#C50F1F', green: '#13A10E', yellow: '#C19C00', blue: '#0037DA',
    magenta: '#881798', cyan: '#3A96DD', white: '#CCCCCC', brightBlack: '#767676', brightRed: '#E74856',
    brightGreen: '#16C60C', brightYellow: '#F9F1A5', brightBlue: '#3B78FF', brightMagenta: '#B4009E',
    brightCyan: '#61D6D6', brightWhite: '#F2F2F2',
  };
  const ICON = { running: '◐', starting: '◌', waiting: '?', done: '✓', idle: '○', exited: '■' };
  const FILTERS = {
    all: () => true,
    waiting: s => s.status === 'waiting',
    running: s => s.status === 'running' || s.status === 'starting',
    done: s => s.status === 'done',
  };
  const STATUS_ORDER = { waiting: 0, running: 1, starting: 1, done: 2, idle: 3, exited: 4 };

  let ws = null, wsOk = false;
  let sessions = [], feed = [], recents = [];
  let filter = 'all', pendingSelectNew = false;
  let panes = [{ id: null }], focused = 0;
  const terms = new Map(); // id -> {term, fit, search, wrap, attached}

  let sortMode = 'ordner', collapsed = new Set();
  try { sortMode = localStorage.getItem('aioc-sort') || 'ordner'; } catch {}
  try { collapsed = new Set(JSON.parse(localStorage.getItem('aioc-collapsed') || '[]')); } catch {}
  const persistLocal = () => {
    try {
      localStorage.setItem('aioc-sort', sortMode);
      localStorage.setItem('aioc-collapsed', JSON.stringify([...collapsed]));
    } catch {}
  };
  if (params.get('split') === '1') { panes.push({ id: null }); }

  const activeId = () => panes[focused]?.id || null;
  const sessionOf = id => sessions.find(s => s.id === id);

  // ---------- WebSocket ----------
  function connect() {
    ws = new WebSocket(`ws://${location.host}/ws?token=${encodeURIComponent(token)}`);
    ws.onopen = () => { wsOk = true; renderConn(); };
    ws.onclose = () => {
      wsOk = false; renderConn();
      for (const t of terms.values()) t.attached = false;
      setTimeout(connect, 1500);
    };
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.t === 'hello' || m.t === 'sessions') {
        sessions = m.sessions; feed = m.feed || []; recents = m.recents || recents;
        if (pendingSelectNew && sessions.length) {
          const newest = [...sessions].sort((a, b) => b.createdAt - a.createdAt)[0];
          pendingSelectNew = false;
          panes[focused].id = newest.id;
        }
        for (const p of panes) if (p.id && !sessionOf(p.id)) p.id = null;
        if (!activeId() && sessions.length && panes.length === 1) panes[0].id = sessions[0].id;
        renderAll();
        for (const p of panes) if (p.id) ensureAttached(p.id);
      } else if (m.t === 'snapshot') {
        const t = terms.get(m.id);
        if (t) { t.term.reset(); if (m.data) t.term.write(m.data); }
      } else if (m.t === 'data') {
        const t = terms.get(m.id);
        if (t) t.term.write(m.d);
      } else if (m.t === 'gone') {
        dropTerm(m.id);
        for (const p of panes) if (p.id === m.id) p.id = null;
        renderAll();
      }
    };
  }
  function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

  // ---------- Terminals ----------
  function ensureTerm(id) {
    let t = terms.get(id);
    if (t) return t;
    const wrap = document.createElement('div');
    wrap.className = 'termwrap';
    const term = new Terminal({
      allowProposedApi: true, fontSize: 14, scrollback: 8000, theme: THEME,
      fontFamily: '"MesloLGM Nerd Font", "MesloLGM NF", "Cascadia Mono", Consolas, monospace',
    });
    const fit = new FitAddon.FitAddon();
    const search = new SearchAddon.SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(new WebLinksAddon.WebLinksAddon((e, uri) => window.open(uri, '_blank')));
    try { term.loadAddon(new Unicode11Addon.Unicode11Addon()); term.unicode.activeVersion = '11'; } catch {}
    term.open(wrap);
    try { term.loadAddon(new WebglAddon.WebglAddon()); } catch {}
    term.onData(d => send({ t: 'input', id, d }));
    term.attachCustomKeyEventHandler(ev => {
      if (ev.type !== 'keydown') return true;
      if (ev.ctrlKey && !ev.shiftKey && ev.key === 'c' && term.hasSelection()) {
        navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
        term.clearSelection();
        return false;
      }
      if (ev.ctrlKey && !ev.shiftKey && ev.key === 'v') {
        navigator.clipboard?.readText().then(txt => { if (txt) send({ t: 'input', id, d: txt }); }).catch(() => {});
        return false;
      }
      if (ev.ctrlKey && ev.shiftKey && ev.key === 'C') {
        if (term.hasSelection()) navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
        return false;
      }
      if (ev.ctrlKey && ev.shiftKey && (ev.key === 'F' || ev.key === 'N')) return false;
      if (ev.altKey && ev.shiftKey && (ev.key === 'D' || ev.key === 'd')) return false;
      if (ev.ctrlKey && !ev.shiftKey && ev.key >= '1' && ev.key <= '9') return false;
      return true;
    });
    t = { term, fit, search, wrap, attached: false };
    terms.set(id, t);
    return t;
  }

  function dropTerm(id) {
    const t = terms.get(id);
    if (!t) return;
    try { t.term.dispose(); } catch {}
    t.wrap.remove();
    terms.delete(id);
  }

  function ensureAttached(id) {
    const t = ensureTerm(id);
    if (!t.attached && wsOk) { t.attached = true; send({ t: 'attach', id }); }
    return t;
  }

  function fitPane(i) {
    const id = panes[i]?.id;
    if (!id) return;
    const t = terms.get(id);
    if (!t || !t.wrap.classList.contains('active')) return;
    try {
      t.fit.fit();
      send({ t: 'resize', id, cols: t.term.cols, rows: t.term.rows });
    } catch {}
  }
  const fitAll = () => requestAnimationFrame(() => panes.forEach((_, i) => fitPane(i)));

  function assignToPane(paneIdx, id) {
    for (let i = 0; i < panes.length; i++) if (i !== paneIdx && panes[i].id === id) panes[i].id = null;
    panes[paneIdx].id = id;
    focused = paneIdx;
    ensureAttached(id);
    renderAll();
    fitAll();
    requestAnimationFrame(() => terms.get(id)?.term.focus());
    const s = sessionOf(id);
    if (s && s.unread) send({ t: 'markRead', id });
  }

  function toggleSplit() {
    if (panes.length === 1) {
      panes.push({ id: null });
      focused = 1;
    } else {
      panes.pop();
      focused = 0;
    }
    renderAll();
    fitAll();
  }

  // ---------- Rendering ----------
  function renderConn() {
    const c = $('conn');
    c.textContent = wsOk ? '' : 'Verbindung getrennt – verbinde neu …';
    c.classList.toggle('off', !wsOk);
  }

  function sortedSessions() {
    const list = sessions.filter(FILTERS[filter] || FILTERS.all);
    if (sortMode === 'status') {
      return [...list].sort((a, b) =>
        (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) ||
        a.cwd.toLowerCase().localeCompare(b.cwd.toLowerCase()) || a.createdAt - b.createdAt);
    }
    return list; // Server liefert bereits nach Ordner + Erstellzeit sortiert
  }

  function renderAll() {
    const c = { waiting: 0, running: 0, done: 0 };
    for (const s of sessions) {
      if (s.status === 'waiting') c.waiting++;
      else if (s.status === 'running' || s.status === 'starting') c.running++;
      else if (s.status === 'done') c.done++;
    }
    $('counts').innerHTML =
      `<span><b>${c.waiting}</b> wartet</span><span><b>${c.running}</b> läuft</span><span><b>${c.done}</b> fertig</span>`;
    document.title = c.waiting ? `(${c.waiting}!) Aioc` : 'Aioc';

    document.querySelectorAll('.chip[data-f]').forEach(ch => ch.setAttribute('aria-pressed', ch.dataset.f === filter ? 'true' : 'false'));
    $('sortbtn').textContent = sortMode === 'status' ? '⇅ Status' : '⇅ Ordner';

    $('restoreall-wrap').hidden = sessions.filter(s => !s.running).length < 2;

    // Sidebar-Liste
    const list = $('list');
    list.innerHTML = '';
    const vis = sortedSessions();
    const byGroup = sortMode === 'ordner';
    let grp = null;
    let shortcut = 0;
    vis.forEach(s => {
      if (byGroup && s.cwd !== grp) {
        grp = s.cwd;
        const inGrp = vis.filter(x => x.cwd === grp);
        const g = document.createElement('button');
        g.className = 'grp';
        g.title = grp;
        const isCol = collapsed.has(grp);
        const badge = isCol
          ? inGrp.map(x => (x.status === 'waiting' ? '?' : x.unread ? '●' : '')).join('')
          : '';
        g.innerHTML = `<span class="arr">${isCol ? '▸' : '▾'}</span>`;
        g.append(grp);
        if (badge) {
          const b = document.createElement('span');
          b.className = 'badge'; b.textContent = badge;
          g.appendChild(b);
        }
        g.addEventListener('click', () => {
          collapsed.has(grp === g.title ? grp : g.title) ? collapsed.delete(g.title) : collapsed.add(g.title);
          persistLocal(); renderAll();
        });
        list.appendChild(g);
      }
      if (byGroup && collapsed.has(s.cwd)) return;
      shortcut++;
      const b = document.createElement('button');
      b.className = `sess ${s.status}${s.unread ? ' unread' : ''}`;
      b.setAttribute('aria-current', panes.some(p => p.id === s.id) ? 'true' : 'false');
      if (shortcut <= 9) b.title = `Ctrl+${shortcut}`;
      b.dataset.n = shortcut;
      b.innerHTML = `<span class="ic"></span><span class="nm"></span><span class="ag"></span><span class="st"></span>`;
      b.querySelector('.ic').textContent = ICON[s.status] || '·';
      b.querySelector('.nm').textContent = s.name;
      b.querySelector('.ag').textContent = s.agent;
      b.querySelector('.st').textContent = s.detail || '';
      b.addEventListener('click', () => assignToPane(focused, s.id));
      list.appendChild(b);
    });

    // Ereignisliste
    $('events').innerHTML = '<div class="h">Zuletzt</div>' + feed.map(f => {
      const d = new Date(f.t);
      const hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0');
      const el = document.createElement('div');
      el.innerHTML = `<span class="t">${hh}:${mm}</span>`;
      el.append(f.text);
      return el.outerHTML;
    }).join('');

    renderPanes();
    renderHead();
    $('recents').innerHTML = recents.map(r => `<option value="${r.replaceAll('"', '&quot;')}">`).join('');
  }

  function renderPanes() {
    const host = $('panes');
    host.classList.toggle('split', panes.length > 1);
    // Pane-Elemente angleichen
    while (host.children.length < panes.length) {
      const el = document.createElement('div');
      el.className = 'pane';
      el.addEventListener('mousedown', () => {
        const idx = [...host.children].indexOf(el);
        if (idx >= 0 && idx !== focused) { focused = idx; renderAll(); }
      }, true);
      host.appendChild(el);
    }
    while (host.children.length > panes.length) host.lastChild.remove();

    panes.forEach((p, i) => {
      const el = host.children[i];
      el.classList.toggle('focused', i === focused);
      let empty = el.querySelector('.pane-empty');
      if (!empty) {
        empty = document.createElement('div');
        empty.className = 'pane-empty';
        empty.innerHTML = '<div><h2>Keine Session</h2><p>Links eine Session wählen oder mit <b>+ Neu</b> starten.</p></div>';
        el.appendChild(empty);
      }
      empty.style.display = p.id ? 'none' : 'flex';
      if (p.id) {
        const t = ensureAttached(p.id);
        if (t.wrap.parentElement !== el) el.appendChild(t.wrap);
      }
    });
    // Sichtbarkeit: nur wraps aktiver Pane-Zuordnungen
    for (const [id, t] of terms) t.wrap.classList.toggle('active', panes.some(p => p.id === id));
  }

  function renderHead() {
    const s = sessionOf(activeId());
    $('phead').hidden = !s;
    if (!s) return;
    $('p-nm').textContent = s.name;
    $('p-ag').textContent = s.agent;
    $('p-cwd').textContent = s.cwd;
    $('p-sid').textContent = s.agentSessionId ? 'session ' + String(s.agentSessionId).slice(0, 8) + '…' : '';
    $('b-close').hidden = !s.running;
    $('b-restore').hidden = !!s.running;
    $('b-restore').textContent = s.agent === 'pwsh' ? 'Neu starten' : (s.agentSessionId ? 'Wiederherstellen' : 'Neu starten');
    $('b-dispose').hidden = !!s.running;
  }

  // ---------- Neue Session ----------
  let dlgAgent = 'claude';
  function openNew() {
    $('f-cwd').value = recents[0] || '';
    $('f-name').value = '';
    $('f-args').value = '';
    $('newdlg').showModal();
    $('f-cwd').focus();
  }
  $('agentseg').addEventListener('click', e => {
    const b = e.target.closest('button[data-a]');
    if (!b) return;
    dlgAgent = b.dataset.a;
    document.querySelectorAll('#agentseg button').forEach(x => x.classList.toggle('on', x === b));
  });
  $('newform').addEventListener('submit', () => {
    const cwd = $('f-cwd').value.trim();
    if (!cwd) return;
    pendingSelectNew = true;
    send({ t: 'create', agent: dlgAgent, cwd, name: $('f-name').value.trim(), args: $('f-args').value.trim() });
  });
  $('f-cancel').addEventListener('click', () => $('newdlg').close());
  $('newbtn').addEventListener('click', openNew);

  // ---------- Kopfzeilen-Aktionen ----------
  $('b-rename').addEventListener('click', renamePrompt);
  $('p-nm').addEventListener('dblclick', renamePrompt);
  function renamePrompt() {
    const s = sessionOf(activeId());
    if (!s) return;
    const name = prompt('Neuer Name:', s.name);
    if (name) send({ t: 'rename', id: s.id, name });
  }
  $('b-close').addEventListener('click', () => {
    const s = sessionOf(activeId());
    if (s && confirm(`„${s.name}" läuft noch – Prozess wirklich beenden?`)) send({ t: 'close', id: s.id });
  });
  $('b-dispose').addEventListener('click', () => {
    const s = sessionOf(activeId());
    if (s && confirm(`„${s.name}" samt Scrollback aus der Liste entfernen?`)) send({ t: 'dispose', id: s.id });
  });
  $('b-restore').addEventListener('click', () => { if (activeId()) send({ t: 'restore', id: activeId() }); });
  $('restoreall').addEventListener('click', () => send({ t: 'restoreAll' }));

  // ---------- Filter + Sortierung ----------
  document.querySelectorAll('.chip[data-f]').forEach(ch =>
    ch.addEventListener('click', () => { filter = ch.dataset.f; renderAll(); }));
  $('sortbtn').addEventListener('click', () => {
    sortMode = sortMode === 'ordner' ? 'status' : 'ordner';
    persistLocal(); renderAll();
  });

  // ---------- Suche ----------
  function toggleSearch(show) {
    const bar = $('searchbar');
    bar.hidden = show === undefined ? !bar.hidden : !show;
    if (!bar.hidden) $('searchinput').focus();
    else if (activeId()) terms.get(activeId())?.term.focus();
  }
  $('searchinput').addEventListener('keydown', e => {
    const t = activeId() && terms.get(activeId());
    if (!t) return;
    if (e.key === 'Enter') { e.shiftKey ? t.search.findPrevious($('searchinput').value) : t.search.findNext($('searchinput').value); e.preventDefault(); }
    if (e.key === 'Escape') toggleSearch(false);
  });

  // ---------- Globale Tasten ----------
  window.addEventListener('keydown', e => {
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); openNew(); return; }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); toggleSearch(); return; }
    if (e.altKey && e.shiftKey && e.key.toLowerCase() === 'd') { e.preventDefault(); toggleSplit(); return; }
    if (e.ctrlKey && !e.shiftKey && e.key >= '1' && e.key <= '9') {
      const b = document.querySelector(`.sess[data-n="${e.key}"]`);
      if (b) { e.preventDefault(); b.click(); }
    }
  }, true);

  new ResizeObserver(() => fitAll()).observe($('panes'));

  connect();
})();
