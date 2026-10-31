// Aioc-Plugin „Pixel-Büro": Visualisiert alle Agenten-Sessions als kleine Pixelart-Männchen
// und -Weibchen in einem animierten Großraumbüro (Cubicles mit Schreibtischen, Kaffeeküche,
// Info-Schalter, Sofa-Ecke). Subagenten einer Session erscheinen als kleine Helfer-Figuren
// mit Laptop direkt im selben Cubicle wie ihr Haupt-Agent!
/* global AiocPlugins */
(() => {
  const ID = 'buero';

  // Virtuelle Pixel-Auflösung des Büros (wird sauber hochskaliert)
  const VW = 340;
  const VH = 210;

  // Feste Arbeitsplätze (12 Cubicles in 3 Reihen à 4 Tische)
  const DESKS = [
    // Reihe 1 (oben)
    { x: 40, y: 62 }, { x: 102, y: 62 }, { x: 164, y: 62 }, { x: 226, y: 62 },
    // Reihe 2 (Mitte)
    { x: 40, y: 106 }, { x: 102, y: 106 }, { x: 164, y: 106 }, { x: 226, y: 106 },
    // Reihe 3 (unten)
    { x: 40, y: 150 }, { x: 102, y: 150 }, { x: 164, y: 150 }, { x: 226, y: 150 },
  ];

  // Relative Sitzplätze für Subagenten innerhalb desselben Cubicles (links, rechts, schräg dahinter)
  const SUB_CUBICLE_OFFSETS = [
    { dx: -14, dy: 4 },
    { dx: 14,  dy: 4 },
    { dx: -20, dy: 11 },
    { dx: 20,  dy: 11 },
  ];

  // Aufenthalts-Spots für Kaffeeküche (done / idle)
  const COFFEE_SPOTS = [
    { x: 286, y: 66 }, { x: 308, y: 72 }, { x: 282, y: 86 },
    { x: 312, y: 92 }, { x: 295, y: 102 }, { x: 274, y: 102 },
  ];

  // Warteschlange am Info-Schalter / Whiteboard (waiting = Rückfrage!)
  const HELP_SPOTS = [
    { x: 282, y: 136 }, { x: 304, y: 140 }, { x: 272, y: 150 }, { x: 316, y: 152 },
  ];

  // Feierabend-Sofa / Sitzsäcke (exited)
  const SOFA_SPOTS = [
    { x: 284, y: 178 }, { x: 300, y: 178 }, { x: 316, y: 178 },
    { x: 270, y: 188 }, { x: 325, y: 190 },
  ];

  // Agenten-Farben (Hemd / Pulli)
  const AGENT_SHIRT = {
    claude: { main: '#d97757', dark: '#a85236', label: 'Claude' },
    codex:  { main: '#10a37f', dark: '#0b7258', label: 'Codex' },
    agy:    { main: '#4285f4', dark: '#285bb5', label: 'Antigravity' },
    pi:     { main: '#a855f7', dark: '#7c2dc7', label: 'Pi' },
    pwsh:   { main: '#38bdf8', dark: '#0284c7', label: 'PowerShell' },
  };

  const SKIN_TONES = ['#ffdbb5', '#f1c27d', '#e0ac69', '#c68642', '#ffcfb3'];
  const HAIR_COLORS = ['#2c1b18', '#4a312c', '#8d4a28', '#d69d45', '#1a1a24', '#7a2828', '#6b7280'];
  const PANTS_COLORS = ['#1e293b', '#334155', '#312e81', '#3f3f46', '#1f2937'];

  const STATUS_TEXT = {
    running: 'tippt fleißig am Code',
    starting: 'richtet den Arbeitsplatz ein',
    waiting: 'hat eine Rückfrage!',
    done: 'trinkt zufrieden Kaffee (fertig)',
    idle: 'macht Kaffeepause (bereit)',
    exited: 'schläft auf dem Sofa (beendet)',
  };

  let api = null;
  let pluginState = {}; // { subagents: { [sessionId]: [...] }, totalActive }
  let rootEl = null;
  let canvas = null;
  let ctx = null;
  let tooltipEl = null;
  let statsEl = null;
  let rafId = null;
  let showLabels = true;
  let hideExited = false;
  try {
    showLabels = localStorage.getItem('aioc-buero-labels') !== '0';
    hideExited = localStorage.getItem('aioc-buero-hide-exited') === '1';
  } catch {}

  // Persistenter Animationszustand je Session-ID und Subagent-ID
  const actors = new Map();    // sessionId -> Actor
  const subActors = new Map(); // subId -> SubActor
  let hoveredItem = null;      // { kind: 'main'|'sub', actor }
  let lastTick = performance.now();
  let steamParticles = [];
  let zzzParticles = [];

  function hashStr(str) {
    let h = 2166136261 >>> 0;
    const s = String(str || '');
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  function makeAppearance(id, agent) {
    const h = hashStr(id);
    const isFemale = (h & 1) === 1;
    const skin = SKIN_TONES[(h >>> 1) % SKIN_TONES.length];
    const hair = HAIR_COLORS[(h >>> 4) % HAIR_COLORS.length];
    const pants = PANTS_COLORS[(h >>> 8) % PANTS_COLORS.length];
    const hairStyle = (h >>> 11) % 3;
    const glasses = ((h >>> 14) % 4) === 0;
    const shirt = AGENT_SHIRT[agent] || { main: '#64748b', dark: '#475569', label: agent || 'Agent' };
    return { isFemale, skin, hair, pants, hairStyle, glasses, shirt, phase: (h % 100) / 10 };
  }

  function shortName(s, maxLen = 14) {
    const raw = String(s.name || s.id || '').trim();
    const cleaned = raw.replace(/^(claude|codex|agy|pi|pwsh)\s*·\s*/i, '');
    return cleaned.length > maxLen ? cleaned.slice(0, maxLen - 1) + '…' : cleaned;
  }

  function syncActors() {
    if (!api) return;
    const all = api.sessions() || [];
    const list = hideExited ? all.filter(s => s.status !== 'exited') : all;
    const seen = new Set();

    // Freie Schreibtische vergeben (bestehende behalten ihren Tisch)
    const usedDesks = new Set();
    for (const s of list) {
      const ex = actors.get(s.id);
      if (ex && ex.deskIdx != null && ex.deskIdx < DESKS.length) usedDesks.add(ex.deskIdx);
    }

    let coffeeIdx = 0, helpIdx = 0, sofaIdx = 0;

    list.forEach((s, idx) => {
      seen.add(s.id);
      let a = actors.get(s.id);
      if (!a) {
        let deskIdx = 0;
        while (usedDesks.has(deskIdx) && deskIdx < DESKS.length) deskIdx++;
        if (deskIdx < DESKS.length) usedDesks.add(deskIdx);
        else deskIdx = idx % DESKS.length;
        const d = DESKS[deskIdx];
        a = {
          id: s.id,
          deskIdx,
          x: d.x,
          y: d.y + 8,
          tx: d.x,
          ty: d.y + 8,
          wanderTimer: 2 + (hashStr(s.id) % 5),
          appearance: makeAppearance(s.id, s.agent),
          session: s,
        };
        actors.set(s.id, a);
      } else {
        a.session = s;
        a.appearance.shirt = AGENT_SHIRT[s.agent] || a.appearance.shirt;
      }

      const d = DESKS[a.deskIdx % DESKS.length];
      if (s.status === 'running' || s.status === 'starting') {
        a.tx = d.x;
        a.ty = d.y + 7;
        a.atDesk = true;
      } else if (s.status === 'waiting') {
        const sp = HELP_SPOTS[helpIdx % HELP_SPOTS.length];
        const row = Math.floor(helpIdx / HELP_SPOTS.length);
        a.tx = sp.x - row * 10;
        a.ty = sp.y + (helpIdx % 2) * 3;
        a.atDesk = false;
        helpIdx++;
      } else if (s.status === 'exited') {
        const sp = SOFA_SPOTS[sofaIdx % SOFA_SPOTS.length];
        a.tx = sp.x;
        a.ty = sp.y;
        a.atDesk = false;
        sofaIdx++;
      } else {
        const sp = COFFEE_SPOTS[coffeeIdx % COFFEE_SPOTS.length];
        a.tx = sp.x + ((coffeeIdx >= COFFEE_SPOTS.length) ? -12 : 0);
        a.ty = sp.y;
        a.atDesk = false;
        coffeeIdx++;
      }
    });

    for (const id of [...actors.keys()]) {
      if (!seen.has(id)) actors.delete(id);
    }

    // Subagenten den Cubicles ihrer Eltern-Session zuordnen
    const seenSubs = new Set();
    const subMap = pluginState?.subagents || {};
    for (const [parentId, subs] of Object.entries(subMap)) {
      const parentActor = actors.get(parentId);
      if (!parentActor || !Array.isArray(subs)) continue;
      const d = DESKS[parentActor.deskIdx % DESKS.length];
      subs.slice(0, SUB_CUBICLE_OFFSETS.length).forEach((sub, sIdx) => {
        seenSubs.add(sub.id);
        const off = SUB_CUBICLE_OFFSETS[sIdx];
        const tx = d.x + off.dx;
        const ty = d.y + off.dy;
        let sa = subActors.get(sub.id);
        if (!sa) {
          sa = {
            id: sub.id,
            parentId,
            deskIdx: parentActor.deskIdx,
            slotIdx: sIdx,
            x: tx,
            y: ty,
            tx,
            ty,
            appearance: makeAppearance(sub.id, sub.agent || parentActor.session.agent),
            sub,
            parentSession: parentActor.session,
          };
          subActors.set(sub.id, sa);
        } else {
          sa.tx = tx;
          sa.ty = ty;
          sa.deskIdx = parentActor.deskIdx;
          sa.slotIdx = sIdx;
          sa.sub = sub;
          sa.parentSession = parentActor.session;
        }
      });
    }

    for (const id of [...subActors.keys()]) {
      if (!seenSubs.has(id)) subActors.delete(id);
    }

    renderToolbarStats(all);
  }

  function renderToolbarStats(all) {
    if (!statsEl) return;
    const c = { running: 0, waiting: 0, done: 0, idle: 0, exited: 0 };
    for (const s of all) {
      if (s.status === 'running' || s.status === 'starting') c.running++;
      else if (s.status === 'waiting') c.waiting++;
      else if (s.status === 'done') c.done++;
      else if (s.status === 'exited') c.exited++;
      else c.idle++;
    }
    const subCount = subActors.size;
    const subRunning = [...subActors.values()].filter(x => x.sub.status === 'running').length;
    const subBadge = subCount > 0
      ? `<span class="buero-stat" title="Subagenten in den Cubicles der Haupt-Sessions"><span class="dot" style="background:#a855f7"></span>${subRunning}/${subCount} Subagent${subCount === 1 ? '' : 'en'}</span>`
      : '';

    statsEl.innerHTML = `
      <span class="buero-stat" title="Arbeitet am Schreibtisch"><span class="dot" style="background:#22c55e"></span>${c.running} tippt</span>
      ${subBadge}
      <span class="buero-stat" title="Wartet am Info-Schalter auf deine Antwort"><span class="dot" style="background:#f59e0b"></span>${c.waiting} wartet</span>
      <span class="buero-stat" title="Steht mit Kaffee in der Küche"><span class="dot" style="background:#38bdf8"></span>${c.done + c.idle} Pause</span>
      <span class="buero-stat" title="Schläft auf dem Sofa"><span class="dot" style="background:#64748b"></span>${c.exited} Sofa</span>
    `;
  }

  // ---------- Pixel-Zeichenroutinen ----------
  function rect(x, y, w, h, col) {
    ctx.fillStyle = col;
    ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  }

  function drawRoom(t) {
    rect(0, 0, VW, VH, '#1e222d');

    // Wand oben
    rect(0, 0, VW, 34, '#2c3242');
    rect(0, 32, VW, 3, '#151821');

    // Teppich-Karos im Arbeitsbereich (links: x=0..258)
    for (let y = 35; y < VH; y += 16) {
      for (let x = 0; x < 258; x += 16) {
        if (((x + y) / 16) % 2 === 0) rect(x, y, 16, 16, '#222734');
      }
    }

    // Küchen- & Lounge-Boden rechts (x=258..VW)
    rect(258, 35, VW - 258, VH - 35, '#272b36');
    for (let y = 35; y < 120; y += 12) {
      for (let x = 260; x < VW; x += 12) {
        if (((x + y) / 12) % 2 === 0) rect(x, y, 12, 12, '#2d3240');
      }
    }
    rect(258, 35, 2, VH - 35, '#171a24');

    // Fenster in der Nordwand mit Blick auf den Abendhimmel / Stadt-Silhouette
    const winXs = [24, 96, 168];
    for (const wx of winXs) {
      rect(wx, 5, 48, 22, '#0f172a');
      rect(wx + 2, 7, 44, 18, '#1e1b4b');
      rect(wx + 6, 15, 8, 10, '#0f172a');
      rect(wx + 16, 12, 10, 13, '#1e293b');
      rect(wx + 30, 16, 9, 9, '#0f172a');
      rect(wx + 18, 14, 2, 2, '#fde047');
      rect(wx + 22, 18, 2, 2, '#fde047');
      rect(wx + 8, 17, 2, 2, '#38bdf8');
      rect(wx + 23, 7, 2, 18, '#334155');
      rect(wx + 2, 15, 44, 2, '#334155');
    }

    // Analoge Wanduhr
    rect(232, 7, 16, 16, '#e2e8f0');
    rect(233, 8, 14, 14, '#0f172a');
    rect(239, 10, 2, 5, '#f8fafc');
    rect(239, 14, 4, 2, '#ef4444');

    // Küchenzeile rechts oben mit Kaffeemaschine & Wasserspender
    rect(268, 30, 64, 20, '#475569');
    rect(268, 36, 64, 6, '#94a3b8');
    rect(268, 42, 64, 12, '#334155');
    rect(276, 24, 14, 13, '#1e293b');
    rect(278, 26, 10, 4, '#dc2626');
    rect(281, 32, 4, 4, '#78350f');
    rect(286, 27, 2, 2, Math.floor(t * 2) % 2 ? '#22c55e' : '#4ade80');

    // Wasserspender
    rect(316, 22, 10, 14, '#38bdf8');
    rect(315, 34, 12, 18, '#e2e8f0');

    // Stehtisch in der Kaffeeküche
    rect(292, 78, 16, 10, '#78350f');
    rect(293, 79, 14, 8, '#a16207');
    rect(298, 88, 4, 6, '#334155');

    // Info-Schalter / Rückfragen-Whiteboard (rechts Mitte)
    rect(268, 114, 62, 14, '#f8fafc');
    rect(269, 115, 60, 12, '#0f172a');
    rect(273, 117, 6, 5, '#facc15');
    rect(281, 118, 6, 5, '#f43f5e');
    rect(289, 117, 6, 5, '#38bdf8');
    rect(298, 117, 26, 2, '#f59e0b');
    rect(298, 121, 18, 2, '#94a3b8');

    // Sofa rechts unten
    rect(272, 168, 54, 18, '#7c2d12');
    rect(274, 173, 50, 14, '#9a3412');
    rect(270, 171, 5, 16, '#7c2d12');
    rect(323, 171, 5, 16, '#7c2d12');
    rect(274, 190, 50, 12, '#1e3a5f');
    rect(276, 192, 46, 8, '#2563eb');

    drawPlant(10, 38);
    drawPlant(246, 38);
    drawPlant(10, 182);
  }

  function drawPlant(x, y) {
    rect(x + 2, y + 8, 8, 7, '#b45309');
    rect(x + 1, y + 7, 10, 2, '#d97706');
    rect(x + 3, y + 1, 6, 6, '#15803d');
    rect(x, y + 3, 4, 4, '#22c55e');
    rect(x + 8, y + 2, 4, 5, '#16a34a');
    rect(x + 4, y - 2, 4, 4, '#4ade80');
  }

  function drawDeskBase(d, deskIdx, occupied, status, subCount, t) {
    const x = d.x - 16;
    const y = d.y - 12;

    // Cubicle-Trennwände (links, hinten, rechts) + Bodenmatte bei aktiven Subagenten
    const hasSubs = subCount > 0;
    const wallCol = hasSubs ? '#3b4259' : '#2d3344';
    const trimCol = hasSubs ? '#64748b' : '#475569';
    if (hasSubs) {
      // Leicht hervorgehobene Team-Cubicle-Matte auf dem Boden
      rect(d.x - 26, d.y - 16, 52, 34, 'rgba(56, 189, 248, 0.06)');
    }
    // Hintere & seitliche niedrige Cubicle-Wände
    rect(d.x - 24, d.y - 16, 48, 3, wallCol);
    rect(d.x - 24, d.y - 16, 48, 1, trimCol);
    rect(d.x - 24, d.y - 16, 2, 26, wallCol);
    rect(d.x + 22, d.y - 16, 2, 26, wallCol);

    // Schatten + Tischplatte (Holz)
    rect(x + 1, y + 14, 34, 4, 'rgba(0,0,0,0.35)');
    rect(x, y, 34, 14, '#5c4033');
    rect(x + 1, y + 1, 32, 11, '#8b5a2b');
    rect(x + 2, y + 13, 3, 5, '#334155');
    rect(x + 29, y + 13, 3, 5, '#334155');

    // Kleine Seiten-Laptops auf den Tischecken, wenn Subagenten im Cubicle mitarbeiten
    if (subCount >= 1) {
      rect(x + 2, y + 2, 6, 4, '#0f172a');
      rect(x + 3, y + 3, 4, 2, '#38bdf8');
    }
    if (subCount >= 2) {
      rect(x + 26, y + 2, 6, 4, '#0f172a');
      rect(x + 27, y + 3, 4, 2, '#a855f7');
    }

    // Haupt-Monitor in der Mitte
    rect(x + 10, y - 7, 14, 9, '#0f172a');
    if (occupied && (status === 'running' || status === 'starting')) {
      const glow = status === 'running' ? '#0ea5e9' : '#eab308';
      rect(x + 11, y - 6, 12, 7, '#082f49');
      const lineOff = Math.floor(t * 8) % 3;
      rect(x + 12, y - 5 + lineOff, 7, 1, glow);
      rect(x + 12, y - 3, 9, 1, '#4ade80');
      rect(x + 12, y - 1, 5, 1, '#f472b6');
    } else {
      rect(x + 11, y - 6, 12, 7, '#1e293b');
    }
    rect(x + 15, y + 2, 4, 2, '#334155');

    // Kaffeetasse (wenn rechts kein zweiter Subagent-Laptop steht)
    if (subCount < 2) {
      rect(x + 27, y + 3, 3, 4, '#f8fafc');
    }
  }

  // Kleine Helfer-Figur (Subagent) im selben Cubicle wie der Haupt-Agent
  function drawSubCharacter(sa, t, isHovered) {
    const x = Math.round(sa.x);
    const y = Math.round(sa.y);
    const ap = sa.appearance;
    const isRunning = sa.sub.status === 'running';
    const typeBounce = isRunning ? (Math.floor(t * 14 + ap.phase) % 2) : 0;
    const by = y;

    // Hover-Ring / Schatten
    if (isHovered) {
      rect(x - 6, y + 5, 12, 3, 'rgba(168, 85, 247, 0.55)');
    } else {
      rect(x - 4, y + 6, 8, 2, 'rgba(0, 0, 0, 0.35)');
    }

    // Kleiner Rollhocker unter dem Subagenten
    rect(x - 3, by + 3, 6, 2, '#334155');
    rect(x - 1, by + 5, 2, 2, '#0f172a');

    // Beine / Rock (kompakte 75%-Größe)
    rect(x - 2, by + 2, 2, 3, ap.pants);
    rect(x + 1, by + 2, 2, 3, ap.pants);

    // Oberkörper (Hemd in Agentenfarbe + helles Azubi-/Helfer-Abzeichen)
    rect(x - 3, by - 3, 7, 5, ap.shirt.main);
    rect(x - 2, by - 2, 5, 3, ap.shirt.dark);
    // Tippende Arme
    rect(x - 4, by - 2 + typeBounce, 1, 3, ap.skin);
    rect(x + 4, by - 2 + (1 - typeBounce), 1, 3, ap.skin);

    // Kopf (6×6 Pixel)
    const hy = by - 9;
    rect(x - 3, hy, 6, 6, ap.skin);
    // Augen
    rect(x - 2, hy + 2, 1, 2, '#0f172a');
    rect(x + 1, hy + 2, 1, 2, '#0f172a');

    // Haare + Headset-Bügel (typisch für Subagenten)
    rect(x - 3, hy - 1, 6, 2, ap.hair);
    if (ap.isFemale) {
      rect(x - 4, hy, 1, 6, ap.hair);
      rect(x + 3, hy, 1, 6, ap.hair);
    }
    // Kleines leuchtendes Headset am Ohr
    rect(x - 4, hy + 2, 1, 2, isRunning ? '#22c55e' : '#94a3b8');

    // Aktivitäts-Punkt über dem Kopf
    if (isRunning) {
      const pulse = Math.floor(t * 8 + ap.phase) % 2;
      rect(x - 1, hy - 4 - pulse, 2, 2, '#38bdf8');
    } else {
      rect(x - 1, hy - 4, 2, 2, '#22c55e');
    }
  }

  function drawCharacter(a, t, isHovered) {
    const x = Math.round(a.x);
    const y = Math.round(a.y);
    const ap = a.appearance;
    const st = a.session.status;
    const moving = Math.hypot(a.tx - a.x, a.ty - a.y) > 1.5;
    const walkBounce = moving ? (Math.floor(t * 10 + ap.phase) % 2) : 0;
    const typeBounce = (!moving && st === 'running') ? (Math.floor(t * 12 + ap.phase) % 2) : 0;

    if (isHovered) {
      rect(x - 8, y + 7, 16, 4, 'rgba(56, 189, 248, 0.45)');
    } else {
      rect(x - 6, y + 8, 12, 3, 'rgba(0, 0, 0, 0.35)');
    }

    const sleeping = !moving && st === 'exited';
    const by = y - walkBounce + (sleeping ? 2 : 0);

    // Beine / Rock
    if (ap.isFemale && ap.hairStyle !== 2) {
      rect(x - 4, by + 3, 8, 3, ap.pants);
      rect(x - 3, by + 6, 2, 3 - walkBounce, ap.skin);
      rect(x + 1, by + 6, 2, 3 - (1 - walkBounce) * (moving ? 1 : 0), ap.skin);
    } else {
      rect(x - 3, by + 3, 3, 5 - walkBounce, ap.pants);
      rect(x, by + 3, 3, 5 - (moving ? (1 - walkBounce) : 0), ap.pants);
    }
    rect(x - 4, by + 8, 3, 2, '#0f172a');
    rect(x + 1, by + 8, 3, 2, '#0f172a');

    // Oberkörper
    rect(x - 5, by - 4, 10, 8, ap.shirt.main);
    rect(x - 4, by - 3, 8, 6, ap.shirt.dark);
    rect(x - 1, by - 4, 2, 2, '#f8fafc');

    // Arme
    if (st === 'waiting' && !moving) {
      const wave = Math.floor(t * 6) % 2;
      rect(x - 7, by - 3, 2, 5, ap.shirt.main);
      rect(x + 5, by - 8 - wave, 2, 6, ap.shirt.main);
      rect(x + 5, by - 9 - wave, 2, 2, ap.skin);
    } else if (st === 'running' && !moving) {
      rect(x - 6, by - 3 + typeBounce, 2, 5, ap.shirt.main);
      rect(x + 4, by - 3 + (1 - typeBounce), 2, 5, ap.shirt.main);
      rect(x - 6, by + 1 + typeBounce, 2, 2, ap.skin);
      rect(x + 4, by + 1 + (1 - typeBounce), 2, 2, ap.skin);
    } else if ((st === 'done' || st === 'idle') && !moving) {
      rect(x - 6, by - 3, 2, 5, ap.shirt.main);
      rect(x + 4, by - 3, 2, 4, ap.shirt.main);
      rect(x + 5, by - 2, 3, 4, '#f8fafc');
      rect(x + 6, by - 1, 2, 2, '#b45309');
    } else {
      rect(x - 6, by - 3, 2, 5, ap.shirt.main);
      rect(x + 4, by - 3, 2, 5, ap.shirt.main);
    }

    // Kopf
    const hy = by - 12;
    rect(x - 4, hy, 8, 8, ap.skin);

    // Gesicht
    if (sleeping) {
      rect(x - 3, hy + 4, 2, 1, '#1e293b');
      rect(x + 1, hy + 4, 2, 1, '#1e293b');
    } else {
      const blink = (Math.floor(t * 2 + ap.phase * 3) % 17) === 0;
      const eh = blink ? 1 : 2;
      rect(x - 3, hy + 3, 2, eh, '#0f172a');
      rect(x + 1, hy + 3, 2, eh, '#0f172a');
      if (ap.glasses) {
        rect(x - 4, hy + 2, 4, 1, '#38bdf8');
        rect(x, hy + 2, 4, 1, '#38bdf8');
      }
    }

    // Haare
    rect(x - 5, hy - 2, 10, 3, ap.hair);
    rect(x - 5, hy, 1, 4, ap.hair);
    rect(x + 4, hy, 1, 4, ap.hair);
    if (ap.isFemale) {
      if (ap.hairStyle === 0) {
        rect(x - 6, hy, 2, 9, ap.hair);
        rect(x + 4, hy, 2, 9, ap.hair);
      } else if (ap.hairStyle === 1) {
        rect(x - 2, hy - 5, 4, 3, ap.hair);
        rect(x - 3, hy - 2, 6, 1, '#f43f5e');
        rect(x - 5, hy, 1, 7, ap.hair);
        rect(x + 4, hy, 1, 7, ap.hair);
      } else {
        rect(x + 5, hy + 1, 3, 6, ap.hair);
        rect(x + 4, hy + 1, 1, 2, '#facc15');
      }
    } else {
      if (ap.hairStyle === 1) {
        rect(x - 2, hy - 3, 5, 2, ap.hair);
      } else if (ap.hairStyle === 2) {
        rect(x - 3, hy + 6, 6, 2, ap.hair);
      }
    }

    // Bürostuhl-Rückenlehne
    if (a.atDesk && !moving) {
      rect(x - 5, y + 1, 10, 6, '#1e293b');
      rect(x - 4, y + 2, 8, 4, '#334155');
      rect(x - 1, y + 7, 2, 3, '#0f172a');
      rect(x - 4, y + 9, 8, 1, '#475569');
    }

    drawStatusBubble(x, hy - 6, st, t, ap.phase);
  }

  function drawStatusBubble(x, y, st, t, phase) {
    if (st === 'waiting') {
      const bob = Math.round(Math.sin(t * 7 + phase) * 1.5);
      const by = y - 10 + bob;
      rect(x - 6, by, 12, 9, '#fef08a');
      rect(x - 5, by + 1, 10, 7, '#f59e0b');
      rect(x - 1, by + 9, 2, 2, '#fef08a');
      rect(x - 1, by + 2, 2, 3, '#0f172a');
      rect(x - 1, by + 6, 2, 1, '#0f172a');
    } else if (st === 'done') {
      const by = y - 8;
      rect(x - 5, by, 10, 7, '#dcfce7');
      rect(x - 4, by + 1, 8, 5, '#16a34a');
      rect(x - 2, by + 3, 1, 2, '#ffffff');
      rect(x - 1, by + 4, 1, 1, '#ffffff');
      rect(x, by + 3, 1, 1, '#ffffff');
      rect(x + 1, by + 2, 1, 1, '#ffffff');
    }
  }

  function tickAndDraw(now) {
    const dt = Math.min(0.1, (now - lastTick) / 1000);
    lastTick = now;
    const t = now / 1000;

    if (!canvas || !ctx || !rootEl || !rootEl.isConnected) {
      rafId = requestAnimationFrame(tickAndDraw);
      return;
    }

    // Bewegung der Haupt-Agenten
    for (const a of actors.values()) {
      const dx = a.tx - a.x;
      const dy = a.ty - a.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 0.6) {
        const speed = 42;
        const step = Math.min(dist, speed * dt);
        a.x += (dx / dist) * step;
        a.y += (dy / dist) * step;
      } else {
        a.x = a.tx;
        a.y = a.ty;
        if (!a.atDesk && (a.session.status === 'done' || a.session.status === 'idle')) {
          a.wanderTimer -= dt;
          if (a.wanderTimer <= 0) {
            a.wanderTimer = 3 + Math.random() * 5;
            a.tx = Math.max(268, Math.min(324, a.tx + (Math.random() - 0.5) * 14));
            a.ty = Math.max(60, Math.min(108, a.ty + (Math.random() - 0.5) * 10));
          }
        }
      }
    }

    // Dampf & Zzz
    if (Math.random() < 0.18) {
      steamParticles.push({ x: 282 + (Math.random() - 0.5) * 3, y: 23, life: 1 });
    }
    for (const a of actors.values()) {
      if (a.session.status === 'exited' && Math.hypot(a.tx - a.x, a.ty - a.y) < 2 && Math.random() < 0.04) {
        zzzParticles.push({ x: a.x + 3, y: a.y - 14, life: 1 });
      }
    }

    drawRoom(t);

    // Alle Cubicles, Haupt-Agenten und Subagenten nach Y-Koordinate sortiert zeichnen
    const renderables = [];
    DESKS.forEach((d, idx) => {
      const occ = [...actors.values()].find(a => a.deskIdx === idx && a.atDesk && Math.hypot(a.tx - a.x, a.ty - a.y) < 4);
      const subsInDesk = [...subActors.values()].filter(sa => sa.deskIdx === idx).length;
      renderables.push({
        y: d.y,
        draw: () => drawDeskBase(d, idx, !!occ, occ?.session.status, subsInDesk, t),
      });
    });
    for (const sa of subActors.values()) {
      renderables.push({
        y: sa.y + 1,
        draw: () => drawSubCharacter(sa, t, hoveredItem?.kind === 'sub' && hoveredItem.actor.id === sa.id),
      });
    }
    for (const a of actors.values()) {
      renderables.push({
        y: a.y + (a.atDesk ? 2 : 0),
        draw: () => drawCharacter(a, t, hoveredItem?.kind === 'main' && hoveredItem.actor.id === a.id),
      });
    }
    renderables.sort((a, b) => a.y - b.y);
    for (const r of renderables) r.draw();

    // Partikel
    steamParticles = steamParticles.filter(p => {
      p.y -= dt * 8;
      p.life -= dt * 0.9;
      if (p.life <= 0) return false;
      rect(p.x, p.y, 2, 2, `rgba(226, 232, 240, ${p.life * 0.5})`);
      return true;
    });
    zzzParticles = zzzParticles.filter(p => {
      p.y -= dt * 7;
      p.x += dt * 3;
      p.life -= dt * 0.6;
      if (p.life <= 0) return false;
      ctx.fillStyle = `rgba(148, 163, 184, ${p.life})`;
      ctx.font = 'bold 6px monospace';
      ctx.fillText('z', Math.round(p.x), Math.round(p.y));
      return true;
    });

    // Namensschilder
    if (showLabels) {
      ctx.font = '6px ui-monospace, Consolas, monospace';
      ctx.textAlign = 'center';
      for (const a of actors.values()) {
        const lbl = shortName(a.session);
        const lx = Math.round(a.x);
        const ly = Math.round(a.y + 15);
        const w = Math.ceil(ctx.measureText(lbl).width) + 4;
        rect(lx - w / 2, ly - 5, w, 7, 'rgba(15, 23, 42, 0.78)');
        ctx.fillStyle = (hoveredItem?.kind === 'main' && hoveredItem.actor.id === a.id) ? '#38bdf8' : '#e2e8f0';
        ctx.fillText(lbl, lx, ly);
      }
    }

    // Zonen-Beschriftungen
    ctx.font = '5px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(148, 163, 184, 0.55)';
    ctx.fillText('☕ KAFFEEKÜCHE', 266, 58);
    ctx.fillText('❓ RÜCKFRAGEN', 266, 133);
    ctx.fillText('🛋️ FEIERABEND', 266, 165);

    rafId = requestAnimationFrame(tickAndDraw);
  }

  function eventToVirtual(ev) {
    const r = canvas.getBoundingClientRect();
    const scaleX = VW / r.width;
    const scaleY = VH / r.height;
    return {
      vx: (ev.clientX - r.left) * scaleX,
      vy: (ev.clientY - r.top) * scaleY,
      cx: ev.clientX - r.left,
      cy: ev.clientY - r.top,
      rect: r,
    };
  }

  function hitTest(vx, vy) {
    // Zuerst Subagenten prüfen (kleinere Trefferfläche im Cubicle)
    for (const sa of subActors.values()) {
      const d = Math.hypot(vx - sa.x, vy - (sa.y - 2));
      if (d < 8) return { kind: 'sub', actor: sa };
    }
    let best = null;
    let bestDist = 14;
    for (const a of actors.values()) {
      const d = Math.hypot(vx - a.x, vy - (a.y - 3));
      if (d < bestDist) {
        bestDist = d;
        best = a;
      }
    }
    return best ? { kind: 'main', actor: best } : null;
  }

  function updateTooltip(hit, pos) {
    if (!tooltipEl) return;
    if (!hit) {
      tooltipEl.hidden = true;
      return;
    }

    if (hit.kind === 'sub') {
      const sa = hit.actor;
      const sub = sa.sub;
      const role = sa.appearance.isFemale ? 'Subagentin' : 'Subagent';
      const shirt = sa.appearance.shirt;
      tooltipEl.innerHTML = `
        <div class="tt-head">
          <span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#a855f7"></span>
          <span></span>
        </div>
        <div class="tt-role">${shirt.label}-${role} (${escapeHtml(sub.role || 'Helfer')}${sub.model ? ' · ' + escapeHtml(sub.model) : ''}) · Cubicle von „${escapeHtml(sa.parentSession?.name || '')}"</div>
        <div class="tt-status"><b>${sub.status === 'running' ? 'arbeitet im Cubicle' : 'Aufgabe erledigt'}</b>${sub.detail ? '<br>' + escapeHtml(sub.detail) : ''}</div>
        <div class="tt-hint">Klicken, um die Haupt-Session zu öffnen</div>
      `;
      tooltipEl.querySelector('.tt-head span:last-child').textContent = sub.name;
    } else {
      const a = hit.actor;
      const s = a.session;
      const role = a.appearance.isFemale ? 'Entwicklerin' : 'Entwickler';
      const shirt = a.appearance.shirt;
      const subs = pluginState?.subagents?.[s.id] || [];
      const subInfo = subs.length
        ? `<div class="tt-status" style="color:#c084fc;margin-top:4px">👥 <b>${subs.length} Subagent${subs.length === 1 ? '' : 'en'} im Cubicle:</b><br>${subs.map(x => '• ' + escapeHtml(x.name) + ' (' + (x.status === 'running' ? 'aktiv' : 'fertig') + ')').join('<br>')}</div>`
        : '';
      tooltipEl.innerHTML = `
        <div class="tt-head">
          <span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${shirt.main}"></span>
          <span></span>
        </div>
        <div class="tt-role">${shirt.label}-${role} · ${escapeHtml(s.cwd || '')}</div>
        <div class="tt-status"><b>${STATUS_TEXT[s.status] || s.status}</b>${s.detail ? '<br>' + escapeHtml(s.detail) : ''}</div>
        ${subInfo}
        <div class="tt-hint">Klicken, um Terminal-Session zu öffnen</div>
      `;
      tooltipEl.querySelector('.tt-head span:last-child').textContent = s.name;
    }

    tooltipEl.hidden = false;
    const maxX = Math.max(10, pos.rect.width - 280);
    const maxY = Math.max(10, pos.rect.height - 130);
    tooltipEl.style.left = Math.min(maxX, Math.max(6, pos.cx)) + 'px';
    tooltipEl.style.top = Math.min(maxY, Math.max(6, pos.cy)) + 'px';
  }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  function mount(el) {
    rootEl = el;
    el.innerHTML = `
      <div class="buero-wrap">
        <div class="buero-toolbar">
          <span class="title">🏢 Pixel-Büro</span>
          <div class="buero-stats"></div>
          <span class="spacer"></span>
          <button class="buero-btn b-labels ${showLabels ? 'active' : ''}" title="Namensschilder unter den Figuren ein-/ausblenden">Namen</button>
          <button class="buero-btn b-exited ${hideExited ? 'active' : ''}" title="Beendete Sessions auf dem Sofa ausblenden">Ohne Feierabend</button>
        </div>
        <div class="buero-stage">
          <canvas class="buero-canvas" width="${VW}" height="${VH}"></canvas>
          <div class="buero-tooltip" hidden></div>
        </div>
      </div>
    `;
    statsEl = el.querySelector('.buero-stats');
    canvas = el.querySelector('.buero-canvas');
    ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    tooltipEl = el.querySelector('.buero-tooltip');

    const btnLabels = el.querySelector('.b-labels');
    btnLabels.addEventListener('click', () => {
      showLabels = !showLabels;
      btnLabels.classList.toggle('active', showLabels);
      try { localStorage.setItem('aioc-buero-labels', showLabels ? '1' : '0'); } catch {}
    });

    const btnExited = el.querySelector('.b-exited');
    btnExited.addEventListener('click', () => {
      hideExited = !hideExited;
      btnExited.classList.toggle('active', hideExited);
      try { localStorage.setItem('aioc-buero-hide-exited', hideExited ? '1' : '0'); } catch {}
      syncActors();
    });

    canvas.addEventListener('mousemove', ev => {
      const pos = eventToVirtual(ev);
      const hit = hitTest(pos.vx, pos.vy);
      hoveredItem = hit;
      canvas.style.cursor = hit ? 'pointer' : 'default';
      updateTooltip(hit, pos);
    });

    canvas.addEventListener('mouseleave', () => {
      hoveredItem = null;
      if (tooltipEl) tooltipEl.hidden = true;
    });

    canvas.addEventListener('click', ev => {
      const pos = eventToVirtual(ev);
      const hit = hitTest(pos.vx, pos.vy);
      if (!hit || !api?.openSession) return;
      const targetSessionId = hit.kind === 'sub' ? hit.actor.parentId : hit.actor.id;
      api.openSession(targetSessionId);
    });

    syncActors();
    if (!rafId) {
      lastTick = performance.now();
      rafId = requestAnimationFrame(tickAndDraw);
    }
  }

  AiocPlugins.register({
    id: ID,
    tab(st, a) {
      api = a || api;
      if (st) pluginState = st;
      const list = api?.sessions ? api.sessions() : [];
      const active = list.filter(s => s.status === 'running' || s.status === 'starting').length;
      const waiting = list.filter(s => s.status === 'waiting').length;
      const subActive = pluginState?.totalActive || 0;
      const parts = [];
      if (active) parts.push(`${active}${subActive ? `+${subActive}` : ''} aktiv`);
      else if (subActive) parts.push(`${subActive} Sub`);
      if (waiting) parts.push(`${waiting} ?`);
      return {
        title: 'Pixel-Büro',
        badge: parts.join(' · ') || `${list.length}`,
        hot: waiting > 0,
        subline: waiting
          ? `${waiting} am Rückfragen-Board`
          : active
            ? `${active} am Tisch${subActive ? ` (+${subActive} Sub)` : ''}`
            : 'Alle in der Kaffeeküche',
      };
    },
    mount(el, a) {
      api = a;
      mount(el);
    },
    update(st, a) {
      api = a;
      if (st) pluginState = st;
      syncActors();
    },
  });
})();
