// Aioc UI client: sidebar + one xterm.js terminal per session, connected to the daemon via WS.
/* global Terminal, FitAddon, WebglAddon, SearchAddon, WebLinksAddon, Unicode11Addon */
(() => {
  const token = new URLSearchParams(location.search).get('token') || '';
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

  let ws = null, wsOk = false;
  let sessions = [], feed = [], recents = [];
  let activeId = null, filter = 'all', pendingSelectNew = false;
  const terms = new Map(); // id -> {term, fit, search, wrap, attached}

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
          pendingSelectNew = false; activeId = newest.id;
        }
        if (activeId && !sessions.some(s => s.id === activeId)) activeId = null;
        if (!activeId && sessions.length) activeId = sessions[0].id;
        renderAll();
        if (activeId) ensureAttached(activeId);
      } else if (m.t === 'snapshot') {
        const t = terms.get(m.id);
        if (t) { t.term.reset(); if (m.data) t.term.write(m.data); }
      } else if (m.t === 'data') {
        const t = terms.get(m.id);
        if (t) t.term.write(m.d);
      } else if (m.t === 'gone') {
        dropTerm(m.id);
        if (activeId === m.id) activeId = null;
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
    $('termhost').appendChild(wrap);
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
      if (ev.ctrlKey && ev.shiftKey && (ev.key === 'C')) {
        if (term.hasSelection()) navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
        return false;
      }
      if (ev.ctrlKey && ev.shiftKey && (ev.key === 'F' || ev.key === 'N')) return false; // app shortcuts
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

  function fitActive() {
    if (!activeId) return;
    const t = terms.get(activeId);
    if (!t || !t.wrap.classList.contains('active')) return;
    try {
      t.fit.fit();
      send({ t: 'resize', id: activeId, cols: t.term.cols, rows: t.term.rows });
    } catch {}
  }

  function select(id) {
    activeId = id;
    const t = ensureAttached(id);
    for (const [tid, tt] of terms) tt.wrap.classList.toggle('active', tid === id);
    renderAll();
    requestAnimationFrame(() => { fitActive(); t.term.focus(); });
    const s = sessions.find(x => x.id === id);
    if (s && s.unread) send({ t: 'markRead', id });
  }

  // ---------- Rendering ----------
  function renderConn() {
    const c = $('conn');
    c.textContent = wsOk ? '' : 'Verbindung getrennt – verbinde neu …';
    c.classList.toggle('off', !wsOk);
  }

  function visibleSessions() { return sessions.filter(FILTERS[filter] || FILTERS.all); }

  function renderAll() {
    // counts
    const c = { waiting: 0, running: 0, done: 0 };
    for (const s of sessions) {
      if (s.status === 'waiting') c.waiting++;
      else if (s.status === 'running' || s.status === 'starting') c.running++;
      else if (s.status === 'done') c.done++;
    }
    $('counts').innerHTML =
      `<span><b>${c.waiting}</b> wartet</span><span><b>${c.running}</b> läuft</span><span><b>${c.done}</b> fertig</span>`;
    document.title = c.waiting ? `(${c.waiting}!) Aioc` : 'Aioc';

    // chips
    document.querySelectorAll('.chip').forEach(ch => ch.setAttribute('aria-pressed', ch.dataset.f === filter ? 'true' : 'false'));

    // restore all
    const restorable = sessions.filter(s => !s.running);
    $('restoreall-wrap').hidden = restorable.length < 2;

    // list
    const list = $('list');
    list.innerHTML = '';
    let grp = null;
    visibleSessions().forEach((s, i) => {
      if (s.cwd !== grp) {
        grp = s.cwd;
        const g = document.createElement('div');
        g.className = 'grp'; g.textContent = grp; g.title = grp;
        list.appendChild(g);
      }
      const b = document.createElement('button');
      b.className = `sess ${s.status}${s.unread ? ' unread' : ''}`;
      b.setAttribute('aria-current', s.id === activeId ? 'true' : 'false');
      if (i < 9) b.title = `Ctrl+${i + 1}`;
      b.innerHTML = `<span class="ic"></span><span class="nm"></span><span class="ag"></span><span class="st"></span>`;
      b.querySelector('.ic').textContent = ICON[s.status] || '·';
      b.querySelector('.nm').textContent = s.name;
      b.querySelector('.ag').textContent = s.agent;
      b.querySelector('.st').textContent = s.detail || '';
      b.addEventListener('click', () => select(s.id));
      list.appendChild(b);
    });

    // events feed
    const ev = $('events');
    ev.innerHTML = '<div class="h">Zuletzt</div>' + feed.map(f => {
      const d = new Date(f.t);
      const hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0');
      const el = document.createElement('div');
      el.innerHTML = `<span class="t">${hh}:${mm}</span>`;
      el.append(f.text);
      return el.outerHTML;
    }).join('');

    // header + terminal visibility
    const s = sessions.find(x => x.id === activeId);
    $('phead').hidden = !s;
    $('empty').style.display = s ? 'none' : 'flex';
    for (const [tid, tt] of terms) tt.wrap.classList.toggle('active', s && tid === s.id);
    if (s) {
      $('p-nm').textContent = s.name;
      $('p-ag').textContent = s.agent;
      $('p-cwd').textContent = s.cwd;
      $('p-sid').textContent = s.agentSessionId ? 'session ' + String(s.agentSessionId).slice(0, 8) + '…' : '';
      $('b-close').hidden = !s.running;
      $('b-restore').hidden = !!s.running;
      $('b-restore').textContent = s.agent === 'pwsh' ? 'Neu starten' : (s.agentSessionId ? 'Wiederherstellen' : 'Neu starten');
      $('b-dispose').hidden = !!s.running;
    }

    // recents datalist
    $('recents').innerHTML = recents.map(r => `<option value="${r.replaceAll('"', '&quot;')}">`).join('');
  }

  // ---------- New-session dialog ----------
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

  // ---------- Header actions ----------
  $('b-rename').addEventListener('click', renamePrompt);
  $('p-nm').addEventListener('dblclick', renamePrompt);
  function renamePrompt() {
    const s = sessions.find(x => x.id === activeId);
    if (!s) return;
    const name = prompt('Neuer Name:', s.name);
    if (name) send({ t: 'rename', id: s.id, name });
  }
  $('b-close').addEventListener('click', () => {
    const s = sessions.find(x => x.id === activeId);
    if (s && confirm(`„${s.name}" läuft noch – Prozess wirklich beenden?`)) send({ t: 'close', id: s.id });
  });
  $('b-dispose').addEventListener('click', () => {
    const s = sessions.find(x => x.id === activeId);
    if (s && confirm(`„${s.name}" samt Scrollback aus der Liste entfernen?`)) send({ t: 'dispose', id: s.id });
  });
  $('b-restore').addEventListener('click', () => { if (activeId) send({ t: 'restore', id: activeId }); });
  $('restoreall').addEventListener('click', () => send({ t: 'restoreAll' }));

  // ---------- Filter chips ----------
  document.querySelectorAll('.chip').forEach(ch =>
    ch.addEventListener('click', () => { filter = ch.dataset.f; renderAll(); }));

  // ---------- Search ----------
  function toggleSearch(show) {
    const bar = $('searchbar');
    bar.hidden = show === undefined ? !bar.hidden : !show;
    if (!bar.hidden) $('searchinput').focus();
    else if (activeId) terms.get(activeId)?.term.focus();
  }
  $('searchinput').addEventListener('keydown', e => {
    const t = activeId && terms.get(activeId);
    if (!t) return;
    if (e.key === 'Enter') { e.shiftKey ? t.search.findPrevious($('searchinput').value) : t.search.findNext($('searchinput').value); e.preventDefault(); }
    if (e.key === 'Escape') toggleSearch(false);
  });

  // ---------- Global keys ----------
  window.addEventListener('keydown', e => {
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); openNew(); return; }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); toggleSearch(); return; }
    if (e.ctrlKey && !e.shiftKey && e.key >= '1' && e.key <= '9') {
      const vis = visibleSessions();
      const s = vis[Number(e.key) - 1];
      if (s) { e.preventDefault(); select(s.id); }
    }
  }, true);

  // ---------- Resize ----------
  new ResizeObserver(() => fitActive()).observe($('termhost'));

  connect();
})();
