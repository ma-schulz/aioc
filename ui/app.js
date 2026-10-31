// Aioc UI client: sidebar + xterm.js terminals in freely split panes (each with its own header),
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
  const IMAGE_KEY = { claude: '\x1bv', codex: '\x16', agy: '\x16', pi: '\x16' };
  // xterm.js reduziert Strg/Shift+Enter beide auf ein normales Enter. Damit der Agent den Modifier
  // erhaelt, senden wir die Sequenz selbst: Claude braucht fuer Shift+Enter weiter ESC CR
  // (wie VS-Code-/terminal-setup), Codex + agy + Pi verstehen CSI-u. Strg+Enter verstehen alle als CSI-u.
  const MODIFIED_ENTER_KEY = {
    shift: { claude: '\x1b\r', codex: '\x1b[13;2u', agy: '\x1b[13;2u', pi: '\x1b[13;2u' },
    ctrl: { claude: '\x1b[13;5u', codex: '\x1b[13;5u', agy: '\x1b[13;5u', pi: '\x1b[13;5u' },
  };
  // Läuft das Fenster auf dem Daemon-Rechner, reicht die Bild-Taste (gleiche Zwischenablage).
  // Aus der Ferne wird das Bild zum Daemon übertragen, der es dort in die Zwischenablage legt.
  const LOCAL_UI = ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);
  const WS_SCHEME = location.protocol === 'https:' ? 'wss' : 'ws';

  // Links im Standardbrowser des Rechners oeffnen (dort sind die Logins, nicht im Electron-Fenster).
  // Browser-/PWA-Fenster machen einen neuen Tab; im Electron-Fenster stellt die Preload-Bruecke
  // (shell/preload.js) window.aioc.openExternal bereit.
  const openExternal = uri => {
    if (window.aioc?.openExternal) window.aioc.openExternal(uri);
    else window.open(uri, '_blank');
  };
  // xterm.js oeffnet OSC-8-Links selbst ueber window.open() + location.href - im Electron-Fenster
  // waere das ein zweites Aioc-Fenster ohne Cookies. window.open wird deshalb ersetzt: direkte
  // URLs gehen extern auf, und das zurueckgegebene Pseudo-Fenster leitet auch location.href um.
  if (window.aioc?.openExternal) {
    const fakeLocation = new Proxy({}, { set: (t, p, v) => { if (p === 'href' && typeof v === 'string') openExternal(v); return true; } });
    window.open = url => {
      if (typeof url === 'string' && url) openExternal(url);
      return { location: fakeLocation, opener: null, closed: true, close() {}, focus() {} };
    };
  }

  let ws = null, wsOk = false;
  let sessions = [], feed = [], recents = [], lan = { enabled: false, links: [] };
  let konten = []; // Claude-Konten (Konfigurationsordner mit eigener Anmeldung), siehe claude-accounts.js
  // Plugins (daemon/plugins.js): ihre Ansicht steht im Pane-Layout als Pseudo-Session "@plugin:<id>"
  const PLUGIN_PREFIX = '@plugin:';
  const pluginOf = id => (typeof id === 'string' && id.startsWith(PLUGIN_PREFIX) ? id.slice(PLUGIN_PREFIX.length) : null);
  let plugins = []; // [{ id, name, icon, ui, css, state }] vom Daemon
  const pluginDefs = new Map(); // id -> Definition aus der ui.js des Plugins (AiocPlugins.register)
  const pluginViews = new Map(); // id -> { el, mounted, dirty }
  const hasPlugin = id => plugins.some(p => p.id === id);
  let background = { url: null, opacity: 0.35 };
  // Einstellungen dieses Geräts (localStorage): Schriftgröße, Deckkraft, Layout
  let fontSize = 14, localOpacity = null, layoutRestored = false;
  try {
    fontSize = Number(localStorage.getItem('aioc-fontsize')) || 14;
    const lo = localStorage.getItem('aioc-bgopacity');
    if (lo !== null && lo !== '') localOpacity = Number(lo);
  } catch {}
  function saveLayout() {
    try { localStorage.setItem('aioc-layout', JSON.stringify({ tree: serTree(tree), focused, zoom: zoomed ? panes.indexOf(zoomed) : -1 })); } catch {}
  }
  function restoreLayout() {
    if (layoutRestored) return;
    layoutRestored = true;
    if (params.get('split')) return;
    try {
      const lay = JSON.parse(localStorage.getItem('aioc-layout') || 'null');
      // Altes Format (bis 09/2026): festes Raster mit 1, 2 oder 4 Panes
      const t = lay?.tree ? deserTree(lay.tree) : [1, 2, 4].includes(lay?.panes?.length) ? gridTree(lay.panes) : null;
      if (!t) return;
      for (const leaf of leavesOf(t)) if (!(pluginOf(leaf.id) ? hasPlugin(pluginOf(leaf.id)) : sessions.some(s => s.id === leaf.id))) leaf.id = null;
      tree = t;
      panes = leavesOf(tree);
      focused = Math.min(Math.max(0, lay.focused || 0), panes.length - 1);
      zoomed = panes.length > 1 && lay.zoom >= 0 ? panes[lay.zoom] || null : null;
      layoutDirty = true;
    } catch {}
  }
  let filter = 'all', pendingSelectNew = false, focusedOnce = false;
  const terms = new Map(); // id -> {term, fit, search, wrap, attached}

  // ---------- Layout: Baum aus Splits ----------
  // Blatt = ein Pane { id, el }, Split = { dir: 'row' (nebeneinander) | 'col' (untereinander), ratio, a, b }.
  // panes ist die flache Liste der Blätter in Baumreihenfolge, focused ein Index darin.
  const MAX_PANES = 9;
  const isLeaf = n => !n.dir;
  const clampRatio = r => Math.min(0.9, Math.max(0.1, Number(r) || 0.5));
  function leavesOf(n, acc = []) {
    if (isLeaf(n)) acc.push(n);
    else { leavesOf(n.a, acc); leavesOf(n.b, acc); }
    return acc;
  }
  const serTree = n => (isLeaf(n) ? { id: n.id } : { dir: n.dir, ratio: n.ratio, a: serTree(n.a), b: serTree(n.b) });
  function deserTree(o) {
    if (o && (o.dir === 'row' || o.dir === 'col')) return { dir: o.dir, ratio: clampRatio(o.ratio), a: deserTree(o.a), b: deserTree(o.b) };
    return { id: typeof o?.id === 'string' ? o.id : null };
  }
  function gridTree(ids) {
    const leaf = i => ({ id: ids[i] ?? null });
    if (ids.length === 4) return { dir: 'col', ratio: 0.5, a: { dir: 'row', ratio: 0.5, a: leaf(0), b: leaf(1) }, b: { dir: 'row', ratio: 0.5, a: leaf(2), b: leaf(3) } };
    if (ids.length === 2) return { dir: 'row', ratio: 0.5, a: leaf(0), b: leaf(1) };
    return leaf(0);
  }
  function replaceNode(n, target, repl) {
    if (n === target) return repl;
    if (!isLeaf(n)) { n.a = replaceNode(n.a, target, repl); n.b = replaceNode(n.b, target, repl); }
    return n;
  }
  function parentOf(n, target) {
    if (isLeaf(n)) return null;
    if (n.a === target || n.b === target) return n;
    return parentOf(n.a, target) || parentOf(n.b, target);
  }
  const splitParam = params.get('split');
  let tree = gridTree(splitParam === '4' ? [null, null, null, null] : splitParam === '1' || splitParam === '2' ? [null, null] : [null]);
  let panes = leavesOf(tree), focused = 0, zoomed = null, layoutDirty = true, builtRoot = null;

  // Alt+Shift+Plus/Minus: auf deutscher Tastatur ist Shift+"+" ein "*" - deshalb auch am
  // Windows-Tastencode (VK_OEM_PLUS 187 / VK_OEM_MINUS 189) und am Ziffernblock erkennen
  const isPlus = e => e.key === '+' || e.keyCode === 187 || e.code === 'NumpadAdd';
  const isMinus = e => e.key === '-' || e.key === '_' || e.keyCode === 189 || e.code === 'NumpadSubtract';
  const paneKey = e => e.altKey && e.shiftKey && !e.ctrlKey && (isPlus(e) || isMinus(e) || /^[dzw]$/i.test(e.key));

  // Ctrl+1…0 waehlt die ersten zehn Sessions der Liste, mit Shift die Plaetze 11–20. Die Ziffer kommt
  // aus e.code, denn auf deutscher Tastatur liefert Shift+1 ein "!". AltGr (= Ctrl+Alt) bleibt frei,
  // sonst kaemen { [ ] } nicht mehr ins Terminal.
  const sessionShortcut = e => {
    if (!e.ctrlKey || e.altKey || e.getModifierState?.('AltGraph')) return null;
    const m = /^(?:Digit|Numpad)(\d)$/.exec(e.code || '');
    if (!m) return null;
    const d = Number(m[1]);
    return (d === 0 ? 10 : d) + (e.shiftKey ? 10 : 0);
  };

  let sortMode = 'ordner', collapsed = new Set();
  try { sortMode = localStorage.getItem('aioc-sort') || 'ordner'; } catch {}
  if (!['ordner', 'status', 'typ'].includes(sortMode)) sortMode = 'ordner';
  try { collapsed = new Set(JSON.parse(localStorage.getItem('aioc-collapsed') || '[]')); } catch {}
  const persistLocal = () => {
    try {
      localStorage.setItem('aioc-sort', sortMode);
      localStorage.setItem('aioc-collapsed', JSON.stringify([...collapsed]));
    } catch {}
  };
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
        notifyChanges(m.sessions, m.t === 'hello'); // vor dem Überschreiben: alter Status je Session
        sessions = m.sessions; feed = m.feed || []; recents = m.recents || recents; lan = m.lan || lan;
        if (m.t === 'hello') {
          plugins = Array.isArray(m.plugins) ? m.plugins : []; loadPluginAssets();
          konten = Array.isArray(m.konten) ? m.konten : [];
        }
        for (const v of pluginViews.values()) v.dirty = true; // Plugins zeigen oft den Stand ihrer Sessions
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
        for (const p of panes) if (p.id && !(pluginOf(p.id) ? hasPlugin(pluginOf(p.id)) : sessionOf(p.id))) p.id = null;
        if (!activeId() && sessions.length && panes.length === 1 && !MOBILE.matches) {
          const next = sortedSessions()[0] || sessions.find(s => !s.owner) || sessions[0];
          if (next) panes[0].id = next.id;
        }
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
        for (const p of panes) if (p.id && !pluginOf(p.id)) ensureAttached(p.id);
        fitAll(); // neu zugewiesene Panes sofort an die echte Größe anpassen
        focusActiveTerm();
      } else if (m.t === 'plugin') {
        const p = plugins.find(x => x.id === m.id);
        if (p) {
          p.state = m.state;
          const v = pluginViews.get(p.id);
          if (v) v.dirty = true;
          renderAll();
        }
      } else if (m.t === 'konten') {
        konten = Array.isArray(m.konten) ? m.konten : [];
        renderKonten(true);
      } else if (m.t === 'error') {
        flashError(m.message);
      } else if (m.t === 'snapshot') {
        const t = terms.get(m.id);
        if (t) {
          t.term.reset();
          if (m.data) {
            t.term.write(m.data, () => {
              if (t.term.modes.mouseTrackingMode !== 'none' && t.term._core?.coreMouseService?.activeEncoding === 'DEFAULT') {
                t.term.write('\x1b[?1006h');
              }
            });
          }
        }
      } else if (m.t === 'data') {
        const t = terms.get(m.id);
        if (t) t.term.write(m.d);
      } else if (m.t === 'gone') {
        dropTerm(m.id);
        for (const p of panes) if (p.id === m.id) p.id = null;
        if (!activeId() && sessions.length && panes.length === 1 && !MOBILE.matches) {
          const next = sortedSessions().find(s => s.id !== m.id) || sessions.find(s => s.id !== m.id && !s.owner) || sessions.find(s => s.id !== m.id);
          if (next) panes[0].id = next.id;
        }
        for (const p of panes) if (p.id && !pluginOf(p.id)) ensureAttached(p.id);
        fitAll();
        focusActiveTerm();
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
  // ---------- Benachrichtigungen ----------
  // Gemeldet werden die Wechsel nach "Rückfrage" und nach "fertig" - aber nur, wenn das Fenster nicht
  // im Vordergrund ist oder die Session nicht zu sehen ist. Im Electron-Fenster macht Windows daraus
  // einen Toast (AppUserModelID setzt shell/main.js), im Browser meldet der Browser. Chrome auf Android
  // verbietet den Notification-Konstruktor (TypeError) - dort geht die Meldung über den Service Worker.
  let notifyOn = true;
  try { notifyOn = localStorage.getItem('aioc-toasts') !== '0'; } catch {}
  const lastStatus = new Map();
  const NOTIFY = {
    waiting: s => [`${s.name} · wartet auf dich`, s.detail || 'Rückfrage'],
    done: s => [`${s.name} · fertig`, s.detail || 'fertig'],
  };

  function updateNotifyHint() {
    const blocked = typeof Notification === 'undefined' || Notification.permission === 'denied';
    $('toastshint').textContent = blocked
      ? 'Dieses Fenster darf keine Benachrichtigungen zeigen – bitte im Browser bzw. in den Windows-Einstellungen erlauben.'
      : 'Meldet Rückfragen und fertige Sessions – nur wenn Aioc im Hintergrund liegt oder die Session in keinem Pane offen ist.';
  }

  async function askNotifyPermission() {
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') await Notification.requestPermission();
    } catch {}
    updateNotifyHint();
  }

  // Klick auf eine Service-Worker-Meldung, als Aioc nicht offen war: der SW startet es mit ?open=<id>
  let openOnStart = params.get('open');
  if (openOnStart) {
    params.delete('open');
    const rest = params.toString();
    history.replaceState(null, '', location.pathname + (rest ? '?' + rest : '') + location.hash);
  }

  function openFromNotification(id) {
    window.aioc?.focusWindow?.();
    window.focus();
    if (sessionOf(id)) assignToPane(focused, id);
  }

  // Auf dem Handy ist nur das fokussierte Pane zu sehen - und auch das nur, solange nicht die Liste offen ist
  const isShown = id => (MOBILE.matches
    ? document.body.classList.contains('show-term') && activeId() === id
    : panes.some(p => p.id === id));

  function showNotification(title, body, id) {
    const tag = 'aioc-' + id; // neue Meldung ersetzt die alte je Session
    try {
      const n = new Notification(title, { body, tag });
      n.onclick = () => { openFromNotification(id); n.close(); };
      return;
    } catch { /* Android: nur über den Service Worker */ }
    navigator.serviceWorker?.getRegistration()
      .then(reg => reg?.active && reg.showNotification(title, { body, tag, renotify: true, icon: '/icon-192.png', data: { id } }))
      .catch(() => {});
  }

  function notifyChanges(next, first) {
    if (first && openOnStart) {
      const id = openOnStart;
      openOnStart = null;
      setTimeout(() => openFromNotification(id)); // erst wenn Sessions und Layout übernommen sind
    }
    for (const s of next) {
      const before = lastStatus.get(s.id);
      lastStatus.set(s.id, s.status);
      // Beim ersten Stand nichts melden, sonst käme beim Öffnen für jede fertige Session ein Toast
      if (first || before === undefined || before === s.status) continue;
      if (!notifyOn || !NOTIFY[s.status]) continue;
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') continue;
      if (document.hasFocus() && isShown(s.id)) continue; // liegt sichtbar vor dir
      const [title, body] = NOTIFY[s.status](s);
      showNotification(title, body, s.id);
    }
    for (const id of [...lastStatus.keys()]) if (!next.some(s => s.id === id)) lastStatus.delete(id);
  }

  // Klick auf eine Service-Worker-Meldung bei offenem Fenster (ui/sw.js schickt die Session)
  navigator.serviceWorker?.addEventListener('message', e => {
    if (e.data?.t === 'open' && e.data.id) openFromNotification(e.data.id);
  });

  $('toasts').checked = notifyOn;
  $('toasts').addEventListener('change', () => {
    notifyOn = $('toasts').checked;
    try { localStorage.setItem('aioc-toasts', notifyOn ? '1' : '0'); } catch {}
    if (notifyOn) askNotifyPermission(); // der Klick ist die Geste, die der Browser dafür verlangt
  });
  if (notifyOn) askNotifyPermission();
  updateNotifyHint();

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
    if (file.size > 30 * 1024 * 1024) { flashError('Bild ist größer als 30 MB.'); return; }
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
  // Handy-Tastaturen (Gboard & Co.) schreiben per Wortbildung, Autokorrektur und Vorschlag in das
  // versteckte Eingabefeld von xterm und melden ihre Tasten nur als keyCode 229. xterm rechnet die
  // Änderung dann per value.replace(alt, '') aus: ersetzt ein Vorschlag ein früheres Wort, steckt der
  // alte Text nicht mehr im neuen, und xterm schickt den ganzen Inhalt seit dem letzten Enter noch
  // einmal. Auf Touch-Geräten übernimmt Aioc diese Eingaben: Feldinhalt mit dem schon Gesendeten
  // vergleichen, Rückschritte bis zur ersten Abweichung, dann der neue Rest. Echte Tasten (Enter,
  // Esc, Hardware-Tastatur) verarbeitet weiter xterm - danach fängt das Feld leer von vorn an.
  const COARSE_POINTER = window.matchMedia('(pointer: coarse)');
  function installTouchInput(wrap, term) {
    const ta = wrap.querySelector('.xterm-helper-textarea');
    if (!ta) return;
    let sent = ''; // Inhalt des Eingabefelds, der schon beim Terminal angekommen ist
    let composing = false;
    const resync = () => setTimeout(() => { sent = ta.value; }, 0);
    // Eine echte Taste schickt xterm, ohne dass sie im Feld landet - danach passt das Feld nicht mehr
    // zur Terminalzeile, also frisch anfangen (nicht mitten in einer Wortbildung)
    const restart = () => setTimeout(() => { if (!composing) ta.value = ''; sent = ta.value; }, 0);
    // Capture am Wrapper: läuft vor den Listenern, die xterm am Eingabefeld selbst hat
    const listen = (type, fn) => wrap.addEventListener(type, ev => {
      if (COARSE_POINTER.matches && ev.target === ta) fn(ev);
    }, true);
    listen('compositionstart', ev => { composing = true; ev.stopPropagation(); });
    listen('compositionupdate', ev => ev.stopPropagation());
    listen('compositionend', ev => { composing = false; ev.stopPropagation(); });
    listen('keydown', ev => {
      if (ev.keyCode === 229 || ev.key === 'Unidentified') ev.stopPropagation(); // der Text folgt als input
      else restart();
    });
    listen('paste', resync); // Einfügen schickt xterm selbst und leert das Feld danach
    listen('blur', resync);
    listen('input', ev => {
      ev.stopPropagation();
      const value = ta.value;
      if (/^insertFrom/.test(ev.inputType || '')) { sent = value; return; } // Einfügen/Ziehen: schon unterwegs
      const before = [...sent], after = [...value];
      let same = 0;
      while (same < before.length && same < after.length && before[same] === after[same]) same++;
      sent = value;
      const data = '\x7f'.repeat(before.length - same) + after.slice(same).join('').replace(/\n/g, '\r');
      if (data) term.input(data);
      if (value.endsWith('\n')) { ta.value = ''; sent = ''; } // Zeilenumbruch der Tastatur = Enter
    });
  }

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
    term.loadAddon(new WebLinksAddon.WebLinksAddon((e, uri) => openExternal(uri)));
    try { term.loadAddon(new Unicode11Addon.Unicode11Addon()); term.unicode.activeVersion = '11'; } catch {}
    term.open(wrap);
    // Textauswahl immer durch xterm.js selbst statt durch die TUI des Agenten: die Agenten
    // (Claude, Codex, Pi) kopieren jede Mausauswahl sofort beim Loslassen und ueberschreiben
    // damit ungefragt die Zwischenablage. xterm.js markiert nur; kopiert wird erst bei Strg+C
    // oder Rechtsklick. Ans PTY gehen nur das Mausrad (button === 4) und echte Einzelklicks ohne
    // Textauswahl (damit Aufklappen/Artefakte in Claude, Pi und Codex weiter per Klick aufgehen);
    // mousemove/mousedrag unter ?1003h bleiben aus, weil sie sonst via onUserInput die Auswahl loeschen.
    if (term._core?._selectionService) {
      term._core._selectionService.shouldForceSelection = () => true;
      term._core._selectionService.disable = () => {};
      term._core._selectionService.enable();
    }
    if (term._core?.coreMouseService) {
      const cms = term._core.coreMouseService;
      const origTrigger = cms.triggerMouseEvent.bind(cms);
      cms.triggerMouseEvent = ev => (ev.button === 4 ? origTrigger(ev) : false);
      let clickCandidate = false;
      wrap.addEventListener('mousedown', ev => {
        clickCandidate = ev.button === 0 && ev.detail === 1 && !term.hasSelection();
      }, true);
      wrap.addEventListener('mouseup', ev => {
        if (!clickCandidate || ev.button !== 0 || term.hasSelection() || term._core?._linkifier2?.currentLink) return;
        clickCandidate = false;
        const pos = term._core._mouseService?.getMouseReportCoords(ev, term._core.screenElement);
        if (!pos) return;
        origTrigger({ col: pos.col, row: pos.row, x: pos.x, y: pos.y, button: 0, action: 1, ctrl: ev.ctrlKey, alt: ev.altKey, shift: ev.shiftKey });
        origTrigger({ col: pos.col, row: pos.row, x: pos.x, y: pos.y, button: 0, action: 0, ctrl: ev.ctrlKey, alt: ev.altKey, shift: ev.shiftKey });
      });
    }
    try { term.loadAddon(new WebglAddon.WebglAddon()); } catch {}
    term.onData(d => send({ t: 'input', id, d }));
    installTouchInput(wrap, term);
    term.attachCustomKeyEventHandler(ev => {
      if (ev.type !== 'keydown') return true;
      if (ev.key === 'Enter' && !ev.altKey && ev.shiftKey !== ev.ctrlKey) {
        const modifier = ev.shiftKey ? 'shift' : 'ctrl';
        const key = MODIFIED_ENTER_KEY[modifier][sessionOf(id)?.agent];
        if (key) { send({ t: 'input', id, d: key }); return false; }
        return true;
      }
      if (ev.ctrlKey && !ev.shiftKey && ev.key.toLowerCase() === 'c' && term.hasSelection()) {
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
      if (paneKey(ev)) return false; // Teilen, Zoom, Pane schließen
      if (ev.altKey && !ev.ctrlKey && !ev.shiftKey && ev.key.startsWith('Arrow')) return false; // Pane-Fokus
      if (sessionShortcut(ev)) return false; // Sessionwechsel gehoert Aioc, nicht dem Terminal
      return true;
    });
    // Touch-Wischen (Handy/Tablet): Apps mit Maus-Tracking bekommen Rad-Ereignisse,
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
    clearTimeout(t.resizeTimer);
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
  // Codex gibt bei jeder echten Größenänderung seinen ganzen Verlauf neu aus. Beim Ziehen von Sidebar,
  // Trennlinien oder Fenster geht die neue Größe deshalb erst an den Daemon, wenn sie zur Ruhe kommt -
  // das Terminal hier passt sich trotzdem sofort an. Die erste Größe nach dem Anhängen geht direkt raus.
  const RESIZE_SETTLE_MS = 300;
  function sendSize(id, t) {
    clearTimeout(t.resizeTimer);
    t.resizeTimer = null;
    const { cols, rows } = t.term;
    if (!t.attached || (t.sentCols === cols && t.sentRows === rows)) return;
    t.sentCols = cols; t.sentRows = rows;
    send({ t: 'resize', id, cols, rows });
  }
  function fitPane(i) {
    const id = panes[i]?.id;
    if (!id) return;
    const t = terms.get(id);
    if (!t || !t.wrap.classList.contains('active') || !t.wrap.isConnected) return; // gezoomt/Handy: nicht im Bild
    try {
      t.fit.fit();
      const { cols, rows } = t.term;
      if (cols > 10 && rows > 3) { lastSize.cols = cols; lastSize.rows = rows; }
      if (t.sentCols !== cols || t.sentRows !== rows) {
        clearTimeout(t.resizeTimer);
        if (t.sentCols === undefined) sendSize(id, t);
        else t.resizeTimer = setTimeout(() => sendSize(id, t), RESIZE_SETTLE_MS);
      }
    } catch {}
  }
  const fitAll = () => requestAnimationFrame(() => panes.forEach((_, i) => fitPane(i)));

  function assignToPane(paneIdx, id) {
    // Session ist schon in einem anderen Pane sichtbar: dorthin fokussieren statt sie zu verschieben
    const shownIn = panes.findIndex(p => p.id === id);
    if (shownIn >= 0 && shownIn !== paneIdx) {
      focused = shownIn;
      if (zoomed) zoomed = panes[shownIn]; // gezoomt: die Zoom-Ansicht wechselt mit
      if (MOBILE.matches) document.body.classList.add('show-term');
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
    if (!pluginOf(id)) ensureAttached(id);
    if (MOBILE.matches) document.body.classList.add('show-term'); // Handy: Terminal statt Liste zeigen
    renderAll();
    fitAll();
    requestAnimationFrame(() => terms.get(id)?.term.focus());
    const s = sessionOf(id);
    if (s && s.unread) send({ t: 'markRead', id });
  }

  const inInputField = () => {
    const ae = document.activeElement;
    return !!(ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT') && !ae.classList.contains('xterm-helper-textarea'));
  };
  const focusActiveTerm = () => {
    if (MOBILE.matches || document.querySelector('dialog[open]') || inInputField()) return;
    if (document.activeElement && document.activeElement.tagName !== 'BODY' && !document.activeElement.classList.contains('xterm-helper-textarea')) {
      document.activeElement.blur?.();
    }
    const id = activeId();
    if (id && !pluginOf(id)) {
      requestAnimationFrame(() => {
        if (document.querySelector('dialog[open]') || inInputField()) return;
        terms.get(id)?.term.focus();
      });
    }
  };

  // Nach jeder Strukturänderung: flache Liste neu, Fokus auf das gewünschte Blatt
  function relayout(focusLeaf) {
    panes = leavesOf(tree);
    focused = Math.max(0, panes.indexOf(focusLeaf));
    if (zoomed && !panes.includes(zoomed)) zoomed = null;
    layoutDirty = true;
    saveLayout();
    renderAll();
    focusActiveTerm();
  }

  // Alt+Pfeil: Fokus zum Nachbar-Pane in Pfeilrichtung - nach Lage auf dem Bildschirm, wie im
  // Windows Terminal. Gezoomt wird dabei erst der Zoom aufgehoben.
  function moveFocus(dir) {
    if (panes.length < 2 || MOBILE.matches) return;
    if (zoomed) { zoomed = null; layoutDirty = true; renderPanes(); }
    const cur = panes[focused].el.getBoundingClientRect();
    const horiz = dir === 'ArrowLeft' || dir === 'ArrowRight';
    let best = -1, bestScore = Infinity;
    panes.forEach((p, i) => {
      if (i === focused || !p.el?.isConnected) return;
      const r = p.el.getBoundingClientRect();
      const gap = dir === 'ArrowLeft' ? cur.left - r.right : dir === 'ArrowRight' ? r.left - cur.right
        : dir === 'ArrowUp' ? cur.top - r.bottom : r.top - cur.bottom;
      const overlap = horiz ? Math.min(r.bottom, cur.bottom) - Math.max(r.top, cur.top)
        : Math.min(r.right, cur.right) - Math.max(r.left, cur.left);
      if (gap < -3 || overlap <= 0) return; // liegt nicht in dieser Richtung oder nicht daneben
      const offset = horiz ? Math.abs(r.top + r.height / 2 - (cur.top + cur.height / 2))
        : Math.abs(r.left + r.width / 2 - (cur.left + cur.width / 2));
      const score = gap * 10000 + offset; // der nächste zuerst, bei Gleichstand der mittigste
      if (score < bestScore) { bestScore = score; best = i; }
    });
    if (best >= 0) focused = best;
    saveLayout();
    renderAll();
    focusActiveTerm();
  }

  // Fokussiertes Pane teilen: 'row' = neues Pane rechts, 'col' = darunter, 'auto' = entlang der
  // längeren Seite (wie Alt+Shift+D im Windows Terminal). Das neue Pane ist leer und hat den Fokus.
  function splitFocused(dir) {
    const leaf = panes[focused];
    if (!leaf || MOBILE.matches || panes.length >= MAX_PANES) return;
    if (zoomed) { zoomed = null; layoutDirty = true; renderPanes(); }
    if (dir === 'auto') {
      const r = leaf.el?.getBoundingClientRect();
      dir = !r || r.width >= r.height ? 'row' : 'col';
    }
    const fresh = { id: null };
    tree = replaceNode(tree, leaf, { dir, ratio: 0.5, a: leaf, b: fresh });
    relayout(fresh);
  }

  // Pane schließen betrifft nur die Ansicht: die Session läuft weiter und bleibt in der Liste
  function closePane(leaf = panes[focused]) {
    if (!leaf || panes.length < 2) return;
    const parent = parentOf(tree, leaf);
    const sibling = parent.a === leaf ? parent.b : parent.a;
    tree = replaceNode(tree, parent, sibling);
    relayout(leavesOf(sibling)[0]);
  }

  function toggleZoom() {
    if (MOBILE.matches || (panes.length < 2 && !zoomed)) return;
    zoomed = zoomed ? null : panes[focused];
    layoutDirty = true;
    saveLayout();
    renderAll();
    focusActiveTerm();
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
        copy.title = lan.trusted
          ? 'Verbindungslink (mit Token) in die Zwischenablage'
          : 'Verbindungslink (mit Token und Zertifikats-Fingerprint) in die Zwischenablage';
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
          if (!p.hidden) {
            // Vertrauenswuerdiges Zertifikat (z. B. Tailscale): kein WLAN-Zwang, keine Zertifikatswarnung
            $('lanqrhint').textContent = lan.trusted
              ? `QR-Code scannen – das Gerät muss ${lan.host} erreichen (bei Tailscale: im selben Tailnet). Dann „App installieren" bzw. „Zum Home-Bildschirm". Der Link enthält das Token, also privat halten.`
              : 'Gleiches WLAN, QR-Code scannen, Zertifikat einmal bestätigen, dann „Zum Home-Bildschirm" – der Link enthält Token und Zertifikats-Fingerprint, also privat halten.';
            $('lanqrimg').innerHTML = lan.qr; $('lanqrlink').textContent = link; $('settings').hidden = true;
          }
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
      on.title = 'Zugriff aus dem Netzwerk per HTTPS/WSS freigeben – der Verbindungslink enthält das Token';
      on.addEventListener('click', () => send({ t: 'lan', enabled: true }));
      el.appendChild(on);
    }
  }

  const AGENT_ORDER = { claude: 0, codex: 1, agy: 2, pi: 3, pwsh: 4 };
  const SORT_LABEL = { ordner: 'Ordner', status: 'Status', typ: 'Typ' };

  // Wo arbeitet die Session tatsächlich? Claude und Codex melden ihren Arbeitsordner mit jedem Hook
  // (workCwd) - er weicht vom Startordner ab, sobald ein Worker in einen anderen Worktree wechselt.
  // Maßgeblich ist die Worktree-Wurzel: ein Unterordner desselben Worktrees ist kein anderer Ort.
  // Danach richten sich Gruppe, Überschrift und Pane-Kopf - nicht nach dem Startordner.
  const normPath = p => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  function workTree(s) {
    const start = s.git?.root || s.cwd;
    let dir = start, git = s.git || null;
    if (s.workCwd) {
      const work = normPath(s.workCwd), base = normPath(start);
      if (s.workGit) { dir = s.workGit.root || s.workCwd; git = s.workGit; }
      // Git-Stand des gemeldeten Ordners noch unterwegs: ein Unterordner bleibt so lange in seiner Gruppe
      else if (work !== base && !work.startsWith(base + '/')) { dir = s.workCwd; git = null; }
    }
    return { dir, key: normPath(dir), git, moved: normPath(dir) !== normPath(start) };
  }

  // Zugeklappte Gruppen, verglichen über den normalisierten Pfad (ältere Einträge in anderer Schreibweise passen weiter)
  const isCollapsed = key => [...collapsed].some(c => normPath(c) === key);
  function toggleCollapsed(key) {
    const hits = [...collapsed].filter(c => normPath(c) === key);
    if (hits.length) hits.forEach(c => collapsed.delete(c)); else collapsed.add(key);
  }

  function sortedSessions() {
    // Sessions eines Plugins stehen oben bei ihrem Plugin, nicht in den Ordnergruppen
    const list = sessions.filter(s => !s.owner).filter(FILTERS[filter] || FILTERS.all);
    const byPlace = (a, b) => workTree(a).key.localeCompare(workTree(b).key) || (a.order ?? a.createdAt) - (b.order ?? b.createdAt);
    if (sortMode === 'status') return [...list].sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || byPlace(a, b));
    if (sortMode === 'typ') return [...list].sort((a, b) => (AGENT_ORDER[a.agent] ?? 9) - (AGENT_ORDER[b.agent] ?? 9) || byPlace(a, b));
    return [...list].sort(byPlace); // Ordneransicht: gruppiert nach dem Ort, an dem die Session wirklich arbeitet
  }

  // ---------- Sidebar: Reihenfolge per Drag ----------
  // Gezogen wird nur in der Ordner-Ansicht und nur innerhalb der eigenen Gruppe - der Ordner gehört
  // zur Session. Die Reihenfolge liegt beim Daemon, gilt also in jedem Fenster und auf jedem Gerät.
  let drag = null, renderQueued = false, suppressClick = 0;

  // Die Zeilen einer Ordnergruppe: alles zwischen zwei Überschriften
  function groupRows(el) {
    let first = el;
    while (first.previousElementSibling && !first.previousElementSibling.classList.contains('grp')) first = first.previousElementSibling;
    const rows = [];
    for (let n = first; n && !n.classList.contains('grp'); n = n.nextElementSibling) rows.push(n);
    return rows;
  }

  function startDrag(ev, el, id, fromGrip = false) {
    if (drag || (ev.pointerType === 'mouse' && ev.button !== 0)) return;
    if (!fromGrip && ev.pointerType !== 'mouse') return; // Finger: nur am Griff, sonst ließe sich die Liste nicht scrollen
    const list = $('list');
    const startY = ev.clientY;
    let active = false, moved = false;
    const begin = () => {
      active = true;
      drag = { id };
      el.classList.add('dragging');
      try { list.setPointerCapture(ev.pointerId); } catch {}
    };
    if (fromGrip) begin();
    const move = e => {
      if (!active) {
        if (Math.abs(e.clientY - startY) < 6) return; // erst ab ein paar Pixeln, sonst stört es jeden Klick
        begin();
      }
      e.preventDefault();
      const rows = groupRows(el).filter(r => r !== el);
      const before = rows.find(r => {
        const b = r.getBoundingClientRect();
        return e.clientY < b.top + b.height / 2;
      });
      if (before) {
        if (el.nextElementSibling !== before) { before.parentNode.insertBefore(el, before); moved = true; }
      } else {
        const last = rows[rows.length - 1];
        if (last && el.previousElementSibling !== last) { last.parentNode.insertBefore(el, last.nextElementSibling); moved = true; }
      }
    };
    const end = () => {
      list.removeEventListener('pointermove', move);
      list.removeEventListener('pointerup', end);
      list.removeEventListener('pointercancel', end);
      if (!active) return;
      el.classList.remove('dragging');
      drag = null;
      if (moved) {
        commitOrder(el, id);
        suppressClick = Date.now() + 300; // der Klick nach dem Ziehen soll keine Session laden
      }
      if (renderQueued) { renderQueued = false; renderAll(); }
    };
    list.addEventListener('pointermove', move);
    list.addEventListener('pointerup', end);
    list.addEventListener('pointercancel', end);
  }

  // Neuer Platz = Mitte zwischen den Nachbarn; der Daemon nummeriert die Gruppe danach durch
  function commitOrder(el, id) {
    const rows = groupRows(el);
    const i = rows.indexOf(el);
    const val = s => (typeof s?.order === 'number' ? s.order : 0);
    const prev = i > 0 ? sessionOf(rows[i - 1].dataset.id) : null;
    const next = i >= 0 && i < rows.length - 1 ? sessionOf(rows[i + 1].dataset.id) : null;
    let order;
    if (prev && next) order = (val(prev) + val(next)) / 2;
    else if (next) order = val(next) - 1000;
    else if (prev) order = val(prev) + 1000;
    else return;
    send({ t: 'order', id, order });
  }

  function renderAll() {
    if (drag) { renderQueued = true; return; } // während des Ziehens die Liste nicht neu aufbauen
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
    $('sortbtn').textContent = '⇅ ' + (SORT_LABEL[sortMode] || 'Ordner');
    $('restoreall-wrap').hidden = sessions.filter(s => !s.running).length < 2;

    // Sidebar-Liste
    const list = $('list');
    list.innerHTML = '';
    renderPluginSidebar(list);
    const vis = sortedSessions();
    const byGroup = sortMode === 'ordner';
    let grp = null;
    let shortcut = 0;
    vis.forEach(s => {
      const wtree = workTree(s);
      if (byGroup && wtree.key !== grp) {
        grp = wtree.key;
        const key = grp;
        const inGrp = vis.filter(x => workTree(x).key === key);
        const g = document.createElement('button');
        g.className = 'grp';
        g.title = wtree.dir;
        const isCol = isCollapsed(key);
        const badge = isCol ? inGrp.map(x => (x.status === 'waiting' ? '?' : x.unread ? '●' : '')).join('') : '';
        g.innerHTML = `<span class="arr">${isCol ? '▸' : '▾'}</span><span class="path"></span>`;
        g.querySelector('.path').textContent = wtree.dir;
        const br = document.createElement('span');
        br.className = 'br';
        if (fillGit(br, wtree.git)) g.appendChild(br);
        if (badge) {
          const b = document.createElement('span');
          b.className = 'badge'; b.textContent = badge;
          g.appendChild(b);
        }
        g.addEventListener('click', () => { toggleCollapsed(key); persistLocal(); renderAll(); });
        list.appendChild(g);
      }
      if (byGroup && isCollapsed(grp)) return;
      shortcut++;
      const b = document.createElement('button');
      b.className = `sess ${s.status}${s.unread ? ' unread' : ''}`;
      b.setAttribute('aria-current', panes.some(p => p.id === s.id) ? 'true' : 'false');
      if (shortcut <= 20) b.title = shortcut <= 10 ? `Ctrl+${shortcut % 10}` : `Ctrl+Shift+${shortcut % 10}`;
      b.dataset.n = shortcut;
      b.dataset.id = s.id;
      // Symbol ganz rechts, der Zieh-Griff links davon (er erscheint nur beim Überfahren)
      b.innerHTML = `<span class="ic"></span><span class="nm"></span><span class="grip" title="Ziehen: Reihenfolge im Ordner ändern">⠿</span><span class="ag"></span><span class="loc"></span><span class="st"></span>`;
      b.querySelector('.ic').textContent = ICON[s.status] || '·';
      b.querySelector('.nm').textContent = s.name;
      b.querySelector('.nm').title = s.title ? `Titel im Agenten: ${s.title}` : s.name;
      if (s.konto) b.querySelector('.nm').append(kontoChip(s.konto));
      const subChip = subagentChip(s.id);
      if (subChip) b.querySelector('.nm').append(subChip);
      setAgentIcon(b.querySelector('.ag'), s.agent);
      const st = b.querySelector('.st');
      const fullDetail = sessionDetailText(s);
      st.title = `${wtree.dir}\n${fullDetail}`;
      st.textContent = fullDetail;
      // Eigene Zeile für Worktree und dessen Stand - nur in den flachen Listen (Status, Typ). In der
      // Ordneransicht steht beides in der Überschrift, und die Gruppe folgt dem echten Arbeitsort.
      const loc = b.querySelector('.loc');
      if (byGroup) loc.hidden = true;
      else {
        const wt = document.createElement('span');
        wt.className = 'wt';
        wt.textContent = folderName(wtree.dir);
        loc.append(wt);
        const br = document.createElement('span');
        br.className = 'br';
        if (fillGit(br, wtree.git)) loc.append(' ', br);
        loc.title = wtree.dir;
      }
      b.addEventListener('click', () => { if (Date.now() >= suppressClick) assignToPane(focused, s.id); });
      b.addEventListener('dblclick', () => { assignToPane(focused, s.id); renamePrompt(s.id); });
      if (byGroup) {
        b.addEventListener('pointerdown', e => startDrag(e, b, s.id));
        b.querySelector('.grip').addEventListener('pointerdown', e => { e.stopPropagation(); startDrag(e, b, s.id, true); });
      } else b.querySelector('.grip').hidden = true; // Status-/Typsortierung: die Folge macht die Sortierung
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

  // Kleines Agenten-Symbol statt des Namens; der Name bleibt als Tooltip und für Screenreader erhalten.
  // Die Bilder stecken als data:-URIs in style.css (ui/agents/embed.js) - so erscheinen sie auch, wenn
  // der laufende Daemon älter ist als die Oberfläche und eigene Bild-Routen noch nicht kennt.
  const AGENTS_WITH_ICON = new Set(['claude', 'codex', 'agy', 'pi', 'pwsh']);
  function setAgentIcon(el, agent) {
    if (el.dataset.agent === agent) return;
    el.dataset.agent = agent;
    el.title = agent;
    el.replaceChildren();
    if (!AGENTS_WITH_ICON.has(agent)) { el.textContent = agent; return; }
    const icon = document.createElement('span');
    icon.className = 'agi agi-' + agent;
    icon.setAttribute('role', 'img');
    icon.setAttribute('aria-label', agent);
    el.appendChild(icon);
  }

  // Letzter Pfadteil - bei Worktrees genau deren Name (z. B. "7139_welle8_portale")
  const folderName = cwd => String(cwd || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(cwd || '');

  // Branch + Arbeitsstand kompakt, z. B. "⎇ master ±3 ↑1 ↓2" - reine Anzeige, Aioc fasst Repos nicht an
  function fillGit(span, g) {
    span.replaceChildren();
    span.title = '';
    if (!g) return false;
    const changes = (g.changed || 0) + (g.untracked || 0) + (g.conflicts || 0);
    const marks = [changes ? '±' + changes : '', g.ahead ? '↑' + g.ahead : '', g.behind ? '↓' + g.behind : ''].filter(Boolean).join(' ');
    const bn = document.createElement('span');
    bn.className = 'bn';
    bn.textContent = '⎇ ' + g.branch;
    span.appendChild(bn);
    if (marks) {
      const bm = document.createElement('span');
      bm.className = g.conflicts ? 'bm conflict' : 'bm';
      bm.textContent = ' ' + marks;
      span.appendChild(bm);
    }
    const lines = [g.detached ? `Losgelöster HEAD bei ${g.branch}` : `Branch ${g.branch}`];
    if (g.changed) lines.push(`${g.changed} geänderte Datei${g.changed === 1 ? '' : 'en'}`);
    if (g.untracked) lines.push(`${g.untracked} unversioniert`);
    if (g.conflicts) lines.push(`${g.conflicts} mit Konflikt`);
    if (!changes) lines.push('Arbeitsverzeichnis sauber');
    if (g.upstream) lines.push(g.ahead || g.behind ? `${g.ahead} vor, ${g.behind} hinter ${g.upstream}` : `gleichauf mit ${g.upstream}`);
    else if (!g.detached) lines.push('kein Upstream');
    span.title = lines.join('\n');
    return true;
  }

  // Jedes Pane: eigene Kopfzeile (Name, Agent, Ordner, Branch, Session, Aktionen, Teilen/Zoom) + Terminalbereich
  function buildPane(leaf) {
    const el = document.createElement('div');
    el.className = 'pane';
    el.innerHTML = `
      <div class="phead">
        <button class="btn back" title="Zurück zur Liste">‹ Liste</button>
        <span class="empty-lbl">Leeres Pane</span>
        <span class="nm s-only" title="Doppelklick: umbenennen"></span>
        <span class="ag s-only"></span>
        <span class="cwd s-only"></span>
        <span class="br s-only"></span>
        <span class="sid s-only"></span>
        <span class="lim s-only" title="Ein anderer Client zeigt diese Session gerade kleiner an – die kleinste Ansicht bestimmt die Terminalgröße"></span>
        <span class="sp"></span>
        <button class="btn b-restore s-only" hidden>Wiederherstellen</button>
        <button class="btn b-rename s-only" title="Umbenennen (F2) – der Name wird auch im Agenten gesetzt (Claude Code, Codex, agy)">Umbenennen</button>
        <button class="btn danger b-close s-only" hidden>Schließen</button>
        <button class="btn danger b-dispose s-only" hidden>Entfernen</button>
        <span class="pbtns">
          <button class="btn icon b-split-r" title="Rechts teilen (Alt+Shift+Plus)">◧</button>
          <button class="btn icon b-split-d" title="Unten teilen (Alt+Shift+Minus)">⬒</button>
          <button class="btn icon b-zoom" title="Zoom an/aus (Alt+Shift+Z)" aria-pressed="false">⤢</button>
          <button class="btn icon b-unpane" title="Pane schließen – die Session läuft weiter (Alt+Shift+W)">✕</button>
        </span>
      </div>
      <div class="pane-body">
        <div class="pane-empty"><div><h2>Keine Session</h2><p>Links eine Session wählen oder mit <b>+ Neu</b> starten.</p></div></div>
      </div>`;
    const idOf = () => leaf.id;
    el.addEventListener('mousedown', () => {
      const idx = panes.indexOf(leaf);
      if (idx >= 0 && idx !== focused) { focused = idx; saveLayout(); renderAll(); }
    }, true);
    el.querySelector('.b-split-r').addEventListener('click', () => splitFocused('row'));
    el.querySelector('.b-split-d').addEventListener('click', () => splitFocused('col'));
    el.querySelector('.b-zoom').addEventListener('click', toggleZoom);
    el.querySelector('.b-unpane').addEventListener('click', () => closePane(leaf));
    el.querySelector('.back').addEventListener('click', () => { document.body.classList.remove('show-term'); renderAll(); });
    el.querySelector('.b-rename').addEventListener('click', () => renamePrompt(idOf()));
    el.querySelector('.nm').addEventListener('dblclick', () => renamePrompt(idOf()));
    el.querySelector('.b-close').addEventListener('click', () => {
      const s = sessionOf(idOf());
      if (s) askConfirm(`„${s.name}" läuft noch – Prozess wirklich beenden?`, 'Beenden').then(ok => { if (ok) send({ t: 'close', id: s.id }); });
    });
    el.querySelector('.b-dispose').addEventListener('click', () => {
      const s = sessionOf(idOf());
      if (s) askConfirm(`„${s.name}" samt Scrollback aus der Liste entfernen?`, 'Entfernen').then(ok => { if (ok) send({ t: 'dispose', id: s.id }); });
    });
    el.querySelector('.b-restore').addEventListener('click', () => {
      const id = idOf();
      const t = id && terms.get(id);
      if (id) send({ t: 'restore', id, cols: t?.term.cols || lastSize.cols, rows: t?.term.rows || lastSize.rows });
    });
    return el;
  }

  // Teilbaum als verschachtelte Flex-Container; zwischen den Hälften eine ziehbare Trennlinie
  function buildNode(n, depth = 0) {
    if (isLeaf(n)) {
      if (!n.el) n.el = buildPane(n);
      return n.el;
    }
    const box = document.createElement('div');
    box.className = 'split ' + n.dir;
    const a = buildNode(n.a, depth + 1), b = buildNode(n.b, depth + 1);
    const apply = () => { a.style.flex = `${n.ratio} 1 0`; b.style.flex = `${1 - n.ratio} 1 0`; };
    apply();
    const div = document.createElement('div');
    div.className = 'divider';
    div.style.zIndex = String(40 - depth); // T-Stoß: die Griffe überlappen, die äußere (längere) Linie gewinnt
    div.title = 'Ziehen: Größe ändern · Doppelklick: halbe-halbe';
    div.addEventListener('pointerdown', e => {
      e.preventDefault();
      div.setPointerCapture(e.pointerId);
      div.classList.add('drag');
      const move = ev => {
        const r = box.getBoundingClientRect();
        n.ratio = clampRatio(n.dir === 'row' ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height);
        apply();
        fitAll();
      };
      const up = () => {
        div.classList.remove('drag');
        div.removeEventListener('pointermove', move);
        div.removeEventListener('pointerup', up);
        saveLayout();
      };
      div.addEventListener('pointermove', move);
      div.addEventListener('pointerup', up);
    });
    div.addEventListener('dblclick', () => { n.ratio = 0.5; apply(); fitAll(); saveLayout(); });
    box.append(a, div, b);
    return box;
  }

  // Den Baum nur bei Strukturänderungen neu aufbauen - die Pane-Elemente (samt Terminal) werden
  // dabei nur umgehängt, nie neu erzeugt. Gezoomt bzw. auf dem Handy ist nur ein Pane im Bild.
  function renderPanes() {
    const host = $('panes');
    const multi = panes.length > 1;
    const root = MOBILE.matches ? panes[focused] : zoomed || tree;
    if (layoutDirty || root !== builtRoot) {
      const el = buildNode(root);
      el.style.flex = '1 1 0';
      host.replaceChildren(el);
      builtRoot = root;
      layoutDirty = false;
      fitAll();
    }
    host.classList.toggle('multi', multi && root === tree);

    panes.forEach((p, i) => {
      if (!p.el) p.el = buildPane(p);
      const el = p.el;
      const s = sessionOf(p.id);
      const plug = pluginOf(p.id);
      const plugInfo = plug ? plugins.find(x => x.id === plug) : null;
      const head = el.querySelector('.phead');
      const body = el.querySelector('.pane-body');
      el.classList.toggle('focused', i === focused);
      el.classList.toggle('nosess', !s && !plugInfo);
      el.classList.toggle('plug-pane', !!plugInfo);
      el.classList.toggle('owned', !!s?.owner);
      head.hidden = !s && !plugInfo && !multi;
      body.querySelector('.pane-empty').style.display = s || plugInfo ? 'none' : 'flex';
      head.querySelector('.nm').dataset.owner = s?.owner ? (plugins.find(x => x.id === s.owner)?.name || s.owner) : '';
      if (plugInfo) {
        head.querySelector('.nm').textContent = plugInfo.name;
        head.querySelector('.nm').title = plugInfo.name;
        const v = pluginView(plugInfo);
        if (v.parentElement !== body) body.appendChild(v);
      }
      const full = panes.length >= MAX_PANES;
      head.querySelector('.b-split-r').disabled = full;
      head.querySelector('.b-split-d').disabled = full;
      head.querySelector('.b-zoom').hidden = !multi;
      head.querySelector('.b-zoom').setAttribute('aria-pressed', zoomed === p ? 'true' : 'false');
      head.querySelector('.b-unpane').hidden = !multi;
      if (s) {
        const nm = head.querySelector('.nm');
        if (!nm.querySelector('input')) nm.textContent = s.name;
        nm.title = (s.title ? `Titel im Agenten: ${s.title}\n` : '') + 'Doppelklick: umbenennen';
        setAgentIcon(head.querySelector('.ag'), s.agent);
        // Kopfzeile zeigt, wo der Agent tatsächlich arbeitet; der Startordner steht dann im Tooltip
        const wtree = workTree(s);
        const cwdEl = head.querySelector('.cwd');
        cwdEl.textContent = wtree.moved ? wtree.dir : s.cwd;
        cwdEl.title = wtree.moved ? `Arbeitet in ${wtree.dir}\nGestartet in ${s.cwd}` : s.cwd;
        fillGit(head.querySelector('.br'), wtree.git);
        head.querySelector('.sid').textContent = [s.konto ? 'Konto ' + s.konto.label : '', s.agentSessionId ? 'session ' + String(s.agentSessionId).slice(0, 8) + '…' : ''].filter(Boolean).join(' · ');
        head.querySelector('.lim').textContent = s.sizeInfo?.limitedBy ? '⧉ Größe: ' + s.sizeInfo.limitedBy : '';
        head.querySelector('.b-close').hidden = !s.running;
        head.querySelector('.b-restore').hidden = !!s.running;
        head.querySelector('.b-restore').textContent = s.agent === 'pwsh' ? 'Neu starten' : (s.agentSessionId ? 'Wiederherstellen' : 'Neu starten');
        head.querySelector('.b-dispose').hidden = !!s.running;
        const t = ensureAttached(s.id);
        if (t.wrap.parentElement !== body) body.appendChild(t.wrap);
      }
    });
    for (const [pid, v] of pluginViews) if (!panes.some(p => pluginOf(p.id) === pid && hasPlugin(pid))) v.el.remove();
    for (const [id, t] of terms) {
      const shown = panes.some(p => p.id === id);
      t.wrap.classList.toggle('active', shown);
      // Nicht mehr angezeigte Sessions loslassen: ihre Groessenvorgabe faellt beim Daemon sofort weg
      if (!shown && t.attached) { t.attached = false; clearTimeout(t.resizeTimer); t.sentCols = t.sentRows = undefined; send({ t: 'detach', id }); }
    }
  }

  // Inline-Umbenennen in der Kopfzeile des Panes (window.prompt gibt es in Electron nicht)
  function renamePrompt(id) {
    const s = sessionOf(id);
    if (!s || s.owner) return; // Sessions eines Plugins benennt nur das Plugin
    const idx = panes.findIndex(p => p.id === id);
    const nm = idx >= 0 && panes[idx].el?.querySelector('.phead .nm');
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

  // ---------- Plugins ----------
  // Ein Plugin bringt ui.js/ui.css mit (vom Daemon unter /plugins/<id>/ ausgeliefert). ui.js meldet
  // sich mit AiocPlugins.register({ id, tab(state, api), mount(el, api), update(state, api) }) an:
  // tab liefert den angepinnten Eintrag oben in der Seitenleiste ({ title, badge, hot, subline }),
  // mount baut die Ansicht einmal auf, update zeichnet sie bei neuem Zustand oder Sessionstand nach.
  // Die Sessions des Plugins (owner) zeigt Aioc selbst unter dem Eintrag - geschützt und markiert.
  const mk = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const loadedAssets = new Set();
  function loadPluginAssets() {
    for (const p of plugins) {
      if (p.css && !loadedAssets.has(p.css)) {
        loadedAssets.add(p.css);
        const l = document.createElement('link');
        l.rel = 'stylesheet';
        l.href = p.css;
        document.head.appendChild(l);
      }
      if (p.ui && !loadedAssets.has(p.ui)) {
        loadedAssets.add(p.ui);
        const sc = document.createElement('script');
        sc.src = p.ui;
        sc.onerror = () => flashError(`Plugin ${p.name}: Oberfläche nicht ladbar`);
        document.body.appendChild(sc);
      }
    }
  }
  window.AiocPlugins = {
    register(def) {
      if (!def || typeof def.id !== 'string') return;
      pluginDefs.set(def.id, def);
      const v = pluginViews.get(def.id);
      if (v) v.dirty = true;
      renderAll();
    },
  };

  function pluginApi(id) {
    return {
      id,
      send: msg => send({ t: 'plugin', id, msg: { ...msg, cols: lastSize.cols, rows: lastSize.rows } }),
      sessions: () => sessions,
      ownSessions: () => sessions.filter(s => s.owner === id),
      openSession: sid => { if (sessionOf(sid)) assignToPane(focused, sid); },
      openExternal,
      error: flashError,
      confirm: askConfirm,
    };
  }

  function pluginView(p) {
    let v = pluginViews.get(p.id);
    if (!v) {
      v = { el: mk('div', 'plug-view'), mounted: false, dirty: true };
      v.el.dataset.plugin = p.id;
      pluginViews.set(p.id, v);
    }
    const def = pluginDefs.get(p.id);
    if (!def) {
      if (!v.mounted) v.el.replaceChildren(mk('div', 'plug-wait', `${p.name} lädt …`));
      return v.el;
    }
    try {
      if (!v.mounted) { v.el.replaceChildren(); def.mount?.(v.el, pluginApi(p.id)); v.mounted = true; v.dirty = true; }
      if (v.dirty) { v.dirty = false; def.update?.(p.state, pluginApi(p.id)); }
    } catch (err) {
      console.error(`Plugin ${p.id}:`, err);
      v.el.replaceChildren(mk('div', 'plug-wait', `${p.name}: ${err.message}`));
    }
    return v.el;
  }

  function renderPluginSidebar(list) {
    for (const p of plugins) {
      const def = pluginDefs.get(p.id);
      let tab = { title: p.name };
      try { if (def?.tab) tab = { ...tab, ...def.tab(p.state, pluginApi(p.id)) }; } catch (err) { console.error(`Plugin ${p.id}:`, err); }
      const owned = sessions.filter(x => x.owner === p.id);
      const colKey = PLUGIN_PREFIX + p.id;
      const isCol = isCollapsed(colKey);
      const b = mk('button', 'sess plug-tab');
      b.setAttribute('aria-current', panes.some(x => x.id === PLUGIN_PREFIX + p.id) ? 'true' : 'false');
      b.append(mk('span', 'ic', p.icon), mk('span', 'nm', tab.title || p.name), mk('span', 'plug-badge' + (tab.hot ? ' hot' : ''), tab.badge || ''));
      if (owned.length) {
        const waiting = isCol && owned.some(x => x.status === 'waiting');
        const fold = mk('span', 'plug-fold' + (waiting ? ' waiting' : ''));
        fold.title = isCol ? `System-Session (${owned.map(x => x.name).join(', ')}) ausklappen` : 'System-Session einklappen';
        fold.setAttribute('role', 'button');
        fold.setAttribute('aria-expanded', isCol ? 'false' : 'true');
        fold.innerHTML = isCol
          ? '<svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 2.5L6 6l3.5-3.5M2.5 6.5L6 10l3.5-3.5"/></svg>'
          : '<svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 9.5L6 6l3.5 3.5M2.5 5.5L6 2l3.5 3.5"/></svg>';
        fold.addEventListener('click', e => {
          e.stopPropagation();
          toggleCollapsed(colKey);
          persistLocal();
          renderAll();
        });
        b.appendChild(fold);
      }
      b.appendChild(mk('span', 'st', tab.subline || ''));
      b.addEventListener('click', () => { if (Date.now() >= suppressClick) assignToPane(focused, PLUGIN_PREFIX + p.id); });
      list.appendChild(b);
      if (isCol) continue;
      for (const s of owned) {
        const r = mk('button', `sess owned ${s.status}${s.unread ? ' unread' : ''}`);
        r.dataset.id = s.id;
        r.setAttribute('aria-current', panes.some(x => x.id === s.id) ? 'true' : 'false');
        r.title = `Gehört zum Plugin „${p.name}" – Umbenennen, Beenden und Entfernen nur dort`;
        const nm = mk('span', 'nm', s.name);
        if (s.konto) nm.append(kontoChip(s.konto));
        r.append(mk('span', 'ic', ICON[s.status] || '·'), nm, mk('span', 'own', 'System'), mk('span', 'ag'), mk('span', 'st', s.detail || ''));
        setAgentIcon(r.querySelector('.ag'), s.agent);
        r.addEventListener('click', () => assignToPane(focused, s.id));
        list.appendChild(r);
      }
    }
    if (plugins.length) list.appendChild(mk('div', 'plug-sep'));
  }

  // Fehlermeldungen des Daemons (z. B. abgelehnte Aktion) kurz in der Titelleiste zeigen
  let flashTimer = null;
  function flashError(message) {
    const c = $('conn');
    c.textContent = String(message || 'Fehler');
    c.classList.add('off');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(renderConn, 6000);
  }

  // ---------- Neue Session ----------
  let dlgAgent = 'claude';
  function openNew() {
    $('f-cwd').value = recents[0] || '';
    $('f-name').value = '';
    $('f-args').value = '';
    renderKonten();
    send({ t: 'konten' }); // frisch einlesen: Anmeldungen können sich seit dem Verbindungsaufbau geändert haben
    $('newdlg').showModal();
    $('f-cwd').focus();
  }

  // Konto je Ordner merken (dieses Gerät): wer in einem Ordner einmal ein Konto wählt, bekommt es dort wieder
  const kontoKey = cwd => cwd.trim().replace(/[\\/]+$/, '').toLowerCase();
  function kontoMemory() { try { return JSON.parse(localStorage.getItem('aioc-konto') || '{}'); } catch { return {}; } }
  function kontoLabel(k) {
    const name = k.org || k.id;
    return `${name}${k.email ? ' · ' + k.email : ''}${k.id === 'standard' ? ' (Standard)' : ` [${k.id}]`}${k.angemeldet ? '' : ' – nicht angemeldet'}`;
  }
  // Kennzeichen einer Session, die mit einem eigenen Konto läuft (das Standardkonto bleibt unmarkiert)
  function kontoChip(k) {
    const c = mk('span', 'konto', k.label);
    c.title = 'Claude-Konto: ' + k.label;
    return c;
  }
  // Subagenten-Informationen aus dem Büro-Plugin für die linke Seitenleiste mitnutzen
  function sessionSubagents(sid) {
    const bp = plugins.find(p => p.id === 'buero');
    return bp?.state?.subagents?.[sid] || [];
  }
  function subagentChip(sid) {
    const subs = sessionSubagents(sid);
    const active = subs.filter(x => x.status === 'running');
    if (!active.length) return null;
    const c = mk('span', 'konto sub-chip', `+${active.length} Sub`);
    c.title = 'Aktive Subagenten:\n' + active.map(x => `• ${x.name} (${x.detail || x.role})`).join('\n');
    return c;
  }
  function sessionDetailText(s) {
    const base = s.detail || '';
    const activeSubs = sessionSubagents(s.id).filter(x => x.status === 'running');
    if (activeSubs.length && (!base || base === 'arbeitet')) {
      return `👥 ${activeSubs.map(x => `${x.name}${x.detail && x.detail !== 'arbeitet im Cubicle' ? ' (' + x.detail + ')' : ''}`).join(' · ')}`;
    }
    return base;
  }
  // keep: aktuelle Auswahl behalten (Liste neu eingelesen); sonst das gemerkte Konto des Ordners
  function renderKonten(keep = false) {
    const sel = $('f-konto');
    const show = dlgAgent === 'claude' && konten.length > 1;
    document.querySelectorAll('.konto-row').forEach(x => { x.hidden = !show; });
    const current = sel.value;
    sel.replaceChildren(...konten.map(k => {
      const o = document.createElement('option');
      o.value = k.id; o.textContent = kontoLabel(k);
      return o;
    }));
    const wanted = (keep && current) || kontoMemory()[kontoKey($('f-cwd').value)] || 'standard';
    sel.value = konten.some(k => k.id === wanted) ? wanted : 'standard';
  }
  $('f-cwd').addEventListener('input', () => {
    const k = kontoMemory()[kontoKey($('f-cwd').value)];
    if (k && konten.some(x => x.id === k)) $('f-konto').value = k;
  });
  $('agentseg').addEventListener('click', e => {
    const b = e.target.closest('button[data-a]');
    if (!b) return;
    dlgAgent = b.dataset.a;
    document.querySelectorAll('#agentseg button').forEach(x => x.classList.toggle('on', x === b));
    renderKonten(true);
  });
  $('newform').addEventListener('submit', () => {
    const cwd = $('f-cwd').value.trim();
    if (!cwd) return;
    pendingSelectNew = true;
    const konto = dlgAgent === 'claude' && konten.length > 1 ? $('f-konto').value : undefined;
    if (konto) {
      const mem = kontoMemory();
      mem[kontoKey(cwd)] = konto;
      try { localStorage.setItem('aioc-konto', JSON.stringify(mem)); } catch {}
    }
    send({ t: 'create', agent: dlgAgent, cwd, name: $('f-name').value.trim(), args: $('f-args').value.trim(), konto, cols: lastSize.cols, rows: lastSize.rows });
  });
  $('f-cancel').addEventListener('click', () => $('newdlg').close());
  $('newdlg').addEventListener('close', focusActiveTerm);
  let confirmResolve = null;
  function askConfirm(text, okLabel = 'OK') {
    if (confirmResolve) { confirmResolve(false); confirmResolve = null; }
    const dlg = $('confirmdlg');
    $('confirmtext').textContent = text;
    $('c-ok').textContent = okLabel;
    return new Promise(resolve => {
      confirmResolve = resolve;
      dlg.showModal();
      $('c-ok').focus();
    });
  }
  $('confirmform').addEventListener('submit', () => {
    const r = confirmResolve; confirmResolve = null;
    if (r) r(true);
  });
  $('c-cancel').addEventListener('click', () => $('confirmdlg').close());
  $('confirmdlg').addEventListener('close', () => {
    const r = confirmResolve; confirmResolve = null;
    if (r) r(false);
    focusActiveTerm();
  });
  $('newbtn').addEventListener('click', openNew);
  $('restoreall').addEventListener('click', () => send({ t: 'restoreAll', cols: lastSize.cols, rows: lastSize.rows }));

  // ---------- Filter + Sortierung ----------
  document.querySelectorAll('.chip[data-f]').forEach(ch =>
    ch.addEventListener('click', () => { filter = ch.dataset.f; renderAll(); }));
  $('sortbtn').addEventListener('click', () => {
    sortMode = { ordner: 'status', status: 'typ', typ: 'ordner' }[sortMode] || 'ordner';
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
    if (inInputField()) return;
    if (ae && ae.tagName !== 'BODY' && !ae.classList.contains('xterm-helper-textarea')) ae.blur?.();
    const id = activeId();
    if (id) terms.get(id)?.term.focus();
  });
  window.addEventListener('focus', focusActiveTerm);
  window.addEventListener('keydown', e => {
    const ae = document.activeElement;
    const inField = inInputField();
    if (!inField && !document.querySelector('dialog[open]') && ae?.tagName === 'BUTTON') {
      ae.blur();
      const id = activeId();
      if (id && !pluginOf(id)) terms.get(id)?.term.focus();
    }
    if (!inField && (e.key === 'F2' || (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'r'))) {
      e.preventDefault();
      if (activeId()) renamePrompt(activeId());
      return;
    }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); openNew(); return; }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); toggleSearch(); return; }
    if (paneKey(e)) {
      e.preventDefault();
      const k = e.key.toLowerCase();
      if (k === 'd') splitFocused('auto');
      else if (k === 'z') toggleZoom();
      else if (k === 'w') closePane();
      else if (isPlus(e)) splitFocused('row');
      else splitFocused('col');
      return;
    }
    if (e.altKey && !e.ctrlKey && !e.shiftKey && e.key.startsWith('Arrow')) { e.preventDefault(); moveFocus(e.key); return; }
    const nth = sessionShortcut(e);
    if (nth) {
      const b = document.querySelector(`.sess[data-n="${nth}"]`);
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

  // Fenster schmaler/breiter als die Handy-Grenze: Layout neu (Handy zeigt nur das fokussierte Pane)
  MOBILE.addEventListener('change', () => { layoutDirty = true; renderAll(); fitAll(); });

  // Service Worker: Chrome verlangt ihn auf Android fuer die Installation als App. Er cached nichts
  // (siehe ui/sw.js) und braucht einen sicheren Kontext - ueber ein selbstsigniertes Zertifikat
  // registriert er sich nicht, dort bleibt es bei der Verknuepfung.
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  connect();
})();
