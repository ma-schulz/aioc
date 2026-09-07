// Aioc UI client: sidebar + xterm.js terminals in 1/2/4 panes (each with its own header),
// connected to the daemon via WebSocket. Works locally (Electron) and from another machine.
/* global Terminal, FitAddon, WebglAddon, SearchAddon, WebLinksAddon, Unicode11Addon */
(() => {
  const params = new URLSearchParams(location.search);
  let token = params.get('token') || '';
  try {
    if (token) localStorage.setItem('aioc-token', token);
    else token = localStorage.getItem('aioc-token') || '';
  } catch {}
  const $ = id => document.getElementById(id);
  if (token) $('manifestlink').href = '/manifest.webmanifest?token=' + encodeURIComponent(token);
  const MOBILE = window.matchMedia('(max-width: 700px)');

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
  // Bild in der Zwischenablage: der Agent liest sie selbst, sobald er "seine" Taste bekommt
  // (verifiziert 31.08.2026: Claude Code = Alt+V, Codex = rohes Ctrl+V).
  const IMAGE_KEY = { claude: '\x1bv', codex: '\x16', pi: '\x16' };
  // Shift+Enter = neue Zeile im Prompt (wie im Windows Terminal). xterm.js schickt dafür nur ein
  // normales Enter, deshalb die Sequenz, die der Agent versteht (verifiziert 31.08.2026):
  // Claude Code = ESC CR (wie VS-Code-/terminal-setup), Codex + Pi = CSI-u Shift+Enter.
  const NEWLINE_KEY = { claude: '\x1b\r', codex: '\x1b[13;2u', pi: '\x1b[13;2u' };
  // Läuft das Fenster auf dem Daemon-Rechner, reicht die Bild-Taste (gleiche Zwischenablage).
  // Aus der Ferne wird das Bild zum Daemon übertragen, der es dort in die Zwischenablage legt.
  const LOCAL_UI = ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);
  const WS_SCHEME = location.protocol === 'https:' ? 'wss' : 'ws';

  let ws = null, wsOk = false;
  let sessions = [], feed = [], recents = [], lan = { enabled: false, links: [] };
  let background = { url: null, opacity: 0.35 };
  // Einstellungen dieses Geräts (localStorage): Schriftgröße, Deckkraft, Layout
  let fontSize = 14, localOpacity = null, layoutRestored = false;
  try {
    fontSize = Number(localStorage.getItem('aioc-fontsize')) || 14;
    const lo = localStorage.getItem('aioc-bgopacity');
    if (lo !== null && lo !== '') localOpacity = Number(lo);
  } catch {}
  function saveLayout() {
    try { localStorage.setItem('aioc-layout', JSON.stringify({ panes: panes.map(p => p.id), focused })); } catch {}
  }
  function restoreLayout() {
    if (layoutRestored) return;
    layoutRestored = true;
    if (params.get('split')) return;
    try {
      const lay = JSON.parse(localStorage.getItem('aioc-layout') || 'null');
      if (!lay || ![1, 2, 4].includes(lay.panes?.length)) return;
      panes = lay.panes.map(id => ({ id: sessions.some(s => s.id === id) ? id : null }));
      focused = Math.min(lay.focused || 0, panes.length - 1);
    } catch {}
  }
  let filter = 'all', pendingSelectNew = false, focusedOnce = false;
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
  if (params.get('split') === '4') panes.push({ id: null }, { id: null }, { id: null });
  else if (params.get('split') === '1' || params.get('split') === '2') panes.push({ id: null });

  const activeId = () => panes[focused]?.id || null;
  const sessionOf = id => sessions.find(s => s.id === id);

  // ---------- WebSocket ----------
  function connect() {
    ws = new WebSocket(`${WS_SCHEME}://${location.host}/ws?token=${encodeURIComponent(token)}`);
    ws.onopen = () => { wsOk = true; renderConn(); };
    ws.onclose = () => {
      wsOk = false; renderConn();
      for (const t of terms.values()) t.attached = false;
      setTimeout(connect, 1500);
    };
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.t === 'hello' || m.t === 'sessions') {
        sessions = m.sessions; feed = m.feed || []; recents = m.recents || recents; lan = m.lan || lan;
        if (m.background && (m.background.url !== background.url || m.background.opacity !== background.opacity)) {
          background = m.background;
          applyBackground();
        }
        if (pendingSelectNew && sessions.length) {
          const newest = [...sessions].sort((a, b) => b.createdAt - a.createdAt)[0];
          pendingSelectNew = false;
          panes[focused].id = newest.id;
          requestAnimationFrame(() => terms.get(newest.id)?.term.focus());
        }
        if (m.t === 'hello') restoreLayout();
        for (const p of panes) if (p.id && !sessionOf(p.id)) p.id = null;
        if (!activeId() && sessions.length && panes.length === 1 && !MOBILE.matches) panes[0].id = sessions[0].id;
        // Geteilt gestartet (?split=…) und noch leer: die ersten Sessions auf die Panes verteilen
        if (m.t === 'hello' && panes.length > 1 && panes.every(p => !p.id)) {
          sessions.slice(0, panes.length).forEach((s, i) => { panes[i].id = s.id; });
        }
        // Erster Verbindungsaufbau: Tastaturfokus ins aktive Terminal, sonst wirken Tippen und
        // Strg+V erst nach einem Klick ins Terminal (Start, neue Session, Wiederherstellen).
        if (m.t === 'hello' && !focusedOnce) {
          focusedOnce = true;
          if (!MOBILE.matches) requestAnimationFrame(() => { const id = activeId(); if (id) terms.get(id)?.term.focus(); });
        }
        renderAll();
        for (const p of panes) if (p.id) ensureAttached(p.id);
        fitAll(); // neu zugewiesene Panes sofort an die echte Größe anpassen
      } else if (m.t === 'snapshot') {
        const t = terms.get(m.id);
        if (t) { t.term.reset(); if (m.data) t.term.write(m.data); }
      } else if (m.t === 'data') {
        const t = terms.get(m.id);
        if (t) t.term.write(m.d);
      } else if (m.t === 'gone') {
        dropTerm(m.id);
        for (const p of panes) if (p.id === m.id) p.id = null;
        saveLayout();
        renderAll();
      }
    };
  }
  function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

  // ---------- Hintergrundbild ----------
  // Mit Bild wird der Terminal-Hintergrund durchsichtig; das Bild liegt als Ebene unter den Panes.
  const themeFor = () => ({ ...THEME, background: background.url ? 'rgba(12, 12, 12, 0)' : THEME.background });
  const effectiveOpacity = () => (localOpacity ?? background.opacity);
  function applyBackground() {
    const host = $('panes');
    host.classList.toggle('has-bg', !!background.url);
    host.style.setProperty('--bgimg', background.url ? `url("${background.url}")` : 'none');
    host.style.setProperty('--bgopacity', String(effectiveOpacity()));
    for (const t of terms.values()) t.term.options.theme = themeFor();
    $('bgopacity').value = String(Math.round(effectiveOpacity() * 100));
    $('bgopacityval').textContent = Math.round(effectiveOpacity() * 100) + ' %';
    $('bgclear').hidden = !background.url;
    $('fontsize').value = String(fontSize);
    $('fontsizeval').textContent = fontSize + ' px';
  }
  function applyFontSize() {
    for (const t of terms.values()) t.term.options.fontSize = fontSize;
    $('fontsizeval').textContent = fontSize + ' px';
    fitAll();
  }
  $('fontsize').addEventListener('input', () => {
    fontSize = Number($('fontsize').value) || 14;
    try { localStorage.setItem('aioc-fontsize', String(fontSize)); } catch {}
    applyFontSize();
  });
  $('settingsbtn').addEventListener('click', () => { const p = $('settings'); p.hidden = !p.hidden; });
  document.addEventListener('mousedown', e => {
    const p = $('settings');
    if (!p.hidden && !p.contains(e.target) && e.target !== $('settingsbtn')) p.hidden = true;
    const q = $('lanqr');
    if (!q.hidden && !q.contains(e.target) && !e.target.closest('#lan')) q.hidden = true;
  });
  $('bgfile').addEventListener('change', () => {
    const file = $('bgfile').files[0];
    if (!file) return;
    if (file.size > 30 * 1024 * 1024) { alert('Bild ist größer als 30 MB.'); return; }
    const fr = new FileReader();
    fr.onload = () => send({ t: 'background', mime: file.type, data: String(fr.result).split(',')[1] || '' });
    fr.readAsDataURL(file);
    $('bgfile').value = '';
  });
  $('bgclear').addEventListener('click', () => send({ t: 'backgroundClear' }));
  $('bgopacity').addEventListener('input', () => {
    localOpacity = Number($('bgopacity').value) / 100; // Deckkraft gilt nur für dieses Gerät
    try { localStorage.setItem('aioc-bgopacity', String(localOpacity)); } catch {}
    applyBackground();
  });

  // ---------- Terminals ----------
  function ensureTerm(id) {
    let t = terms.get(id);
    if (t) return t;
    const wrap = document.createElement('div');
    wrap.className = 'termwrap';
    const term = new Terminal({
      allowProposedApi: true, allowTransparency: true, fontSize, scrollback: 8000, theme: themeFor(),
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
      if (ev.key === 'Enter' && ev.shiftKey && !ev.ctrlKey && !ev.altKey) {
        const nl = NEWLINE_KEY[sessionOf(id)?.agent];
        if (nl) { send({ t: 'input', id, d: nl }); return false; }
        return true;
      }
      if (ev.ctrlKey && !ev.shiftKey && ev.key === 'c' && term.hasSelection()) {
        navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
        term.clearSelection();
        return false;
      }
      // Ctrl+V / Shift+Insert: return false ist Pflicht - bei true wuerde xterm die Taste zum
      // Steuerzeichen 0x16 (Ctrl+V) an das PTY schicken UND preventDefault() aufrufen, womit das
      // native paste-Ereignis des Browsers nie feuert und der Text der Zwischenablage verloren geht
      // (bei manchen Agenten loest 0x16 zusaetzlich noch deren Bild-Einfuegen aus). false laesst
      // xterm die Taste unangetastet: der Browser loest das native paste-Ereignis auf der
      // xterm-Textarea aus, xterm fuegt den Text einmal als Bracketed Paste ein. Parallel prueft
      // Aioc die Zwischenablage auf ein Bild und reicht es an den Agenten weiter.
      if ((ev.ctrlKey && !ev.shiftKey && ev.key === 'v') || (ev.shiftKey && ev.key === 'Insert')) {
        checkClipboardImage(id);
        return false;
      }
      if (ev.ctrlKey && ev.shiftKey && ev.key === 'C') {
        if (term.hasSelection()) navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
        return false;
      }
      if (ev.ctrlKey && ev.shiftKey && (ev.key === 'F' || ev.key === 'N' || ev.key === 'R')) return false;
      if (ev.key === 'F2') return false; // Umbenennen
      if (ev.altKey && ev.shiftKey && (ev.key === 'D' || ev.key === 'd')) return false;
      if (ev.altKey && !ev.ctrlKey && !ev.shiftKey && ev.key.startsWith('Arrow')) return false; // Pane-Fokus
      if (ev.ctrlKey && !ev.shiftKey && ev.key >= '1' && ev.key <= '9') return false;
      return true;
    });
    // Claude-Vollbild: Rad -> PageUp/PageDown (= halbe Bildschirmhoehe je Schritt, scroll:pageUp).
    // Claudes Windows-Build reagiert in dieser ConPTY-Konstellation nicht auf SGR-Maus-Sequenzen,
    // und alle feineren Tasten-Kandidaten (Ctrl/Alt+Pfeile, Ctrl+PageUp, ...) erreichen den
    // Scroll-Kontext nicht - empirisch verifiziert am 31.08.2026, siehe Memory.
    let wheelAcc = 0;
    wrap.addEventListener('wheel', ev => {
      const s = sessionOf(id);
      if (!s || s.agent !== 'claude' || term.buffer.active.type !== 'alternate') return;
      ev.preventDefault();
      ev.stopPropagation();
      wheelAcc += ev.deltaY;
      const STEP = 200; // 2 Rad-Rasten je halber Bildschirm
      while (wheelAcc <= -STEP) { send({ t: 'input', id, d: '\x1b[5~' }); wheelAcc += STEP; }
      while (wheelAcc >= STEP) { send({ t: 'input', id, d: '\x1b[6~' }); wheelAcc -= STEP; }
    }, { capture: true, passive: false });
    // Touch-Wischen (Handy/Tablet): Apps mit Maus-Tracking (Claude-Vollbild) bekommen Rad-Ereignisse,
    // sonst scrollt xterm.js seinen Puffer selbst.
    let touchY = null;
    wrap.addEventListener('touchstart', e => { touchY = e.touches[0]?.clientY ?? null; }, { passive: true });
    wrap.addEventListener('touchmove', e => {
      if (touchY === null || term.modes.mouseTrackingMode === 'none') return;
      const y = e.touches[0].clientY;
      const step = 24; // px je Rad-Tick
      while (Math.abs(y - touchY) >= step) {
        const dir = y > touchY ? -1 : 1; // nach unten wischen = Inhalt nach oben scrollen
        wrap.querySelector('.xterm-screen')?.dispatchEvent(new WheelEvent('wheel', { deltaY: dir * 100, clientX: e.touches[0].clientX, clientY: y, bubbles: true, cancelable: true }));
        touchY += dir * -step;
      }
      e.preventDefault();
    }, { passive: false });
    wrap.addEventListener('touchend', () => { touchY = null; }, { passive: true });
    // Rechtsklick wie im Windows Terminal: Auswahl kopieren, sonst einfügen
    wrap.addEventListener('contextmenu', e => {
      e.preventDefault();
      if (term.hasSelection()) {
        navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
        term.clearSelection();
      } else pasteInto(id);
    });
    t = { term, fit, search, wrap, attached: false };
    terms.set(id, t);
    return t;
  }

  // Einfügen: Text geht als (bracketed) Paste ins Terminal; ein Bild bekommt der Agent über
  // seine Bild-Taste und liest es selbst aus der System-Zwischenablage des Daemon-Rechners.
  async function pasteInto(id) {
    const s = sessionOf(id);
    const t = terms.get(id);
    if (!t) return;
    let imageBlob = null, text = '';
    try {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const imgType = it.types.find(ty => ty.startsWith('image/'));
        if (imgType && !imageBlob) imageBlob = await it.getType(imgType);
        if (it.types.includes('text/plain')) text = await (await it.getType('text/plain')).text();
      }
    } catch {
      try { text = await navigator.clipboard.readText(); } catch {}
    }
    const imgKey = s && IMAGE_KEY[s.agent];
    if (imageBlob && imgKey) { pasteImage(id, imageBlob); return; }
    if (text) { t.term.paste(text); return; }
    if (imgKey && LOCAL_UI) send({ t: 'input', id, d: imgKey }); // kein Text lesbar: vermutlich ein Bild
  }

  // Bei Ctrl+V: liegt ein Bild in der Zwischenablage, an den Agenten geben (Text macht der Browser)
  async function checkClipboardImage(id) {
    try {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const imgType = it.types.find(ty => ty.startsWith('image/'));
        if (imgType) { pasteImage(id, await it.getType(imgType)); return; }
      }
    } catch { /* keine Berechtigung o. ae.: dann nur Text via natives Paste */ }
  }

  async function pasteImage(id, blob) {
    const s = sessionOf(id);
    const imgKey = s && IMAGE_KEY[s.agent];
    if (!imgKey || !blob) return;
    if (LOCAL_UI) { send({ t: 'input', id, d: imgKey }); return; }
    const data = await new Promise(resolve => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
      fr.onerror = () => resolve('');
      fr.readAsDataURL(blob);
    });
    if (data) send({ t: 'image', id, mime: blob.type, data });
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

  // Zuletzt gemessene Pane-Größe: neue Sessions werden damit gestartet, damit die erste
  // Ausgabe schon in der richtigen Breite ankommt (statt 120x32-Standard + späterem Umbruch).
  const lastSize = { cols: 120, rows: 32 };
  function fitPane(i) {
    const id = panes[i]?.id;
    if (!id) return;
    const t = terms.get(id);
    if (!t || !t.wrap.classList.contains('active')) return;
    try {
      t.fit.fit();
      const { cols, rows } = t.term;
      if (cols > 10 && rows > 3) { lastSize.cols = cols; lastSize.rows = rows; }
      if (t.sentCols !== cols || t.sentRows !== rows) {
        t.sentCols = cols; t.sentRows = rows;
        send({ t: 'resize', id, cols, rows });
      }
    } catch {}
  }
  const fitAll = () => requestAnimationFrame(() => panes.forEach((_, i) => fitPane(i)));

  function assignToPane(paneIdx, id) {
    // Session ist schon in einem anderen Pane sichtbar: dorthin fokussieren statt sie zu verschieben
    const shownIn = panes.findIndex(p => p.id === id);
    if (shownIn >= 0 && shownIn !== paneIdx) {
      focused = shownIn;
      saveLayout();
      renderAll();
      requestAnimationFrame(() => terms.get(id)?.term.focus());
      const s0 = sessionOf(id);
      if (s0 && s0.unread) send({ t: 'markRead', id });
      return;
    }
    panes[paneIdx].id = id;
    focused = paneIdx;
    saveLayout();
    ensureAttached(id);
    if (MOBILE.matches) document.body.classList.add('show-term'); // Handy: Terminal statt Liste zeigen
    renderAll();
    fitAll();
    requestAnimationFrame(() => terms.get(id)?.term.focus());
    const s = sessionOf(id);
    if (s && s.unread) send({ t: 'markRead', id });
  }

  // Alt+Pfeil: Fokus zwischen den Panes bewegen (Raster: 1, 2 nebeneinander oder 2x2), wie im Windows Terminal
  function moveFocus(dir) {
    if (panes.length < 2) return;
    const cols = panes.length === 4 ? 2 : panes.length;
    const rows = panes.length === 4 ? 2 : 1;
    let r = Math.floor(focused / cols), c = focused % cols;
    if (dir === 'ArrowLeft') c--; else if (dir === 'ArrowRight') c++;
    else if (dir === 'ArrowUp') r--; else if (dir === 'ArrowDown') r++;
    if (c < 0 || c >= cols || r < 0 || r >= rows) return;
    focused = r * cols + c;
    renderAll();
    const id = panes[focused].id;
    if (id) requestAnimationFrame(() => terms.get(id)?.term.focus());
  }

  // 1 Pane -> 2 nebeneinander -> 2x2 -> zurück auf 1 (die fokussierte Session bleibt)
  function toggleSplit() {
    if (panes.length === 1) {
      panes.push({ id: null });
      focused = 1;
    } else if (panes.length === 2) {
      panes.push({ id: null }, { id: null });
      focused = 2;
    } else {
      panes = [{ id: panes[focused]?.id || null }];
      focused = 0;
    }
    saveLayout();
    renderAll();
    fitAll();
  }

  // ---------- Rendering ----------
  function renderConn() {
    const c = $('conn');
    c.textContent = wsOk ? '' : 'Verbindung getrennt – verbinde neu …';
    c.classList.toggle('off', !wsOk);
  }

  function renderLan() {
    const el = $('lan');
    el.innerHTML = '';
    if (lan.enabled) {
      const link = lan.links[0] || '';
      const lbl = document.createElement('span');
      lbl.className = 'lan-on';
      lbl.textContent = 'LAN an';
      lbl.title = 'Andere Geräte erreichen Aioc über:\n' + lan.links.join('\n') + '\n\nFirewall: node.exe muss auf Port ' + lan.port + ' eingehend erlaubt sein.';
      el.appendChild(lbl);
      if (link) {
        const code = document.createElement('code');
        code.textContent = link.replace(/\?token=.*$/, '?…');
        code.title = link;
        el.appendChild(code);
        const copy = document.createElement('button');
        copy.className = 'btn';
        copy.textContent = 'Link kopieren';
        copy.title = 'Verbindungslink (mit Token und Zertifikats-Fingerprint) in die Zwischenablage';
        copy.addEventListener('click', () => {
          navigator.clipboard?.writeText(link).then(() => { copy.textContent = 'Kopiert ✓'; setTimeout(() => (copy.textContent = 'Link kopieren'), 1500); }).catch(() => {});
        });
        el.appendChild(copy);
      }
      if (lan.qr) {
        const qr = document.createElement('button');
        qr.className = 'btn';
        qr.textContent = 'QR fürs Handy';
        qr.addEventListener('click', () => {
          const p = $('lanqr');
          p.hidden = !p.hidden;
          if (!p.hidden) { $('lanqrimg').innerHTML = lan.qr; $('lanqrlink').textContent = link; $('settings').hidden = true; }
        });
        el.appendChild(qr);
      }
      const off = document.createElement('button');
      off.className = 'btn';
      off.textContent = 'LAN aus';
      off.addEventListener('click', () => send({ t: 'lan', enabled: false }));
      el.appendChild(off);
    } else {
      const on = document.createElement('button');
      on.className = 'btn dim';
      on.textContent = 'LAN an';
      on.title = 'Zugriff aus dem Netzwerk per HTTPS/WSS freigeben (Token + Zertifikats-Fingerprint im Link)';
      on.addEventListener('click', () => send({ t: 'lan', enabled: true }));
      el.appendChild(on);
    }
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
        const badge = isCol ? inGrp.map(x => (x.status === 'waiting' ? '?' : x.unread ? '●' : '')).join('') : '';
        g.innerHTML = `<span class="arr">${isCol ? '▸' : '▾'}</span>`;
        g.append(grp);
        if (badge) {
          const b = document.createElement('span');
          b.className = 'badge'; b.textContent = badge;
          g.appendChild(b);
        }
        g.addEventListener('click', () => {
          if (collapsed.has(g.title)) collapsed.delete(g.title); else collapsed.add(g.title);
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
      b.querySelector('.st').title = s.detail || '';
      b.addEventListener('click', () => assignToPane(focused, s.id));
      b.addEventListener('dblclick', () => { assignToPane(focused, s.id); renamePrompt(s.id); });
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
    renderLan();
    $('recents').innerHTML = recents.map(r => `<option value="${r.replaceAll('"', '&quot;')}">`).join('');
  }

  // Jedes Pane: eigene Kopfzeile (Name, Agent, Ordner, Session, Aktionen) + Terminalbereich
  function buildPane(host) {
    const el = document.createElement('div');
    el.className = 'pane';
    el.innerHTML = `
      <div class="phead">
        <button class="btn back" title="Zurück zur Liste">‹ Liste</button>
        <span class="nm" title="Doppelklick: umbenennen"></span>
        <span class="ag"></span>
        <span class="cwd"></span>
        <span class="sid"></span>
        <span class="lim" title="Ein anderer Client zeigt diese Session gerade kleiner an – die kleinste Ansicht bestimmt die Terminalgröße"></span>
        <span class="sp"></span>
        <button class="btn b-restore" hidden>Wiederherstellen</button>
        <button class="btn b-rename">Umbenennen</button>
        <button class="btn danger b-close" hidden>Schließen</button>
        <button class="btn danger b-dispose" hidden>Entfernen</button>
      </div>
      <div class="pane-body">
        <div class="pane-empty"><div><h2>Keine Session</h2><p>Links eine Session wählen oder mit <b>+ Neu</b> starten.</p></div></div>
      </div>`;
    const idOf = () => panes[[...host.children].indexOf(el)]?.id;
    el.addEventListener('mousedown', () => {
      const idx = [...host.children].indexOf(el);
      if (idx >= 0 && idx !== focused) { focused = idx; renderAll(); }
    }, true);
    el.querySelector('.back').addEventListener('click', () => { document.body.classList.remove('show-term'); renderAll(); });
    el.querySelector('.b-rename').addEventListener('click', () => renamePrompt(idOf()));
    el.querySelector('.nm').addEventListener('dblclick', () => renamePrompt(idOf()));
    el.querySelector('.b-close').addEventListener('click', () => {
      const s = sessionOf(idOf());
      if (s && confirm(`„${s.name}" läuft noch – Prozess wirklich beenden?`)) send({ t: 'close', id: s.id });
    });
    el.querySelector('.b-dispose').addEventListener('click', () => {
      const s = sessionOf(idOf());
      if (s && confirm(`„${s.name}" samt Scrollback aus der Liste entfernen?`)) send({ t: 'dispose', id: s.id });
    });
    el.querySelector('.b-restore').addEventListener('click', () => {
      const id = idOf();
      const t = id && terms.get(id);
      if (id) send({ t: 'restore', id, cols: t?.term.cols || lastSize.cols, rows: t?.term.rows || lastSize.rows });
    });
    return el;
  }

  function renderPanes() {
    const host = $('panes');
    host.classList.toggle('split', panes.length > 1);
    host.classList.toggle('split4', panes.length === 4);
    while (host.children.length < panes.length) host.appendChild(buildPane(host));
    while (host.children.length > panes.length) host.lastChild.remove();

    panes.forEach((p, i) => {
      const el = host.children[i];
      el.classList.toggle('focused', i === focused);
      const s = sessionOf(p.id);
      const head = el.querySelector('.phead');
      const body = el.querySelector('.pane-body');
      head.hidden = !s;
      body.querySelector('.pane-empty').style.display = s ? 'none' : 'flex';
      if (s) {
        const nm = head.querySelector('.nm');
        if (!nm.querySelector('input')) nm.textContent = s.name;
        head.querySelector('.ag').textContent = s.agent;
        head.querySelector('.cwd').textContent = s.cwd;
        head.querySelector('.sid').textContent = s.agentSessionId ? 'session ' + String(s.agentSessionId).slice(0, 8) + '…' : '';
        head.querySelector('.lim').textContent = s.sizeInfo?.limitedBy ? '⧉ Größe: ' + s.sizeInfo.limitedBy : '';
        head.querySelector('.b-close').hidden = !s.running;
        head.querySelector('.b-restore').hidden = !!s.running;
        head.querySelector('.b-restore').textContent = s.agent === 'pwsh' ? 'Neu starten' : (s.agentSessionId ? 'Wiederherstellen' : 'Neu starten');
        head.querySelector('.b-dispose').hidden = !!s.running;
        const t = ensureAttached(s.id);
        if (t.wrap.parentElement !== body) body.appendChild(t.wrap);
      }
    });
    for (const [id, t] of terms) {
      const shown = panes.some(p => p.id === id);
      t.wrap.classList.toggle('active', shown);
      // Nicht mehr angezeigte Sessions loslassen: ihre Groessenvorgabe faellt beim Daemon sofort weg
      if (!shown && t.attached) { t.attached = false; t.sentCols = t.sentRows = undefined; send({ t: 'detach', id }); }
    }
  }

  // Inline-Umbenennen in der Kopfzeile des Panes (window.prompt gibt es in Electron nicht)
  function renamePrompt(id) {
    const s = sessionOf(id);
    if (!s) return;
    const idx = panes.findIndex(p => p.id === id);
    const nm = idx >= 0 && $('panes').children[idx]?.querySelector('.phead .nm');
    if (!nm || nm.querySelector('input')) return;
    const input = document.createElement('input');
    input.className = 'rename';
    input.value = s.name;
    input.setAttribute('aria-label', 'Neuer Name');
    nm.textContent = '';
    nm.appendChild(input);
    input.focus();
    input.select();
    let finished = false;
    const finish = commit => {
      if (finished) return;
      finished = true;
      const val = input.value.trim();
      if (commit && val && val !== s.name) send({ t: 'rename', id: s.id, name: val });
      nm.textContent = commit && val ? val : s.name;
      terms.get(s.id)?.term.focus();
    };
    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
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
    send({ t: 'create', agent: dlgAgent, cwd, name: $('f-name').value.trim(), args: $('f-args').value.trim(), cols: lastSize.cols, rows: lastSize.rows });
  });
  $('f-cancel').addEventListener('click', () => $('newdlg').close());
  $('newbtn').addEventListener('click', openNew);
  $('restoreall').addEventListener('click', () => send({ t: 'restoreAll', cols: lastSize.cols, rows: lastSize.rows }));

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
  // Klicks auf Bedienelemente (Sidebar, Kopfzeilen, Chips, Einstellungen) nehmen den Tastaturfokus
  // von der xterm-Textarea weg; danach landen Tippen und Strg+V im Nirgendwo. Jeder Klick gibt
  // den Fokus ans aktive Terminal zurueck - ausser in offene Eingabefelder und modale Dialoge.
  document.addEventListener('click', () => {
    if (MOBILE.matches || document.querySelector('dialog[open]')) return;
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA') && !ae.classList.contains('xterm-helper-textarea')) return;
    const id = activeId();
    if (id) terms.get(id)?.term.focus();
  });
  window.addEventListener('keydown', e => {
    const ae = document.activeElement;
    const inField = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA') && !ae.classList.contains('xterm-helper-textarea');
    if (!inField && (e.key === 'F2' || (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'r'))) {
      e.preventDefault();
      if (activeId()) renamePrompt(activeId());
      return;
    }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); openNew(); return; }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); toggleSearch(); return; }
    if (e.altKey && e.shiftKey && e.key.toLowerCase() === 'd') { e.preventDefault(); toggleSplit(); return; }
    if (e.altKey && !e.ctrlKey && !e.shiftKey && e.key.startsWith('Arrow')) { e.preventDefault(); moveFocus(e.key); return; }
    if (e.ctrlKey && !e.shiftKey && e.key >= '1' && e.key <= '9') {
      const b = document.querySelector(`.sess[data-n="${e.key}"]`);
      if (b) { e.preventDefault(); b.click(); }
    }
  }, true);

  new ResizeObserver(() => fitAll()).observe($('panes'));

  // ---------- Sidebar-Breite (ziehbar, gemerkt) ----------
  const root = document.documentElement;
  try {
    const w = parseInt(localStorage.getItem('aioc-sidew'), 10);
    if (w >= 180 && w <= 700) root.style.setProperty('--sidew', w + 'px');
  } catch {}
  const resizer = $('resizer');
  resizer.addEventListener('pointerdown', e => {
    e.preventDefault();
    resizer.setPointerCapture(e.pointerId);
    resizer.classList.add('drag');
    let w = 300;
    const move = ev => {
      w = Math.min(700, Math.max(180, Math.round(ev.clientX)));
      root.style.setProperty('--sidew', w + 'px');
      fitAll();
    };
    const up = () => {
      resizer.classList.remove('drag');
      resizer.removeEventListener('pointermove', move);
      resizer.removeEventListener('pointerup', up);
      try { localStorage.setItem('aioc-sidew', String(w)); } catch {}
    };
    resizer.addEventListener('pointermove', move);
    resizer.addEventListener('pointerup', up);
  });
  resizer.addEventListener('dblclick', () => {
    root.style.setProperty('--sidew', '300px');
    try { localStorage.setItem('aioc-sidew', '300'); } catch {}
    fitAll();
  });

  connect();
})();
