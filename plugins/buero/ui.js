// Pixel-Büro Plugin — Full-Bleed High-DPI + 16-Bit Pixel-Art Office Visualizer
// Dynamically sizes the virtual pixel-art grid (VW × VH) to match the stage aspect ratio
// with strict 1:1 square pixels (zero stretching, zero letterbox bars) and renders
// razor-sharp native High-DPI text badges with 2D collision avoidance.

(function () {
  const ID = 'buero';

  // Dynamic virtual pixel-art dimensions (recomputed on resize to fill stage 100% with 1:1 square pixels)
  let VW = 460;
  let VH = 340;
  let layout = null;

  // Color palettes for characters (base + shadow + highlight tones)
  const SKIN_TONES = [
    { base: '#f7d2b4', shade: '#d9a986' },
    { base: '#ecc09b', shade: '#c8966e' },
    { base: '#dfa678', shade: '#b87d52' },
    { base: '#c48656', shade: '#996238' },
    { base: '#945f39', shade: '#6e4324' },
    { base: '#694329', shade: '#492c19' },
  ];

  const HAIR_COLORS = [
    { base: '#231b18', hi: '#3d302b' },
    { base: '#4a3020', hi: '#6b4730' },
    { base: '#7c4728', hi: '#a3613a' },
    { base: '#d49e43', hi: '#ecc06b' },
    { base: '#b5452e', hi: '#d96248' },
    { base: '#7b8494', hi: '#a3adbd' },
    { base: '#38598a', hi: '#547cb8' },
    { base: '#6f428a', hi: '#935db3' },
  ];

  const SHIRT_COLORS = [
    { base: '#3b82f6', shade: '#2563eb', accent: '#93c5fd' },
    { base: '#10b981', shade: '#059669', accent: '#6ee7b7' },
    { base: '#f59e0b', shade: '#d97706', accent: '#fcd34d' },
    { base: '#ef4444', shade: '#dc2626', accent: '#fca5a5' },
    { base: '#8b5cf6', shade: '#7c3aed', accent: '#c4b5fd' },
    { base: '#ec4899', shade: '#db2777', accent: '#f9a8d4' },
    { base: '#06b6d4', shade: '#0891b2', accent: '#67e8f9' },
    { base: '#84cc16', shade: '#65a30d', accent: '#bef264' },
    { base: '#f97316', shade: '#ea580c', accent: '#fdba74' },
    { base: '#6366f1', shade: '#4f46e5', accent: '#a5b4fc' },
  ];

  const PANTS_COLORS = [
    { base: '#1e293b', shade: '#0f172a' },
    { base: '#334155', shade: '#1e293b' },
    { base: '#3b2f2f', shade: '#261e1e' },
    { base: '#1e3a5f', shade: '#152944' },
    { base: '#3f3f46', shade: '#27272a' },
  ];

  // Runtime state
  let api = null;
  let pluginState = { sessions: {}, totalActive: 0 };
  let rootEl = null;
  let stageEl = null;
  let canvas = null;
  let ctx = null;
  let offCanvas = null;
  let offCtx = null;
  let statsEl = null;
  let tooltipEl = null;
  let resizeObserver = null;
  let rafId = null;
  let lastTick = 0;
  let animClock = 0;

  let viewTransform = { scale: 2, cssW: 920, cssH: 680, dpr: 1 };

  const actors = new Map();
  let hoveredItem = null;
  let labelBoxes = [];

  // Office pet: Pink Alpaca ("Flocke") roaming the office
  const alpaca = {
    name: 'Flocke',
    x: 0,
    y: 0,
    tx: 0,
    ty: 0,
    facing: 1,
    mode: 'wander', // 'wander' | 'idle' | 'sleep' | 'graze' | 'happy'
    timer: 0,
    heartsUntil: 0,
    initialized: false,
  };

  let showLabels = true;
  let hideExited = false;
  let localWeather = null;
  let lastWeatherFetch = 0;
  let weatherFetching = false;
  let lastClockMinute = -1;
  let lastStatsArgs = [0, 0, 0, 0];
  try {
    showLabels = localStorage.getItem('aioc-buero-labels') !== '0';
    hideExited = localStorage.getItem('aioc-buero-hide-exited') === '1';
    const savedW = JSON.parse(localStorage.getItem('aioc-buero-weather') || 'null');
    if (savedW && typeof savedW.temp === 'number') {
      localWeather = savedW;
      lastWeatherFetch = savedW.fetchedAt || 0;
    }
  } catch {}

  const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast?latitude=52.0302&longitude=8.5325&current=temperature_2m,weather_code,is_day,cloud_cover,precipitation,rain,showers,snowfall,wind_speed_10m&daily=sunrise,sunset&timezone=Europe%2FBerlin&forecast_days=1';
  const WEATHER_TTL_MS = 15 * 60 * 1000;

  function ensureWeather() {
    const now = Date.now();
    if (pluginState?.weather && now - (pluginState.weather.fetchedAt || 0) < WEATHER_TTL_MS) {
      localWeather = pluginState.weather;
      return;
    }
    if (weatherFetching || (localWeather && now - lastWeatherFetch < WEATHER_TTL_MS)) return;
    if (typeof fetch !== 'function') return;
    weatherFetching = true;
    lastWeatherFetch = now;
    fetch(WEATHER_URL)
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        if (!data?.current) return;
        localWeather = {
          city: 'Bielefeld',
          temp: data.current.temperature_2m,
          code: data.current.weather_code,
          isDay: data.current.is_day,
          cloudCover: data.current.cloud_cover,
          precip: data.current.precipitation,
          snowfall: data.current.snowfall,
          windSpeed: data.current.wind_speed_10m,
          sunrise: data.daily?.sunrise?.[0] || null,
          sunset: data.daily?.sunset?.[0] || null,
          fetchedAt: Date.now(),
        };
        try { localStorage.setItem('aioc-buero-weather', JSON.stringify(localWeather)); } catch {}
        updateStatsBar(...lastStatsArgs);
      })
      .catch(() => {})
      .finally(() => { weatherFetching = false; });
  }

  function parseIsoMinutes(iso) {
    if (!iso || typeof iso !== 'string') return null;
    const m = /T(\d{2}):(\d{2})/.exec(iso);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }

  function wmoInfo(code, isDay) {
    const c = Number(code ?? -1);
    if (c === 0) return { icon: isDay ? '☀️' : '🌙', text: 'Klar', kind: 'clear' };
    if (c === 1) return { icon: isDay ? '🌤️' : '🌙', text: 'Überwiegend klar', kind: 'partly' };
    if (c === 2) return { icon: isDay ? '⛅' : '☁️', text: 'Bewölkt', kind: 'cloudy' };
    if (c === 3) return { icon: '☁️', text: 'Bedeckt', kind: 'overcast' };
    if (c === 45 || c === 48) return { icon: '🌫️', text: 'Nebel', kind: 'fog' };
    if (c >= 51 && c <= 57) return { icon: '🌦️', text: 'Nieselregen', kind: 'rain' };
    if (c === 61 || c === 80) return { icon: '🌧️', text: 'Leichter Regen', kind: 'rain' };
    if (c === 63 || c === 81) return { icon: '🌧️', text: 'Regen', kind: 'rain' };
    if (c >= 65 && c <= 67 || c === 82) return { icon: '🌧️', text: 'Starker Regen', kind: 'rain' };
    if ((c >= 71 && c <= 77) || c === 85 || c === 86) return { icon: '🌨️', text: 'Schneefall', kind: 'snow' };
    if (c >= 95) return { icon: '⛈️', text: 'Gewitter', kind: 'storm' };
    return { icon: isDay ? '🌤️' : '🌙', text: 'Wechselhaft', kind: 'partly' };
  }

  function getEnvironmentState() {
    ensureWeather();
    const w = pluginState?.weather || localWeather;
    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const seconds = now.getSeconds();
    const nowMin = hours * 60 + minutes + seconds / 60;

    // Jahreszeitlicher Fallback für Sonnenauf-/-untergang in Bielefeld (52.03° N), falls offline
    const month = now.getMonth(); // 0..11
    const summerFactor = Math.cos(((month - 5.5) / 12) * Math.PI * 2); // +1 im Juni, -1 im Dezember
    const defaultSunrise = Math.round(410 - summerFactor * 100); // ~05:10 Sommer, ~08:30 Winter
    const defaultSunset = Math.round(1140 + summerFactor * 165); // ~21:45 Sommer, ~16:15 Winter

    const sunriseMin = parseIsoMinutes(w?.sunrise) ?? defaultSunrise;
    const sunsetMin = parseIsoMinutes(w?.sunset) ?? defaultSunset;

    const dawnStart = sunriseMin - 45;
    const dawnEnd = sunriseMin + 30;
    const duskStart = sunsetMin - 35;
    const duskEnd = sunsetMin + 45;

    let phase = 'night';
    let dayProgress = 0.5;
    if (nowMin >= dawnStart && nowMin < dawnEnd) {
      phase = 'dawn';
      dayProgress = 0.05;
    } else if (nowMin >= dawnEnd && nowMin < duskStart) {
      phase = 'day';
      dayProgress = Math.max(0, Math.min(1, (nowMin - dawnEnd) / Math.max(1, duskStart - dawnEnd)));
    } else if (nowMin >= duskStart && nowMin < duskEnd) {
      phase = 'dusk';
      dayProgress = 0.95;
    }

    const isDay = phase === 'day' || phase === 'dawn' || phase === 'dusk';
    const info = w ? wmoInfo(w.code, isDay) : { icon: isDay ? '🌤️' : '🌙', text: isDay ? 'Tagsüber' : 'Nachts', kind: 'partly' };
    const cloudCover = typeof w?.cloudCover === 'number'
      ? w.cloudCover
      : (info.kind === 'overcast' || info.kind === 'rain' || info.kind === 'snow' || info.kind === 'storm' ? 95 : info.kind === 'cloudy' ? 65 : info.kind === 'partly' ? 30 : 5);

    const fmtMin = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.floor(m % 60)).padStart(2, '0')}`;
    return {
      hours,
      minutes,
      seconds,
      timeStr: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`,
      phase,
      isDay,
      dayProgress,
      sunriseStr: fmtMin(sunriseMin),
      sunsetStr: fmtMin(sunsetMin),
      hasWeather: !!w,
      temp: typeof w?.temp === 'number' ? Math.round(w.temp) : null,
      tempExact: typeof w?.temp === 'number' ? w.temp.toFixed(1) : null,
      windSpeed: typeof w?.windSpeed === 'number' ? Math.round(w.windSpeed) : null,
      cloudCover,
      kind: info.kind,
      icon: info.icon,
      text: info.text,
    };
  }

  function hashStr(str) {
    let h = 2166136261 >>> 0;
    const s = String(str || '');
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  function appearanceFor(id) {
    const h = hashStr(id);
    return {
      skin: SKIN_TONES[h % SKIN_TONES.length],
      hair: HAIR_COLORS[(h >>> 4) % HAIR_COLORS.length],
      shirt: SHIRT_COLORS[(h >>> 8) % SHIRT_COLORS.length],
      pants: PANTS_COLORS[(h >>> 12) % PANTS_COLORS.length],
      hairStyle: (h >>> 16) % 6,
      glasses: ((h >>> 20) % 5) === 0,
      headphones: ((h >>> 22) % 4) === 0,
      phase: (h % 100) / 10,
    };
  }

  function getRawSubagents(sessionId) {
    const fromDaemon = pluginState?.subagents?.[sessionId];
    if (Array.isArray(fromDaemon)) return fromDaemon;
    const fromLegacy = pluginState?.sessions?.[sessionId]?.active;
    if (Array.isArray(fromLegacy)) return fromLegacy;
    return [];
  }

  function isFreiSession(s) {
    const nm = String(s?.name || '').trim().toLowerCase();
    return nm === '-frei-' || nm.includes('-frei-');
  }

  function classifyStatus(s, rawSubs) {
    if (!s) return 'exited';
    if (s.status === 'exited' || isFreiSession(s)) return 'exited';
    if (s.status === 'waiting') return 'waiting';
    if (s.status === 'running' || s.status === 'starting') return 'active';
    if (Array.isArray(rawSubs) && rawSubs.some(x => x.status === 'running')) return 'active';
    return 'idle';
  }

  // Compute responsive room geometry for current (VW, VH)
  function buildLayout(vw, vh) {
    const wallH = 48;
    const floorH = vh - wallH;
    // Studio occupies ~67% on left, Break/Lounge column occupies ~33% on right (min 148px)
    const rightW = Math.max(148, Math.min(184, Math.round(vw * 0.33)));
    const splitX = vw - rightW;

    // 12 Desks: 4 columns × 3 rows distributed evenly across the studio floor
    const desks = [];
    const padX = 38;
    const usableW = Math.max(220, splitX - padX * 2);
    const colStep = usableW / 3;
    const cols = [
      Math.round(padX),
      Math.round(padX + colStep * 0.96),
      Math.round(padX + colStep * 2.04),
      Math.round(padX + usableW),
    ];
    const aisleX = Math.round((cols[1] + cols[2]) / 2) - 8;

    const topRowY = wallH + Math.max(42, Math.round(floorH * 0.16));
    const botRowY = vh - Math.max(48, Math.round(floorH * 0.18));
    const midRowY = Math.round((topRowY + botRowY) / 2);
    const rows = [topRowY, midRowY, botRowY];

    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < cols.length; c++) {
        desks.push({
          idx: r * 4 + c,
          x: cols[c],
          y: rows[r],
          seatX: cols[c],
          seatY: rows[r] + 12,
        });
      }
    }

    // 3 Right-hand zones (Kitchen, Board, Lounge) distributed across floorH
    const z1Top = wallH;
    const z1H = Math.max(82, Math.round(floorH * 0.30));
    const z2Top = z1Top + z1H;
    const z2H = Math.max(76, Math.round(floorH * 0.27));
    const z3Top = z2Top + z2H;
    const z3H = Math.max(90, vh - z3Top);

    const rxCenter = Math.round(splitX + rightW / 2);
    const rxLeft = splitX + 10;
    const rxRight = vw - 10;

    // Zone 1: Coffee Spots (below counter & around bistro table)
    const counterY = z1Top + 24;
    const bistroY = Math.min(z2Top - 18, counterY + 42);
    const coffeeSpots = [
      { x: splitX + 26, y: bistroY - 2 },
      { x: rxCenter - 22, y: bistroY + 2 },
      { x: rxCenter + 22, y: bistroY + 2 },
      { x: vw - 24, y: bistroY - 2 },
      { x: splitX + 34, y: Math.min(z2Top - 10, bistroY + 16) },
      { x: rxCenter, y: Math.min(z2Top - 10, bistroY + 18) },
      { x: vw - 32, y: Math.min(z2Top - 10, bistroY + 16) },
    ];

    // Zone 2: Rückfragen-Board Spots
    const boardY = z2Top + 20;
    const standY1 = Math.min(z3Top - 18, boardY + 46);
    const standY2 = Math.min(z3Top - 8, standY1 + 16);
    const boardSpots = [
      { x: splitX + 30, y: standY1 },
      { x: rxCenter - 14, y: standY1 + 2 },
      { x: rxCenter + 16, y: standY1 + 2 },
      { x: vw - 28, y: standY1 },
      { x: splitX + 44, y: standY2 },
      { x: vw - 42, y: standY2 },
    ];

    // Zone 3: Feierabend-Lounge Spots (Sofa back row + Middle poufs + Front floor cushions)
    const sofaY = z3Top + 38;
    const remainLounge = Math.max(36, vh - sofaY - 12);
    const row2Y = sofaY + Math.max(20, Math.round(remainLounge * 0.48));
    const row3Y = sofaY + Math.max(34, Math.round(remainLounge * 0.92));

    const sofaLeft = splitX + 28;
    const sofaRight = vw - 28;
    const sofaSpan = Math.max(60, sofaRight - sofaLeft);

    const sofaSpots = [
      // Row 1: 4 seats along the Chesterfield leather sofa
      { x: Math.round(sofaLeft + sofaSpan * 0.08), y: sofaY, pose: 'sit' },
      { x: Math.round(sofaLeft + sofaSpan * 0.36), y: sofaY, pose: 'sit' },
      { x: Math.round(sofaLeft + sofaSpan * 0.64), y: sofaY, pose: 'sit' },
      { x: Math.round(sofaLeft + sofaSpan * 0.92), y: sofaY, pose: 'sit' },
      // Row 2: Left & right armchairs / poufs flanking the coffee table
      { x: splitX + 24, y: row2Y, pose: 'sit' },
      { x: vw - 24, y: row2Y, pose: 'sit' },
      // Row 3: 3 well-spaced front lounge poufs
      { x: Math.round(splitX + rightW * 0.25), y: row3Y, pose: 'sit' },
      { x: Math.round(splitX + rightW * 0.52), y: row3Y, pose: 'sit' },
      { x: Math.round(splitX + rightW * 0.78), y: row3Y, pose: 'sit' },
    ];

    // Wooden bookcase at the top of the studio center aisle (against back wall)
    const bookcase = {
      x: aisleX + 8,
      y: wallH + 10,
      w: 32,
      h: 24,
    };

    // Potted plants across the studio, walls & lounge
    const plants = [
      { x: 14, y: wallH + 20, kind: 'monstera' },
      { x: splitX - 14, y: wallH + 20, kind: 'palm' },
      { x: Math.round((cols[0] + cols[1]) / 2), y: wallH + 11, kind: 'fern' },
      { x: Math.round((cols[2] + cols[3]) / 2), y: wallH + 11, kind: 'cactus' },
      { x: 14, y: Math.round((topRowY + midRowY) / 2), kind: 'ficus' },
      { x: splitX - 14, y: Math.round((topRowY + midRowY) / 2), kind: 'ivy' },
      { x: 14, y: Math.round((midRowY + botRowY) / 2), kind: 'cactus' },
      { x: 14, y: vh - 18, kind: 'snake' },
      { x: splitX - 14, y: vh - 18, kind: 'monstera' },
      { x: splitX + 12, y: vh - 10, kind: 'fern' },
    ];

    return {
      vw,
      vh,
      wallH,
      splitX,
      rightW,
      aisleX,
      topRowY,
      midRowY,
      botRowY,
      rxCenter,
      rxLeft,
      rxRight,
      z1Top,
      z2Top,
      z3Top,
      counterY,
      bistroY,
      boardY,
      sofaY,
      row2Y,
      row3Y,
      desks,
      coffeeSpots,
      boardSpots,
      sofaSpots,
      bookcase,
      plants,
    };
  }

  function syncActors(snapPositions = false) {
    if (!api?.sessions) return;
    if (!layout) layout = buildLayout(VW, VH);

    const list = api.sessions() || [];
    const seen = new Set();

    const activeIds = [];
    const waitingIds = [];
    const idleIds = [];
    const exitedIds = [];

    const now = Date.now();
    for (const s of list) {
      const rawSubs = getRawSubagents(s.id);
      const mode = classifyStatus(s, rawSubs);
      if (hideExited && mode === 'exited') continue;
      seen.add(s.id);

      let a = actors.get(s.id);
      if (!a) {
        const startSpot = layout.coffeeSpots[hashStr(s.id) % layout.coffeeSpots.length];
        a = {
          id: s.id,
          name: s.name || s.id.slice(0, 8),
          tool: s.agent || s.tool || 'claude',
          workdir: s.workdir || '',
          appearance: appearanceFor(s.id),
          x: startSpot.x,
          y: startSpot.y,
          tx: startSpot.x,
          ty: startSpot.y,
          mode: 'idle',
          deskIdx: -1,
          subAgents: [],
          subTotalSeen: 0,
          isNew: true,
        };
        actors.set(s.id, a);
      }

      a.name = s.name || s.id.slice(0, 8);
      a.tool = s.agent || s.tool || 'claude';
      a.workdir = s.workdir || '';
      a.rawStatus = s.status;
      a.mode = mode;
      a.subTotalSeen = Math.max(a.subTotalSeen || 0, rawSubs.length);

      a.subAgents = rawSubs.map((sub, i) => ({
        id: sub.id,
        parentId: s.id,
        parentName: a.name,
        slug: sub.name || sub.slug || sub.role || sub.id.slice(0, 8),
        role: sub.role || 'subagent',
        status: sub.status || 'running',
        detail: sub.detail || '',
        appearance: appearanceFor(sub.id),
        idx: i,
        ageMs: sub.mtimeMs ? Math.max(0, now - sub.mtimeMs) : (sub.ageMs || 0),
      }));

      if (mode === 'active') activeIds.push(s.id);
      else if (mode === 'waiting') waitingIds.push(s.id);
      else if (mode === 'idle') idleIds.push(s.id);
      else exitedIds.push(s.id);
    }

    for (const id of Array.from(actors.keys())) {
      if (!seen.has(id)) actors.delete(id);
    }

    // Stable desk assignment for active & waiting agents
    const usedDesks = new Set();
    const deskSeekers = [...activeIds, ...waitingIds];

    for (const id of deskSeekers) {
      const a = actors.get(id);
      if (a.deskIdx >= 0 && a.deskIdx < layout.desks.length && !usedDesks.has(a.deskIdx)) {
        usedDesks.add(a.deskIdx);
      } else {
        a.deskIdx = -1;
      }
    }

    for (const id of deskSeekers) {
      const a = actors.get(id);
      if (a.deskIdx === -1) {
        const pref = hashStr(id) % layout.desks.length;
        for (let k = 0; k < layout.desks.length; k++) {
          const idx = (pref + k) % layout.desks.length;
          if (!usedDesks.has(idx)) {
            a.deskIdx = idx;
            usedDesks.add(idx);
            break;
          }
        }
      }
    }

    activeIds.forEach((id, idx) => {
      const a = actors.get(id);
      if (a.deskIdx >= 0) {
        const d = layout.desks[a.deskIdx];
        a.tx = d.seatX;
        a.ty = d.seatY;
      } else {
        const sp = layout.coffeeSpots[idx % layout.coffeeSpots.length];
        a.tx = sp.x;
        a.ty = sp.y;
      }
    });

    waitingIds.forEach((id, idx) => {
      const a = actors.get(id);
      const sp = layout.boardSpots[idx % layout.boardSpots.length];
      const ring = Math.floor(idx / layout.boardSpots.length);
      a.tx = sp.x + (ring ? ((idx % 2) * 2 - 1) * 8 : 0);
      a.ty = sp.y + ring * 8;
    });

    idleIds.forEach((id, idx) => {
      const a = actors.get(id);
      a.deskIdx = -1;
      const sp = layout.coffeeSpots[idx % layout.coffeeSpots.length];
      const ring = Math.floor(idx / layout.coffeeSpots.length);
      a.tx = sp.x + (ring ? ((idx % 2) * 2 - 1) * 7 : 0);
      a.ty = sp.y + ring * 8;
    });

    exitedIds.forEach((id, idx) => {
      const a = actors.get(id);
      a.deskIdx = -1;
      const sp = layout.sofaSpots[idx % layout.sofaSpots.length];
      const ring = Math.floor(idx / layout.sofaSpots.length);
      a.tx = sp.x + (ring ? ((idx % 2) * 2 - 1) * 6 : 0);
      a.ty = sp.y + ring * 6;
      a.sofaPose = sp.pose || 'sit';
    });

    for (const a of actors.values()) {
      if (snapPositions || a.isNew) {
        a.x = a.tx;
        a.y = a.ty;
        a.isNew = false;
      }
    }

    updateStatsBar(activeIds.length, waitingIds.length, idleIds.length, exitedIds.length);
  }

  function updateStatsBar(nActive, nWaiting, nIdle, nExited) {
    lastStatsArgs = [nActive, nWaiting, nIdle, nExited];
    if (!statsEl) return;
    let subTotal = 0;
    let subRunning = 0;
    for (const a of actors.values()) {
      for (const sub of a.subAgents || []) {
        subTotal++;
        if (sub.status === 'running') subRunning++;
      }
    }
    if (!subTotal && pluginState?.totalActive) {
      subTotal = pluginState.totalActive;
      subRunning = pluginState.totalActive;
    }
    const subLabel = subRunning === subTotal ? `+${subTotal} Sub` : `${subRunning}/${subTotal} Sub`;
    const env = getEnvironmentState();
    const weatherText = env.temp !== null
      ? `${env.icon} ${env.temp}°C Bielefeld · ${env.timeStr}`
      : `${env.icon} Bielefeld · ${env.timeStr}`;
    const weatherTitle = [
      `Bielefeld · ${env.timeStr} Uhr`,
      env.tempExact !== null ? `${env.text} (${env.tempExact} °C)` : env.text,
      `Bewölkung: ${env.cloudCover}%${env.windSpeed !== null ? ` · Wind: ${env.windSpeed} km/h` : ''}`,
      `Sonnenaufgang: ${env.sunriseStr} · Sonnenuntergang: ${env.sunsetStr}`,
    ].join('\n');
    statsEl.innerHTML = `
      <span class="buero-pill s-active" title="Arbeitet am Schreibtisch"><span class="dot"></span>${nActive} tippt</span>
      ${subTotal > 0 ? `<span class="buero-pill s-sub" title="Sub-Agenten in den Cubicles der Haupt-Sessions"><span class="dot"></span>${subLabel}</span>` : ''}
      <span class="buero-pill s-waiting" title="Wartet auf Rückfrage am Board"><span class="dot"></span>${nWaiting} wartet</span>
      <span class="buero-pill s-idle" title="Kaffeepause"><span class="dot"></span>${nIdle} Pause</span>
      ${!hideExited ? `<span class="buero-pill s-exited" title="Beendet (Feierabend-Sofa)"><span class="dot"></span>${nExited} Sofa</span>` : ''}
      <span class="buero-pill s-weather" title="${escapeHtml(weatherTitle)}">${escapeHtml(weatherText)}</span>
    `;
  }

  // --- Low-level pixel drawing helpers on offCtx (VW×VH) ---
  function px(x, y, w, h, color) {
    offCtx.fillStyle = color;
    offCtx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  }

  function pxOutline(x, y, w, h, fill, outline = '#0c1017') {
    const rx = Math.round(x);
    const ry = Math.round(y);
    const rw = Math.round(w);
    const rh = Math.round(h);
    offCtx.fillStyle = outline;
    offCtx.fillRect(rx - 1, ry, rw + 2, rh);
    offCtx.fillRect(rx, ry - 1, rw, rh + 2);
    offCtx.fillStyle = fill;
    offCtx.fillRect(rx, ry, rw, rh);
  }

  function drawEllipseShadow(cx, cy, rx, ry, alpha = 0.32) {
    offCtx.fillStyle = `rgba(6, 8, 14, ${alpha})`;
    const x0 = Math.round(cx - rx);
    const y0 = Math.round(cy - ry);
    const w = Math.round(rx * 2);
    const h = Math.round(ry * 2);
    if (h <= 2) {
      offCtx.fillRect(x0, y0, w, Math.max(1, h));
      return;
    }
    offCtx.fillRect(x0 + 2, y0, w - 4, h);
    offCtx.fillRect(x0 + 1, y0 + 1, w - 2, h - 2);
    offCtx.fillRect(x0, y0 + 2, w, Math.max(1, h - 4));
  }

  // --- Room Architecture & Background ---
  function drawBackground(t) {
    const { vw, vh, wallH, splitX, aisleX, z2Top, z3Top } = layout;
    const env = getEnvironmentState();
    if (env.minutes !== lastClockMinute) {
      lastClockMinute = env.minutes;
      updateStatsBar(...lastStatsArgs);
    }

    // 1. Main Studio Floor (left x: 0..splitX, y: wallH..vh) — Dark slate tiles
    px(0, wallH, splitX, vh - wallH, '#1b2232');
    for (let y = wallH; y < vh; y += 16) {
      for (let x = 0; x < splitX; x += 16) {
        const alt = ((Math.floor(x / 16) + Math.floor(y / 16)) % 2) === 0;
        px(x, y, 16, 16, alt ? '#1d2536' : '#192030');
        px(x, y, 16, 1, '#151b28');
        px(x, y, 1, 16, '#151b28');
        px(x + 1, y + 1, 14, 1, alt ? '#232c40' : '#1f2738');
      }
    }

    // Center aisle runner rug between desk columns 2 & 3
    px(aisleX, wallH + 6, 16, vh - wallH - 12, '#232d42');
    px(aisleX + 1, wallH + 6, 1, vh - wallH - 12, '#33415c');
    px(aisleX + 14, wallH + 6, 1, vh - wallH - 12, '#33415c');

    // 2. Break & Lounge Floor (right x: splitX..vw, y: wallH..vh) — Warm wood planks
    px(splitX, wallH, vw - splitX, vh - wallH, '#28201b');
    for (let y = wallH; y < vh; y += 8) {
      const rowIdx = Math.floor((y - wallH) / 8);
      const baseWood = rowIdx % 2 === 0 ? '#2b221c' : '#261e18';
      px(splitX, y, vw - splitX, 7, baseWood);
      px(splitX, y + 7, vw - splitX, 1, '#1e1712');
      const offset = (rowIdx * 23) % 36;
      for (let x = splitX + offset; x < vw; x += 36) {
        px(x, y, 1, 7, '#1e1712');
        px(x + 1, y, 1, 7, '#332922');
      }
    }

    // Wall drop shadow on floor
    px(0, wallH, vw, 4, 'rgba(8, 10, 16, 0.45)');
    px(0, wallH + 4, vw, 3, 'rgba(8, 10, 16, 0.2)');

    // Brass / wood room divider strip between studio & break zones
    px(splitX - 1, wallH, 3, vh - wallH, '#121620');
    px(splitX, wallH, 1, vh - wallH, '#64533d');

    // Zone horizontal dividers in right column
    px(splitX + 4, z2Top, vw - splitX - 8, 1, '#18120e');
    px(splitX + 4, z2Top + 1, vw - splitX - 8, 1, '#3d3026');
    px(splitX + 4, z3Top, vw - splitX - 8, 1, '#18120e');
    px(splitX + 4, z3Top + 1, vw - splitX - 8, 1, '#3d3026');

    // 3. Back Wall (y: 0..wallH)
    px(0, 0, vw, 36, '#273045');
    for (let x = 0; x < vw; x += 24) {
      px(x, 4, 1, 32, '#232b3e');
      px(x + 1, 4, 1, 32, '#2b354c');
    }
    px(0, 0, vw, 3, '#141924');
    px(0, 3, vw, 1, '#38445e');

    // Lower wooden wainscoting (y: 36..48)
    px(0, 36, vw, 2, '#3d3128');
    px(0, 38, vw, 7, '#26201d');
    for (let x = 6; x < vw; x += 16) {
      px(x, 39, 12, 5, '#2d2622');
      px(x, 39, 12, 1, '#382f2a');
    }
    px(0, 45, vw, 2, '#171311');
    px(0, 47, vw, 1, '#0e1118');

    // 4. Three Panoramic Skyline Windows (Bielefeld live time & weather) spaced across studio back wall
    const winW = 70;
    const winGap = Math.max(12, Math.floor((splitX - 30 - winW * 3) / 4));
    const winXs = [10 + winGap, 10 + winGap * 2 + winW, 10 + winGap * 3 + winW * 2];
    layout.windows = winXs.map((wx, idx) => ({ x: wx, y: 6, w: winW, h: 28, idx }));
    layout.clock = { cx: splitX - 14, cy: 19, r: 6 };

    // Daylight floor glow beneath windows during daytime / twilight
    if (env.isDay) {
      const glowCol = env.phase === 'dawn' || env.phase === 'dusk'
        ? 'rgba(251, 146, 60, 0.08)'
        : (env.kind === 'clear' || env.kind === 'partly')
          ? 'rgba(186, 230, 253, 0.09)'
          : 'rgba(148, 163, 184, 0.05)';
      for (const wx of winXs) {
        px(wx - 2, wallH + 2, winW + 4, 10, glowCol);
        px(wx + 2, wallH + 12, winW - 4, 6, glowCol);
      }
    }

    drawWindow(winXs[0], 6, winW, 28, t, 0, env);
    drawWindow(winXs[1], 6, winW, 28, t, 1, env);
    drawWindow(winXs[2], 6, winW, 28, t, 2, env);

    // Hanging wall planters between the panoramic windows
    if (winGap >= 14) {
      drawWallPlanter(Math.round(winXs[0] + winW + winGap / 2), 14, 0);
      drawWallPlanter(Math.round(winXs[1] + winW + winGap / 2), 14, 1);
    }

    // 5. Wall Clock near divider & Framed Art on right wall
    drawWallClock(splitX - 14, 19, env);
    drawWallArt(vw - 28, 8);
  }

  function drawWallPlanter(cx, cy, variant) {
    // Brass hanger hook & cord
    px(cx, cy - 5, 1, 5, '#94a3b8');
    px(cx - 2, cy - 1, 5, 1, '#94a3b8');
    // Terracotta / ceramic hanging pot
    pxOutline(cx - 4, cy, 9, 5, variant === 0 ? '#d97706' : '#0284c7', '#0f172a');
    px(cx - 3, cy + 1, 4, 3, variant === 0 ? '#f59e0b' : '#38bdf8');
    // Lush trailing vines
    px(cx - 5, cy - 2, 11, 3, '#15803d');
    px(cx - 3, cy - 3, 7, 2, '#22c55e');
    px(cx - 4, cy + 3, 2, 6, '#16a34a');
    px(cx - 4, cy + 7, 1, 3, '#4ade80');
    px(cx + 3, cy + 3, 2, 7, '#15803d');
    px(cx + 4, cy + 8, 1, 3, '#22c55e');
    px(cx, cy + 4, 2, 4, '#22c55e');
  }

  function drawPixelCloud(cx, cy, w, baseCol, shadeCol) {
    const x0 = Math.round(cx);
    const y0 = Math.round(cy);
    px(x0 + 2, y0, Math.max(4, w - 4), 2, baseCol);
    px(x0, y0 + 1, w, 2, baseCol);
    px(x0 + 1, y0 + 3, w - 2, 1, shadeCol);
  }

  function drawWindow(x, y, w, h, t, seed, env) {
    px(x - 2, y - 2, w + 4, h + 4, '#121722');
    px(x - 1, y - 1, w + 2, h + 2, '#364156');

    const { phase, kind, cloudCover, dayProgress } = env;
    const overcastLike = kind === 'overcast' || kind === 'rain' || kind === 'storm' || kind === 'fog';

    // Sky palette by time of day & Bielefeld weather
    let skyTop = '#0d1326', skyMid = '#131c38', skyBot = '#1c2647';
    if (phase === 'dawn') {
      if (overcastLike) { skyTop = '#334155'; skyMid = '#64748b'; skyBot = '#fda4af'; }
      else { skyTop = '#312e81'; skyMid = '#be185d'; skyBot = '#fb923c'; }
    } else if (phase === 'dusk') {
      if (overcastLike) { skyTop = '#1e293b'; skyMid = '#475569'; skyBot = '#d97706'; }
      else { skyTop = '#1e1b4b'; skyMid = '#b91c1c'; skyBot = '#f59e0b'; }
    } else if (phase === 'day') {
      if (kind === 'rain' || kind === 'storm') {
        skyTop = '#334155'; skyMid = '#475569'; skyBot = '#64748b';
      } else if (kind === 'overcast' || kind === 'fog') {
        skyTop = '#475569'; skyMid = '#64748b'; skyBot = '#94a3b8';
      } else if (kind === 'snow') {
        skyTop = '#64748b'; skyMid = '#94a3b8'; skyBot = '#cbd5e1';
      } else if (kind === 'cloudy') {
        skyTop = '#1d4ed8'; skyMid = '#3b82f6'; skyBot = '#bfdbfe';
      } else {
        skyTop = '#0284c7'; skyMid = '#38bdf8'; skyBot = '#bae6fd';
      }
    }

    // Brief lightning flash in storm
    const flash = kind === 'storm' && Math.sin(t * 7.3) > 0.96 && Math.sin(t * 23.1) > 0.4;
    px(x, y, w, h, flash ? '#e2e8f0' : skyTop);
    px(x, y + 6, w, h - 6, flash ? '#f1f5f9' : skyMid);
    px(x, y + 14, w, h - 14, flash ? '#ffffff' : skyBot);

    // Celestial bodies: Moon + stars at night, Sun moving across windows 0 -> 1 -> 2 during day
    if (phase === 'night') {
      if (seed === 0) {
        px(x + w - 16, y + 4, 6, 6, '#fef08a');
        px(x + w - 14, y + 3, 4, 1, '#fef08a');
        px(x + w - 15, y + 10, 4, 1, '#fef08a');
        px(x + w - 17, y + 4, 2, 4, skyTop);
      }
      if (cloudCover < 85) {
        const starCoords = [[8, 4], [22, 7], [39, 3], [58, 6], [14, 11], [45, 9]];
        starCoords.forEach(([sx, sy], i) => {
          const twinkle = Math.sin(t * 2.2 + seed * 3 + i * 1.7) > 0.2;
          px(x + ((sx + seed * 11) % (w - 4)) + 2, y + sy, 1, 1, twinkle ? '#e2e8f0' : '#475569');
        });
      }
    } else if (!overcastLike && kind !== 'snow') {
      // Sun position across the 3 windows (0 = morning East, 1 = midday South, 2 = afternoon West)
      const sunWin = dayProgress < 0.34 ? 0 : dayProgress < 0.67 ? 1 : 2;
      if (seed === sunWin) {
        const localP = sunWin === 0
          ? dayProgress / 0.34
          : sunWin === 1
            ? (dayProgress - 0.34) / 0.33
            : (dayProgress - 0.67) / 0.33;
        const sunX = x + 10 + Math.round(Math.max(0, Math.min(1, localP)) * (w - 26));
        const arc = Math.sin(Math.max(0.05, Math.min(0.95, dayProgress)) * Math.PI);
        const sunY = y + Math.round(10 - arc * 6);
        const sunCore = (phase === 'dawn' || phase === 'dusk') ? '#fed7aa' : '#fef08a';
        const sunHalo = (phase === 'dawn' || phase === 'dusk') ? '#fb923c' : '#fde047';
        px(sunX - 1, sunY + 1, 8, 4, sunHalo);
        px(sunX + 1, sunY - 1, 4, 8, sunHalo);
        px(sunX, sunY, 6, 6, sunCore);
      }
    }

    // Drifting clouds (before distant skyline or across upper sky)
    const numClouds = cloudCover >= 75 ? 3 : cloudCover >= 35 ? 2 : cloudCover >= 12 ? 1 : 0;
    const cloudBase = phase === 'night'
      ? '#1e293b'
      : (phase === 'dawn' || phase === 'dusk')
        ? '#fed7aa'
        : (kind === 'rain' || kind === 'storm')
          ? '#64748b'
          : kind === 'overcast'
            ? '#cbd5e1'
            : '#f8fafc';
    const cloudShade = phase === 'night'
      ? '#0f172a'
      : (phase === 'dawn' || phase === 'dusk')
        ? '#fb923c'
        : (kind === 'rain' || kind === 'storm')
          ? '#475569'
          : '#94a3b8';
    for (let ci = 0; ci < numClouds; ci++) {
      const cw = 14 + ((ci + seed) % 3) * 4;
      const drift = (t * (1.2 + ci * 0.35) + seed * 23 + ci * 27) % (w + cw + 8);
      const cx = x + Math.floor(drift) - cw;
      const cy = y + 2 + ci * 3 + ((seed + ci) % 2);
      // Clip cloud horizontally inside window
      const clipX = Math.max(x, cx);
      const clipW = Math.min(x + w, cx + cw) - clipX;
      if (clipW > 4) drawPixelCloud(clipX, cy, clipW, cloudBase, cloudShade);
    }

    // Teutoburger Wald ridge & Sparrenburg silhouette in center window (seed === 1)
    const hillCol = phase === 'night' ? '#111c2d' : env.isDay ? '#1e3a2f' : '#172536';
    px(x, y + 18, w, 10, hillCol);
    if (seed === 1) {
      // Sparrenburg hill + iconic round tower on left-center of middle window
      px(x + 6, y + 14, 18, 6, hillCol);
      px(x + 9, y + 12, 12, 3, hillCol);
      const towerCol = phase === 'night' ? '#1e293b' : '#cbd5e1';
      const roofCol = phase === 'night' ? '#7f1d1d' : '#b91c1c';
      px(x + 11, y + 8, 6, 5, roofCol); // castle building roof
      px(x + 11, y + 10, 6, 3, towerCol);
      px(x + 16, y + 4, 3, 9, towerCol); // Sparrenburg tower
      px(x + 16, y + 3, 3, 1, roofCol); // tower dome
      px(x + 17, y + 1, 1, 2, '#94a3b8'); // spire
    }

    // Distant & foreground city buildings
    const distBldg = phase === 'night' ? '#161e33' : (phase === 'dawn' || phase === 'dusk') ? '#262f45' : '#334155';
    const foreBldg = phase === 'night' ? '#0b0f1c' : (phase === 'dawn' || phase === 'dusk') ? '#171f30' : '#1e293b';
    px(x + 2, y + 14, 12, 14, distBldg);
    if (seed !== 1) px(x + 16, y + 10, 14, 18, distBldg);
    px(x + 33, y + 15, 11, 13, distBldg);
    px(x + 46, y + 11, 15, 17, distBldg);

    px(x + 6, y + 17, 13, 11, foreBldg);
    px(x + 22, y + 12, 15, 16, foreBldg);
    px(x + 28, y + 9, 2, 3, foreBldg);
    px(x + 28, y + 8, 1, 1, Math.floor(t * 2) % 2 === 0 ? '#ef4444' : '#450a0a');
    px(x + 40, y + 16, 12, 12, foreBldg);
    px(x + 54, y + 14, 13, 14, foreBldg);

    const winLights = [
      [8, 19, '#facc15'], [12, 19, '#38bdf8'], [8, 22, '#facc15'],
      [25, 14, '#facc15'], [29, 14, '#facc15'], [33, 14, '#fb923c'],
      [25, 17, '#38bdf8'], [33, 17, '#facc15'], [25, 20, '#facc15'], [29, 20, '#facc15'],
      [43, 18, '#38bdf8'], [47, 21, '#facc15'],
      [57, 16, '#facc15'], [61, 16, '#facc15'], [57, 19, '#fb923c'], [61, 22, '#38bdf8'],
    ];
    winLights.forEach(([lx, ly, col], idx) => {
      if (phase === 'day') {
        // Tagsüber: dezente Tageslicht-Spiegelung in den Fenstern, bei Regen/Bedeckung einzelne Büros beleuchtet
        const lit = overcastLike && ((idx + seed) % 5 === 0);
        px(x + lx, y + ly, 2, 2, lit ? '#fde047' : '#475569');
      } else {
        const threshold = phase === 'night' ? -0.65 : 0.1;
        const on = Math.sin(t * 0.4 + seed * 5 + idx * 2.3) > threshold;
        if (on) px(x + lx, y + ly, 2, 2, col);
      }
    });

    // Weather precipitation effects in front of skyline
    if (kind === 'rain' || kind === 'storm') {
      for (let ri = 0; ri < 14; ri++) {
        const rx = (ri * 13 + seed * 17 + Math.floor(t * 28)) % (w - 3);
        const ry = (ri * 7 + Math.floor(t * 42)) % (h - 3);
        px(x + 1 + rx, y + 1 + ry, 1, 2, 'rgba(125, 211, 252, 0.75)');
      }
    } else if (kind === 'snow') {
      for (let si = 0; si < 12; si++) {
        const sx = (si * 11 + seed * 19 + Math.floor(t * 6 + Math.sin(t + si) * 2)) % (w - 2);
        const sy = (si * 9 + Math.floor(t * 10)) % (h - 2);
        px(x + 1 + sx, y + 1 + sy, 1, 1, '#f8fafc');
      }
    } else if (kind === 'fog') {
      px(x + 1, y + 13, w - 2, 3, 'rgba(226, 232, 240, 0.32)');
      px(x + 1, y + 20, w - 2, 4, 'rgba(226, 232, 240, 0.38)');
    }

    // Window mullions & sill
    px(x + Math.floor(w / 3), y, 2, h, '#263042');
    px(x + Math.floor((w * 2) / 3), y, 2, h, '#263042');
    px(x, y + Math.floor(h * 0.58), w, 2, '#263042');
    px(x - 3, y + h + 1, w + 6, 2, '#475569');
    if (kind === 'snow') px(x - 2, y + h, w + 4, 1, '#f1f5f9');
    px(x - 3, y + h + 3, w + 6, 1, '#0f141d');
  }

  function drawClockHand(cx, cy, angleRad, maxLen, color) {
    const dx = Math.sin(angleRad);
    const dy = -Math.cos(angleRad);
    for (let r = 1; r <= maxLen; r++) {
      px(cx + Math.round(dx * r), cy + Math.round(dy * r), 1, 1, color);
    }
  }

  function drawWallClock(cx, cy, env) {
    pxOutline(cx - 5, cy - 5, 11, 11, '#f1f5f9', '#1e293b');
    px(cx - 4, cy - 4, 9, 1, '#cbd5e1');
    px(cx, cy - 4, 1, 1, '#64748b');
    px(cx + 4, cy, 1, 1, '#64748b');
    px(cx, cy + 4, 1, 1, '#64748b');
    px(cx - 4, cy, 1, 1, '#64748b');

    const hours = env ? env.hours : new Date().getHours();
    const minutes = env ? env.minutes : new Date().getMinutes();
    const hourAngle = (((hours % 12) + minutes / 60) / 12) * Math.PI * 2;
    const minAngle = (minutes / 60) * Math.PI * 2;

    // Minute hand (3px radius) & Hour hand (2px radius) + center pin
    drawClockHand(cx, cy, minAngle, 3, '#334155');
    drawClockHand(cx, cy, hourAngle, 2, '#0f172a');
    px(cx, cy, 1, 1, '#dc2626');
  }

  function drawWallArt(x, y) {
    pxOutline(x, y, 20, 22, '#1e293b', '#0f172a');
    px(x + 1, y + 1, 18, 20, '#d97706');
    px(x + 2, y + 2, 16, 18, '#0f172a');
    px(x + 4, y + 4, 12, 14, '#1e1b4b');
    px(x + 8, y + 6, 4, 4, '#f43f5e');
    px(x + 4, y + 12, 6, 6, '#312e81');
    px(x + 9, y + 10, 7, 8, '#4338ca');
  }

  // --- Right Column Zones: Kitchen, Kanban Board, Lounge ---
  function drawKitchenZone(t) {
    const { splitX, vw, rxCenter, counterY, bistroY } = layout;
    const shelfX = splitX + 10;

    // Upper wall shelf with coffee jars & mugs
    pxOutline(shelfX, 12, 76, 16, '#3b2d24', '#14100d');
    px(shelfX + 1, 13, 74, 2, '#574336');
    px(shelfX + 1, 20, 74, 1, '#241b15');
    px(shelfX + 6, 15, 4, 5, '#f8fafc');
    px(shelfX + 12, 15, 4, 5, '#38bdf8');
    px(shelfX + 20, 14, 6, 6, '#b45309');
    px(shelfX + 21, 13, 4, 1, '#78350f');
    px(shelfX + 30, 15, 4, 5, '#f43f5e');
    px(shelfX + 38, 14, 7, 6, '#10b981');
    px(shelfX + 50, 15, 5, 5, '#eab308');
    px(shelfX + 60, 14, 6, 6, '#cbd5e1');

    // Kitchen Counter
    const cLeft = splitX + 8;
    const cW = Math.min(104, vw - splitX - 36);
    drawEllipseShadow(cLeft + cW / 2, counterY + 26, cW / 2 + 2, 4, 0.35);
    pxOutline(cLeft, counterY, cW, 24, '#2d3748', '#0f141c');
    px(cLeft - 1, counterY - 4, cW + 2, 5, '#e2e8f0');
    px(cLeft - 1, counterY - 4, cW + 2, 1, '#f8fafc');
    px(cLeft - 1, counterY, cW + 2, 1, '#94a3b8');

    for (let cx = cLeft + 4; cx < cLeft + cW - 18; cx += 22) {
      px(cx, counterY + 3, 19, 19, '#1e293b');
      px(cx + 1, counterY + 4, 17, 17, '#273244');
      px(cx + 14, counterY + 8, 1, 5, '#94a3b8');
    }

    // Dual-Group Espresso Machine on left of counter
    const espX = cLeft + 6;
    const espY = counterY - 21;
    pxOutline(espX, espY, 22, 18, '#1e293b', '#090d14');
    px(espX + 1, espY + 1, 20, 3, '#cbd5e1');
    px(espX + 1, espY + 4, 20, 3, '#dc2626');
    px(espX + 5, espY + 5, 2, 2, '#4ade80');
    px(espX + 10, espY + 5, 3, 2, '#f8fafc');
    px(espX + 3, espY + 8, 16, 7, '#0f172a');
    px(espX + 6, espY + 9, 3, 3, '#94a3b8');
    px(espX + 13, espY + 9, 3, 3, '#94a3b8');
    px(espX + 6, espY + 13, 3, 2, '#f8fafc');
    px(espX + 13, espY + 13, 3, 2, '#38bdf8');

    const sOff = Math.floor(t * 3);
    for (let i = 0; i < 3; i++) {
      const sy = espY - 3 - i * 3 - (sOff % 2);
      const sx = espX + 8 + ((i + sOff) % 2) * 2;
      px(sx, sy, 2, 2, 'rgba(226, 232, 240, 0.45)');
    }

    // Sink & Faucet
    const sinkX = cLeft + 38;
    px(sinkX, counterY - 3, 18, 3, '#64748b');
    px(sinkX + 2, counterY - 3, 14, 2, '#334155');
    px(sinkX + 8, counterY - 9, 2, 6, '#cbd5e1');
    px(sinkX + 5, counterY - 9, 4, 2, '#cbd5e1');

    // Pastry Tray
    if (cW >= 84) {
      const trayX = cLeft + 64;
      px(trayX, counterY - 5, 14, 2, '#94a3b8');
      px(trayX + 2, counterY - 7, 4, 2, '#f59e0b');
      px(trayX + 7, counterY - 7, 3, 2, '#ef4444');
      px(trayX + 10, counterY - 7, 3, 2, '#84cc16');
    }

    // Water Dispenser Tower on right of counter
    const wdX = vw - 22;
    const wdY = counterY - 20;
    drawEllipseShadow(wdX + 6, counterY + 25, 10, 3, 0.35);
    pxOutline(wdX + 1, wdY, 12, 16, '#0ea5e9', '#082f49');
    px(wdX + 2, wdY + 1, 10, 14, '#38bdf8');
    px(wdX + 3, wdY + 2, 3, 11, '#7dd3fc');
    const bubY = wdY + 14 - (Math.floor(t * 5) % 11);
    px(wdX + 7, bubY, 2, 2, '#e0f2fe');
    pxOutline(wdX, wdY + 16, 14, 28, '#e2e8f0', '#0f172a');
    px(wdX + 1, wdY + 17, 12, 26, '#f1f5f9');
    px(wdX + 2, wdY + 22, 10, 7, '#1e293b');
    px(wdX + 4, wdY + 23, 2, 3, '#ef4444');
    px(wdX + 8, wdY + 23, 2, 3, '#3b82f6');

    // Bistro High Table & Barstools
    drawEllipseShadow(rxCenter, bistroY + 12, 14, 5, 0.35);
    drawBarstool(rxCenter - 24, bistroY + 2);
    drawBarstool(rxCenter + 24, bistroY + 2);
    px(rxCenter - 2, bistroY, 4, 12, '#1e293b');
    px(rxCenter - 6, bistroY + 10, 12, 2, '#334155');
    pxOutline(rxCenter - 12, bistroY - 8, 24, 9, '#9a5b25', '#14100c');
    px(rxCenter - 11, bistroY - 7, 22, 6, '#b86f30');
    px(rxCenter - 10, bistroY - 7, 20, 2, '#ce8340');
    px(rxCenter - 7, bistroY - 6, 3, 3, '#f8fafc');
    px(rxCenter + 4, bistroY - 5, 3, 3, '#fbbf24');
  }

  function drawBarstool(cx, cy) {
    drawEllipseShadow(cx, cy + 8, 6, 2, 0.3);
    px(cx - 1, cy + 1, 2, 7, '#334155');
    px(cx - 3, cy + 7, 6, 1, '#475569');
    pxOutline(cx - 4, cy - 2, 8, 4, '#7c2d12', '#14100c');
    px(cx - 3, cy - 2, 6, 2, '#9a3412');
  }

  function drawBoardZone(t, hasWaiting) {
    const { splitX, vw, rxCenter, boardY } = layout;
    const bw = Math.min(116, vw - splitX - 24);
    const bx = Math.round(rxCenter - bw / 2);

    drawEllipseShadow(rxCenter, boardY + 40, bw / 2, 4, 0.3);
    px(bx + 6, boardY + 30, 3, 10, '#334155');
    px(bx + bw - 9, boardY + 30, 3, 10, '#334155');
    px(bx + 3, boardY + 39, 9, 2, '#475569');
    px(bx + bw - 12, boardY + 39, 9, 2, '#475569');

    const frameColor = hasWaiting ? (Math.floor(t * 4) % 2 === 0 ? '#f59e0b' : '#d97706') : '#cbd5e1';
    pxOutline(bx, boardY, bw, 32, frameColor, '#0f172a');
    px(bx + 2, boardY + 2, bw - 4, 28, '#151c2c');

    const colW = Math.floor((bw - 4) / 3);
    px(bx + 2 + colW, boardY + 4, 1, 24, '#293548');
    px(bx + 2 + colW * 2, boardY + 4, 1, 24, '#293548');

    px(bx + 6, boardY + 4, colW - 8, 2, '#475569');
    px(bx + 6 + colW, boardY + 4, colW - 8, 2, '#f59e0b');
    px(bx + 6 + colW * 2, boardY + 4, colW - 8, 2, '#10b981');

    drawStickyNote(bx + 6, boardY + 9, '#facc15');
    drawStickyNote(bx + 16, boardY + 9, '#38bdf8');
    drawStickyNote(bx + 6, boardY + 18, '#f472b6');

    drawStickyNote(bx + 6 + colW, boardY + 9, '#fb923c');
    drawStickyNote(bx + 16 + colW, boardY + 9, '#facc15');
    if (hasWaiting) {
      drawStickyNote(bx + 6 + colW, boardY + 18, '#ef4444');
    }

    const c3X = bx + 6 + colW * 2;
    px(c3X, boardY + 10, 10, 5, '#3b82f6');
    px(c3X + 10, boardY + 12, 4, 1, '#94a3b8');
    px(c3X + 14, boardY + 10, 10, 5, '#10b981');
    px(c3X + 2, boardY + 18, 20, 2, '#64748b');
    px(c3X + 2, boardY + 22, 14, 2, '#64748b');

    px(rxCenter - 20, boardY + 30, 40, 2, '#94a3b8');
    px(rxCenter - 16, boardY + 29, 5, 1, '#ef4444');
    px(rxCenter - 8, boardY + 29, 5, 1, '#3b82f6');
    px(rxCenter, boardY + 29, 5, 1, '#22c55e');
  }

  function drawStickyNote(x, y, color) {
    px(x, y, 8, 7, 'rgba(0,0,0,0.4)');
    px(x, y, 7, 6, color);
    px(x + 1, y + 2, 5, 1, 'rgba(0,0,0,0.25)');
    px(x + 1, y + 4, 4, 1, 'rgba(0,0,0,0.25)');
  }

  function drawLoungeZone() {
    const { splitX, vw, vh, rxCenter, z3Top, sofaY, row2Y, row3Y } = layout;
    const rugX = splitX + 10;
    const rugY = z3Top + 18;
    const rugW = vw - splitX - 20;
    const rugH = Math.max(56, vh - rugY - 6);

    // Cozy Persian / Woven Area Rug
    px(rugX, rugY, rugW, rugH, '#3b1d2e');
    px(rugX + 2, rugY + 2, rugW - 4, rugH - 4, '#59283c');
    px(rugX + 4, rugY + 4, rugW - 8, rugH - 8, '#283149');
    for (let rx = rugX + 10; rx < rugX + rugW - 12; rx += 16) {
      px(rx, rugY + 6, 4, 2, '#d97706');
      px(rx, rugY + rugH - 8, 4, 2, '#d97706');
    }
    for (let ry = rugY + 2; ry < rugY + rugH - 2; ry += 4) {
      px(rugX - 2, ry, 2, 2, '#cbd5e1');
      px(rugX + rugW, ry, 2, 2, '#cbd5e1');
    }

    // Warm Standing Floor Lamp (top-right of lounge)
    const lampX = vw - 16;
    const lampY = sofaY - 26;
    offCtx.fillStyle = 'rgba(251, 191, 36, 0.08)';
    offCtx.fillRect(lampX - 18, lampY, 28, 34);
    px(lampX, lampY + 8, 2, 22, '#78350f');
    px(lampX - 3, lampY + 29, 8, 2, '#92400e');
    pxOutline(lampX - 5, lampY, 12, 8, '#fef3c7', '#451a03');
    px(lampX - 4, lampY + 1, 10, 3, '#fde68a');
    px(lampX - 4, lampY + 4, 10, 3, '#f59e0b');

    // Wide Chesterfield Leather Sofa (4 seats wide)
    const sLeft = splitX + 18;
    const sW = Math.min(118, vw - splitX - 38);
    const sTop = sofaY - 18;
    drawEllipseShadow(sLeft + sW / 2, sTop + 25, sW / 2 + 2, 5, 0.45);
    pxOutline(sLeft, sTop, sW, 12, '#7c2d12', '#170d08');
    px(sLeft + 1, sTop + 1, sW - 2, 3, '#b45309');
    for (let bx = sLeft + 9; bx < sLeft + sW - 8; bx += 13) {
      px(bx, sTop + 5, 2, 2, '#431407');
      px(bx, sTop + 4, 1, 1, '#d97706');
    }
    pxOutline(sLeft, sTop + 11, sW, 11, '#9a3412', '#170d08');
    const cushW = Math.floor((sW - 6) / 4);
    for (let i = 0; i < 4; i++) {
      const sx = sLeft + 3 + i * cushW;
      px(sx, sTop + 12, cushW - 2, 8, '#b45309');
      px(sx + 1, sTop + 12, cushW - 4, 2, '#c25e00');
    }
    pxOutline(sLeft - 4, sTop + 5, 7, 18, '#7c2d12', '#170d08');
    px(sLeft - 3, sTop + 6, 5, 3, '#b45309');
    pxOutline(sLeft + sW - 3, sTop + 5, 7, 18, '#7c2d12', '#170d08');
    px(sLeft + sW - 2, sTop + 6, 5, 3, '#b45309');
    px(sLeft - 1, sTop + 22, 4, 2, '#291811');
    px(sLeft + sW - 3, sTop + 22, 4, 2, '#291811');

    // Left & Right Lounge Armchairs / Poufs (Row 2)
    drawLoungePouf(splitX + 24, row2Y - 2, '#0284c7', '#38bdf8');
    drawLoungePouf(vw - 24, row2Y - 2, '#0284c7', '#38bdf8');

    // Low Glass & Walnut Coffee Table in center of Row 2
    const ctY = row2Y - 6;
    drawEllipseShadow(rxCenter, ctY + 11, 22, 4, 0.35);
    pxOutline(rxCenter - 21, ctY, 42, 10, '#452719', '#140b07');
    px(rxCenter - 19, ctY + 1, 38, 7, '#1e3a5f');
    px(rxCenter - 17, ctY + 2, 12, 1, '#38bdf8');
    px(rxCenter - 15, ctY + 3, 7, 4, '#f43f5e');
    px(rxCenter - 14, ctY + 4, 5, 2, '#fda4af');
    px(rxCenter + 5, ctY + 3, 8, 4, '#e2e8f0');

    // Front-row Cozy Floor Cushions (Row 3)
    const { rightW } = layout;
    drawLoungePouf(Math.round(splitX + rightW * 0.25), row3Y - 2, '#0d9488', '#2dd4bf');
    drawLoungePouf(Math.round(splitX + rightW * 0.52), row3Y - 2, '#7c3aed', '#a78bfa');
    drawLoungePouf(Math.round(splitX + rightW * 0.78), row3Y - 2, '#0d9488', '#2dd4bf');
  }

  function drawLoungePouf(cx, cy, baseCol, hiCol) {
    drawEllipseShadow(cx, cy + 4, 8, 3, 0.35);
    pxOutline(cx - 7, cy - 3, 14, 7, baseCol, '#0f172a');
    px(cx - 6, cy - 3, 12, 2, hiCol);
  }

  // --- Bookcase (Bücherregal) & Potted Plants ---
  function drawBookcase(b) {
    if (!b) return;
    const { x, y, w, h } = b;
    const left = Math.round(x - w / 2);
    const top = Math.round(y - h);

    drawEllipseShadow(x, y + 3, w / 2 + 2, 4, 0.42);

    // Outer walnut cabinet frame & dark interior backing
    pxOutline(left, top, w, h + 2, '#693b1c', '#0f141d');
    px(left + 1, top + 1, w - 2, 2, '#a16232');
    px(left + 2, top + 3, w - 4, h - 2, '#2b180c');

    // Three horizontal shelves
    const s1 = top + 9;
    const s2 = top + 16;
    const s3 = top + 23;
    px(left + 1, s1, w - 2, 2, '#854d27');
    px(left + 1, s1, w - 2, 1, '#a16232');
    px(left + 1, s2, w - 2, 2, '#854d27');
    px(left + 1, s2, w - 2, 1, '#a16232');
    px(left + 1, s3, w - 2, 2, '#854d27');

    // Shelf 1 (top): Books + miniature globe + golden cup
    const b1Y = s1 - 5;
    px(left + 3, b1Y, 2, 5, '#ef4444');
    px(left + 5, b1Y + 1, 2, 4, '#3b82f6');
    px(left + 7, b1Y, 3, 5, '#10b981');
    px(left + 10, b1Y + 1, 2, 4, '#f59e0b');
    // Mini globe on brass stand
    px(left + 15, s1 - 1, 3, 1, '#d97706');
    px(left + 15, s1 - 4, 3, 3, '#0ea5e9');
    px(left + 16, s1 - 3, 1, 2, '#4ade80');
    // Golden trophy / mug + more books
    px(left + 20, s1 - 4, 3, 4, '#fbbf24');
    px(left + 21, s1 - 3, 1, 2, '#fef08a');
    px(left + 25, b1Y, 2, 5, '#a855f7');
    px(left + 27, b1Y + 1, 2, 4, '#ec4899');

    // Shelf 2 (middle): Dense colorful row of reference books
    const b2Y = s2 - 5;
    const shelf2Colors = ['#38bdf8', '#f97316', '#e2e8f0', '#22c55e', '#f43f5e', '#eab308', '#6366f1', '#14b8a6', '#fb7185'];
    let bx = left + 3;
    for (let i = 0; i < shelf2Colors.length && bx < left + w - 4; i++) {
      const bw = (i % 3 === 1) ? 3 : 2;
      const bh = (i % 2 === 0) ? 5 : 4;
      px(bx, s2 - bh, bw, bh, shelf2Colors[i]);
      if (bw === 3) px(bx + 1, s2 - bh + 1, 1, bh - 2, 'rgba(255,255,255,0.28)');
      bx += bw + (i === 4 ? 2 : 0);
    }

    // Shelf 3 (bottom): Thick binders & horizontal book stacks
    const b3Y = s3 - 5;
    px(left + 3, b3Y, 3, 5, '#1d4ed8');
    px(left + 4, b3Y + 1, 1, 1, '#93c5fd');
    px(left + 6, b3Y, 3, 5, '#b91c1c');
    px(left + 7, b3Y + 1, 1, 1, '#fca5a5');
    px(left + 9, b3Y, 3, 5, '#047857');
    // Horizontal stack of books
    px(left + 14, s3 - 2, 7, 2, '#d97706');
    px(left + 15, s3 - 4, 6, 2, '#7c3aed');
    px(left + 23, b3Y + 1, 2, 4, '#f472b6');
    px(left + 25, b3Y, 3, 5, '#475569');

    // Top of bookcase: Small potted trailing ivy (Efeutute) + book stack
    px(left + 4, top - 2, 6, 2, '#dc2626');
    px(left + 5, top - 4, 5, 2, '#2563eb');
    pxOutline(left + w - 9, top - 4, 6, 4, '#d97706', '#0f172a');
    px(left + w - 10, top - 6, 8, 3, '#16a34a');
    px(left + w - 8, top - 7, 5, 2, '#4ade80');
    // Vines cascading down the right side of the bookcase
    px(left + w - 3, top - 3, 2, 6, '#15803d');
    px(left + w - 2, top + 2, 2, 6, '#22c55e');
    px(left + w - 3, top + 7, 1, 4, '#4ade80');
  }

  function drawPlant(p) {
    const { x, y, kind } = p;
    drawEllipseShadow(x, y + 6, 7, 3, 0.38);

    const isWhitePot = kind === 'ficus' || kind === 'fern';
    const potBase = isWhitePot ? '#cbd5e1' : '#b45309';
    const potHi = isWhitePot ? '#f1f5f9' : '#d97706';
    const potRim = isWhitePot ? '#e2e8f0' : '#f59e0b';

    pxOutline(x - 5, y - 3, 10, 8, potBase, '#14100d');
    px(x - 4, y - 2, 4, 6, potHi);
    pxOutline(x - 6, y - 5, 12, 3, potHi, '#14100d');
    px(x - 5, y - 5, 5, 1, potRim);

    if (kind === 'monstera') {
      pxOutline(x - 7, y - 13, 14, 8, '#15803d', '#091910');
      px(x - 5, y - 16, 10, 4, '#16a34a');
      px(x - 6, y - 12, 5, 4, '#22c55e');
      px(x + 2, y - 14, 4, 5, '#22c55e');
      px(x - 2, y - 15, 4, 3, '#4ade80');
    } else if (kind === 'palm') {
      pxOutline(x - 8, y - 12, 16, 6, '#15803d', '#091910');
      pxOutline(x - 5, y - 17, 10, 6, '#16a34a', '#091910');
      px(x - 7, y - 11, 5, 2, '#4ade80');
      px(x + 2, y - 11, 5, 2, '#4ade80');
      px(x - 3, y - 16, 6, 2, '#4ade80');
    } else if (kind === 'ficus') {
      // Braided wooden trunk + round leafy canopy
      px(x - 1, y - 13, 3, 8, '#78350f');
      px(x, y - 12, 1, 6, '#a16207');
      pxOutline(x - 7, y - 21, 14, 9, '#15803d', '#091910');
      px(x - 5, y - 23, 10, 3, '#16a34a');
      px(x - 5, y - 20, 5, 4, '#22c55e');
      px(x + 1, y - 19, 4, 3, '#4ade80');
      px(x - 3, y - 22, 6, 2, '#4ade80');
    } else if (kind === 'cactus') {
      // Ribbed saguaro cactus with a bright pink blossom on top
      pxOutline(x - 3, y - 17, 6, 12, '#15803d', '#091910');
      px(x - 1, y - 16, 2, 10, '#22c55e');
      pxOutline(x - 6, y - 14, 3, 5, '#16a34a', '#091910');
      pxOutline(x + 3, y - 15, 3, 5, '#16a34a', '#091910');
      // Pink cactus flower
      px(x - 2, y - 19, 4, 2, '#ec4899');
      px(x - 1, y - 20, 2, 2, '#f9a8d4');
    } else if (kind === 'fern') {
      // Lush cascading Boston fern
      pxOutline(x - 8, y - 11, 16, 7, '#15803d', '#091910');
      px(x - 6, y - 14, 12, 5, '#16a34a');
      px(x - 7, y - 9, 4, 4, '#22c55e');
      px(x + 4, y - 9, 4, 4, '#22c55e');
      px(x - 4, y - 13, 8, 3, '#4ade80');
    } else if (kind === 'ivy') {
      // Trailing pothos / ivy overflowing the pot
      pxOutline(x - 6, y - 12, 12, 7, '#15803d', '#091910');
      px(x - 4, y - 13, 8, 4, '#22c55e');
      px(x - 2, y - 12, 4, 2, '#4ade80');
      px(x - 5, y - 5, 2, 6, '#16a34a');
      px(x - 5, y, 2, 3, '#4ade80');
      px(x + 3, y - 5, 2, 7, '#15803d');
      px(x + 3, y + 1, 2, 2, '#22c55e');
    } else {
      pxOutline(x - 4, y - 17, 8, 12, '#166534', '#091910');
      px(x - 3, y - 16, 2, 10, '#22c55e');
      px(x, y - 18, 2, 12, '#4ade80');
      px(x + 2, y - 14, 2, 8, '#16a34a');
    }
  }

  // --- Detailed Workstations (Desks, Monitors, Chairs, Accessories) ---
  function drawDeskBase(d, occupant, t) {
    const { x, y, idx } = d;
    const isWorking = occupant && occupant.mode === 'active' && Math.hypot(occupant.x - d.seatX, occupant.y - d.seatY) < 6;
    const isWaitingAtDesk = occupant && occupant.mode === 'waiting' && Math.hypot(occupant.x - d.seatX, occupant.y - d.seatY) < 6;

    drawEllipseShadow(x, y + 10, 28, 6, 0.38);

    px(x - 24, y - 2, 3, 13, '#1e293b');
    px(x + 21, y - 2, 3, 13, '#1e293b');
    px(x - 24, y + 9, 3, 2, '#475569');
    px(x + 21, y + 9, 3, 2, '#475569');
    px(x - 21, y + 2, 42, 6, '#0f172a');

    // Beveled Walnut/Oak Desk Surface (52×16)
    pxOutline(x - 26, y - 12, 52, 16, '#854d27', '#0f141d');
    px(x - 25, y - 11, 50, 12, '#a16232');
    px(x - 25, y - 11, 50, 1, '#bd7844');
    px(x - 20, y - 7, 18, 1, '#935629');
    px(x + 4, y - 4, 16, 1, '#935629');
    px(x - 25, y + 1, 50, 3, '#693b1c');

    // Dark Desk Mat + Mechanical Keyboard + Mouse
    px(x - 12, y - 5, 24, 6, '#1e293b');
    px(x - 9, y - 4, 13, 4, '#334155');
    px(x - 8, y - 3, 11, 2, '#94a3b8');
    px(x - 8, y - 3, 2, 1, '#ef4444');
    px(x - 5, y - 2, 5, 1, '#cbd5e1');
    px(x + 7, y - 3, 3, 3, '#cbd5e1');
    px(x + 8, y - 3, 1, 1, '#38bdf8');

    // Left accessory: Brass Desk Lamp or Stack of Books
    if (idx % 2 === 0) {
      px(x - 22, y - 8, 4, 2, '#475569');
      px(x - 21, y - 13, 1, 5, '#94a3b8');
      px(x - 20, y - 14, 5, 3, '#f59e0b');
      if (isWorking) {
        offCtx.fillStyle = 'rgba(253, 224, 71, 0.14)';
        offCtx.fillRect(x - 22, y - 11, 10, 9);
      }
    } else {
      px(x - 23, y - 9, 7, 3, '#dc2626');
      px(x - 22, y - 8, 5, 1, '#f8fafc');
      px(x - 22, y - 11, 6, 2, '#2563eb');
    }

    // Right accessory: Coffee Mug or Sticky Notepad
    if ((idx + 1) % 3 !== 0) {
      const mugColors = ['#f8fafc', '#ef4444', '#38bdf8', '#fbbf24'];
      const mc = mugColors[idx % mugColors.length];
      px(x + 17, y - 6, 4, 4, mc);
      px(x + 21, y - 5, 1, 2, mc);
      if (isWorking) {
        const sy = y - 8 - (Math.floor(t * 3 + idx) % 2);
        px(x + 18, sy, 1, 2, 'rgba(255,255,255,0.45)');
      }
    } else {
      px(x + 16, y - 7, 6, 5, '#fef08a');
      px(x + 17, y - 5, 4, 1, '#94a3b8');
    }

    // Widescreen Monitor
    px(x - 3, y - 11, 6, 2, '#334155');
    px(x - 1, y - 14, 2, 3, '#475569');
    pxOutline(x - 10, y - 25, 20, 12, '#1e293b', '#090d14');
    px(x - 9, y - 24, 18, 10, '#0b101b');

    if (isWorking) {
      offCtx.fillStyle = 'rgba(56, 189, 248, 0.12)';
      offCtx.fillRect(x - 14, y - 12, 28, 8);

      const scroll = Math.floor(t * 5 + idx);
      const codeColors = ['#4ade80', '#38bdf8', '#f472b6', '#facc15', '#a78bfa'];
      for (let line = 0; line < 4; line++) {
        const ly = y - 23 + line * 2;
        const c1 = codeColors[(scroll + line) % codeColors.length];
        const c2 = codeColors[(scroll + line + 2) % codeColors.length];
        const indent = ((scroll + line) % 2) * 2;
        const w1 = 4 + ((scroll * 3 + line * 5) % 5);
        const w2 = 3 + ((scroll * 2 + line * 3) % 5);
        px(x - 8 + indent, ly, w1, 1, c1);
        if (indent + w1 + 2 + w2 < 16) {
          px(x - 8 + indent + w1 + 1, ly, w2, 1, c2);
        }
      }
      if (Math.floor(t * 4) % 2 === 0) {
        px(x + 5, y - 16, 2, 1, '#4ade80');
      }
      px(x + 8, y - 14, 1, 1, '#22c55e');
    } else if (isWaitingAtDesk) {
      px(x - 7, y - 21, 14, 2, '#f59e0b');
      px(x - 5, y - 18, 10, 2, '#fde68a');
      px(x + 8, y - 14, 1, 1, '#f59e0b');
    } else {
      px(x - 7, y - 22, 4, 1, '#162033');
      px(x - 8, y - 21, 4, 1, '#162033');
      px(x + 8, y - 14, 1, 1, '#475569');
    }

    if (!occupant || Math.hypot(occupant.x - d.seatX, occupant.y - d.seatY) >= 8) {
      drawChair(d.seatX, d.seatY - 3, false);
    }
  }

  function drawChair(cx, cy, occupied) {
    drawEllipseShadow(cx, cy + 4, 8, 3, 0.35);
    // 5-star wheel base on floor
    px(cx - 1, cy, 2, 4, '#1e293b');
    px(cx - 5, cy + 3, 10, 1, '#334155');
    px(cx - 6, cy + 4, 2, 1, '#0f172a');
    px(cx + 4, cy + 4, 2, 1, '#0f172a');
    // Seat cushion
    pxOutline(cx - 6, cy - 3, 12, 4, '#1e293b', '#090d14');
    px(cx - 5, cy - 3, 10, 2, '#334155');
    // Armrests on left & right
    px(cx - 7, cy - 6, 2, 4, '#1e293b');
    px(cx + 5, cy - 6, 2, 4, '#1e293b');

    if (!occupied) {
      // Unoccupied chair pushed in: backrest & spine visible from behind
      pxOutline(cx - 5, cy - 10, 10, 8, '#1e293b', '#090d14');
      px(cx - 4, cy - 9, 8, 6, '#334155');
      px(cx - 1, cy - 9, 2, 7, '#1e293b'); // Spine
    }
  }

  function drawChairBackForeground(cx, cy) {
    // Drawn in front of the seated worker's lower back (since worker faces North toward desk)
    pxOutline(cx - 4, cy - 10, 8, 6, '#1e293b', '#090d14');
    px(cx - 3, cy - 9, 6, 4, '#334155');
    px(cx - 1, cy - 9, 2, 6, '#1e293b'); // Central lumbar spine post
    // Gas lift post connecting backrest to wheel base
    px(cx - 1, cy - 4, 2, 6, '#1e293b');
    px(cx - 5, cy + 2, 10, 1, '#334155');
    px(cx - 6, cy + 3, 2, 1, '#0f172a');
    px(cx + 4, cy + 3, 2, 1, '#0f172a');
  }

  // --- Character Sprites (16×24 pixels with 1px dark outline, shading, hair, blink, accessories) ---
  function drawActorSprite(a, t) {
    const x = Math.round(a.x);
    const y = Math.round(a.y);
    const ap = a.appearance;

    const dx = a.tx - a.x;
    const dy = a.ty - a.y;
    const dist = Math.hypot(dx, dy);
    const moving = dist > 1.2;

    const walkCycle = moving ? Math.sin(t * 12 + ap.phase) : 0;
    const bob = moving ? (Math.abs(walkCycle) > 0.5 ? -1 : 0) : 0;
    const isSeatedAtDesk = !moving && a.mode === 'active' && a.deskIdx >= 0;
    const isTyping = isSeatedAtDesk;
    const isSeatedOnSofa = !moving && a.mode === 'exited' && a.sofaPose !== 'stand';
    const facingNorth = isSeatedAtDesk || (moving && dy < -0.4 && Math.abs(dy) >= Math.abs(dx) * 0.7);
    const isHovered = hoveredItem && hoveredItem.kind === 'actor' && hoveredItem.actor.id === a.id;

    drawEllipseShadow(x, y + 2, 7, 3, isHovered ? 0.55 : 0.38);

    if (isHovered) {
      pxOutline(x - 8, y - 1, 16, 4, 'rgba(56, 189, 248, 0.35)', '#38bdf8');
    }

    if (isSeatedAtDesk) {
      // Draw chair seat cushion & armrests underneath the worker first
      drawChair(x, y, true);
    }

    const legL = moving ? Math.round(walkCycle * 2) : 0;
    const legR = moving ? -Math.round(walkCycle * 2) : 0;

    if (isSeatedAtDesk) {
      // Seated thighs/legs tucked forward under the desk
      pxOutline(x - 4, y - 5, 3, 4, ap.pants.base, '#0b0e14');
      pxOutline(x + 1, y - 5, 3, 4, ap.pants.shade, '#0b0e14');
    } else if (isSeatedOnSofa) {
      pxOutline(x - 4, y - 4, 3, 4, ap.pants.base, '#0b0e14');
      pxOutline(x + 1, y - 4, 3, 4, ap.pants.base, '#0b0e14');
      px(x - 4, y, 3, 2, '#0f172a');
      px(x + 1, y, 3, 2, '#0f172a');
    } else {
      pxOutline(x - 4, y - 6 + legL, 3, 5, ap.pants.base, '#0b0e14');
      pxOutline(x + 1, y - 6 + legR, 3, 5, ap.pants.shade, '#0b0e14');
      px(x - 5, y - 1 + legL, 4, 2, '#0f172a');
      px(x + 1, y - 1 + legR, 4, 2, '#0f172a');
    }

    const bodyY = y - 14 + bob;

    if (facingNorth) {
      // --- NORTH-FACING (BACK VIEW): Looking forward at the monitor / walking North ---
      // 1. Arms reaching forward onto the desk keyboard (drawn before back torso so shoulders overlap cleanly)
      if (isTyping) {
        const handL = Math.floor(t * 14 + ap.phase) % 2;
        const handR = (handL + 1) % 2;
        // Hands on the keyboard (y - 14..y - 16)
        px(x - 6, bodyY - 2 + handL, 2, 2, ap.skin.base);
        px(x + 4, bodyY - 2 + handR, 2, 2, ap.skin.base);
        // Forearms/sleeves angled forward toward keyboard
        pxOutline(x - 7, bodyY + handL, 2, 5, ap.shirt.base, '#0b0e14');
        pxOutline(x + 5, bodyY + handR, 2, 5, ap.shirt.shade, '#0b0e14');
      } else {
        const armSwing = moving ? Math.round(walkCycle * 2) : 0;
        pxOutline(x - 7, bodyY + 1 + armSwing, 2, 5, ap.shirt.base, '#0b0e14');
        px(x - 7, bodyY + 6 + armSwing, 2, 2, ap.skin.shade);
        pxOutline(x + 5, bodyY + 1 - armSwing, 2, 5, ap.shirt.shade, '#0b0e14');
        px(x + 5, bodyY + 6 - armSwing, 2, 2, ap.skin.shade);
      }

      // 2. Back of Torso / Shirt / Jacket (no front V-neck or front ID badge)
      pxOutline(x - 5, bodyY, 10, 8, ap.shirt.base, '#0b0e14');
      px(x + 2, bodyY, 3, 8, ap.shirt.shade);
      px(x - 5, bodyY, 1, 7, ap.shirt.accent);
      // Back collar / hoodie seam at neck
      px(x - 3, bodyY, 6, 1, ap.shirt.shade);
      px(x - 2, bodyY + 1, 4, 1, ap.shirt.shade);

      // 3. Back of Head & Hair
      const headY = bodyY - 9;
      px(x - 2, bodyY - 1, 4, 2, ap.skin.shade); // Nape of neck
      pxOutline(x - 5, headY, 10, 8, ap.skin.base, '#0b0e14');
      px(x - 4, headY + 6, 8, 2, ap.skin.shade); // Lower nape shading
      // Ears on left & right
      px(x - 6, headY + 3, 1, 3, ap.skin.shade);
      px(x + 5, headY + 3, 1, 3, ap.skin.shade);
      if (ap.glasses) {
        // Subtle glasses frame tips behind the ears
        px(x - 5, headY + 3, 1, 1, '#1e293b');
        px(x + 4, headY + 3, 1, 1, '#1e293b');
      }

      drawHairBack(x, headY, ap.hair, ap.hairStyle);

      if (ap.headphones && isTyping) {
        px(x - 6, headY - 1, 12, 1, '#334155');
        px(x - 7, headY + 2, 2, 4, '#ef4444');
        px(x + 5, headY + 2, 2, 4, '#ef4444');
      }

      // 4. Draw the chair backrest in front of the seated worker's lower back!
      if (isSeatedAtDesk) {
        drawChairBackForeground(x, y);
      }
    } else {
      // --- SOUTH-FACING (FRONT VIEW): Coffee bar, Whiteboard, Lounge Sofa, Walking South ---
      pxOutline(x - 5, bodyY, 10, 8, ap.shirt.base, '#0b0e14');
      px(x + 2, bodyY, 3, 8, ap.shirt.shade);
      px(x - 2, bodyY, 4, 2, '#f8fafc');
      px(x - 1, bodyY + 1, 2, 2, ap.shirt.accent);
      px(x + 1, bodyY + 4, 2, 3, '#e2e8f0');

      if (!moving && a.mode === 'waiting') {
        const wave = Math.floor(t * 4 + ap.phase) % 2;
        pxOutline(x - 7, bodyY + 1, 2, 6, ap.shirt.base, '#0b0e14');
        px(x - 7, bodyY + 6, 2, 2, ap.skin.base);
        pxOutline(x + 5, bodyY - 4 - wave, 2, 6, ap.shirt.shade, '#0b0e14');
        px(x + 5, bodyY - 5 - wave, 2, 2, ap.skin.base);
      } else if (!moving && a.mode === 'idle') {
        pxOutline(x - 7, bodyY + 1, 2, 6, ap.shirt.base, '#0b0e14');
        px(x - 7, bodyY + 6, 2, 2, ap.skin.base);
        pxOutline(x + 5, bodyY + 1, 2, 5, ap.shirt.shade, '#0b0e14');
        px(x + 5, bodyY + 4, 2, 2, ap.skin.base);
        pxOutline(x + 6, bodyY + 2, 3, 4, '#f8fafc', '#0b0e14');
        px(x + 7, bodyY + 3, 2, 2, '#f59e0b');
        const sy = bodyY - 1 - (Math.floor(t * 3 + ap.phase) % 2);
        px(x + 7, sy, 1, 2, 'rgba(255, 255, 255, 0.5)');
      } else {
        const armSwing = moving ? Math.round(walkCycle * 2) : 0;
        pxOutline(x - 7, bodyY + 1 - armSwing, 2, 6, ap.shirt.base, '#0b0e14');
        px(x - 7, bodyY + 6 - armSwing, 2, 2, ap.skin.base);
        pxOutline(x + 5, bodyY + 1 + armSwing, 2, 6, ap.shirt.shade, '#0b0e14');
        px(x + 5, bodyY + 6 + armSwing, 2, 2, ap.skin.shade);
      }

      const headY = bodyY - 9;
      px(x - 2, bodyY - 1, 4, 2, ap.skin.shade);
      pxOutline(x - 5, headY, 10, 8, ap.skin.base, '#0b0e14');
      px(x + 3, headY + 1, 2, 7, ap.skin.shade);
      px(x - 4, headY + 7, 8, 1, ap.skin.shade);
      px(x - 6, headY + 3, 1, 3, ap.skin.shade);
      px(x + 5, headY + 3, 1, 3, ap.skin.shade);

      const blinking = ((t + ap.phase) % 4.3) < 0.14;
      if (a.mode === 'exited' && !moving) {
        px(x - 3, headY + 4, 2, 1, '#475569');
        px(x + 1, headY + 4, 2, 1, '#475569');
      } else if (blinking) {
        px(x - 3, headY + 4, 2, 1, '#1e293b');
        px(x + 1, headY + 4, 2, 1, '#1e293b');
      } else {
        px(x - 3, headY + 3, 2, 2, '#0f172a');
        px(x + 1, headY + 3, 2, 2, '#0f172a');
        px(x - 3, headY + 3, 1, 1, '#f8fafc');
        px(x + 1, headY + 3, 1, 1, '#f8fafc');
      }

      if (ap.glasses && a.mode !== 'exited') {
        px(x - 4, headY + 3, 4, 3, 'rgba(56, 189, 248, 0.25)');
        px(x, headY + 3, 4, 3, 'rgba(56, 189, 248, 0.25)');
        px(x - 4, headY + 2, 8, 1, '#1e293b');
      }

      drawHair(x, headY, ap.hair, ap.hairStyle);
    }

    const headY = bodyY - 9;
    if (a.mode === 'waiting') {
      const bBob = Math.round(Math.sin(t * 5 + ap.phase));
      const by = headY - 12 + bBob;
      pxOutline(x - 5, by, 10, 9, '#fef3c7', '#0f172a');
      px(x - 1, by + 9, 2, 2, '#fef3c7');
      px(x - 2, by + 1, 4, 1, '#d97706');
      px(x + 1, by + 2, 1, 2, '#d97706');
      px(x - 1, by + 4, 2, 1, '#d97706');
      px(x - 1, by + 6, 2, 1, '#dc2626');
    } else if (a.mode === 'exited' && !moving) {
      const zStep = Math.floor(t * 2 + ap.phase) % 3;
      const zx = x + 5 + zStep * 2;
      const zy = headY - 4 - zStep * 3;
      px(zx, zy, 3, 1, '#94a3b8');
      px(zx + 1, zy + 1, 1, 1, '#94a3b8');
      px(zx, zy + 2, 3, 1, '#94a3b8');
    }
  }

  function drawHair(x, headY, hair, style) {
    const c = hair.base;
    const hi = hair.hi;
    if (style === 0) {
      pxOutline(x - 5, headY - 2, 10, 3, c, '#0b0e14');
      px(x - 5, headY + 1, 2, 2, c);
      px(x + 3, headY + 1, 2, 1, c);
      px(x - 3, headY - 2, 5, 1, hi);
    } else if (style === 1) {
      pxOutline(x - 5, headY - 2, 10, 3, c, '#0b0e14');
      px(x - 4, headY - 4, 2, 2, c);
      px(x - 1, headY - 4, 3, 2, c);
      px(x + 3, headY - 3, 2, 2, c);
      px(x - 1, headY - 3, 2, 1, hi);
    } else if (style === 2) {
      pxOutline(x - 6, headY - 2, 12, 3, c, '#0b0e14');
      px(x - 6, headY + 1, 2, 8, c);
      px(x + 4, headY + 1, 2, 8, c);
      px(x - 4, headY - 2, 6, 1, hi);
    } else if (style === 3) {
      pxOutline(x - 3, headY - 5, 6, 3, c, '#0b0e14');
      pxOutline(x - 5, headY - 2, 10, 3, c, '#0b0e14');
      px(x - 2, headY - 5, 3, 1, hi);
    } else if (style === 4) {
      pxOutline(x - 6, headY - 4, 12, 5, c, '#0b0e14');
      px(x - 7, headY - 1, 2, 4, c);
      px(x + 5, headY - 1, 2, 4, c);
      px(x - 4, headY - 3, 6, 2, hi);
    } else {
      pxOutline(x - 5, headY - 3, 10, 4, c, '#0b0e14');
      px(x - 4, headY - 3, 7, 2, hi);
      px(x - 6, headY, 12, 1, c);
    }
  }

  function drawHairBack(x, headY, hair, style) {
    const c = hair.base;
    const hi = hair.hi;
    if (style === 0) {
      // Short crop from behind: full hair coverage down to tapered nape
      pxOutline(x - 5, headY - 2, 10, 8, c, '#0b0e14');
      px(x - 3, headY - 1, 6, 2, hi);
      px(x - 4, headY + 6, 8, 1, c);
    } else if (style === 1) {
      // Spiky hair from behind
      pxOutline(x - 5, headY - 2, 10, 8, c, '#0b0e14');
      px(x - 4, headY - 4, 2, 2, c);
      px(x - 1, headY - 4, 3, 2, c);
      px(x + 3, headY - 3, 2, 2, c);
      px(x - 2, headY - 1, 5, 2, hi);
    } else if (style === 2) {
      // Long flowing hair cascading down the back
      pxOutline(x - 6, headY - 2, 12, 11, c, '#0b0e14');
      px(x - 4, headY - 1, 8, 2, hi);
      px(x - 3, headY + 3, 2, 5, hi);
      px(x + 2, headY + 3, 2, 5, hi);
    } else if (style === 3) {
      // Full hair back with top bun on crown
      pxOutline(x - 5, headY - 2, 10, 8, c, '#0b0e14');
      pxOutline(x - 3, headY - 5, 6, 4, c, '#0b0e14');
      px(x - 2, headY - 4, 4, 2, hi);
      px(x - 3, headY - 1, 6, 1, '#f43f5e'); // Hair tie under bun
    } else if (style === 4) {
      // Voluminous curly afro from behind
      pxOutline(x - 6, headY - 4, 12, 10, c, '#0b0e14');
      px(x - 7, headY - 1, 14, 5, c);
      px(x - 4, headY - 2, 8, 3, hi);
    } else {
      // Fitted cap / beanie from behind with snapback strap detail
      pxOutline(x - 5, headY - 3, 10, 8, c, '#0b0e14');
      px(x - 4, headY - 2, 8, 3, hi);
      px(x - 2, headY + 3, 4, 2, '#0b0e14'); // Snapback cutout
      px(x - 2, headY + 4, 4, 1, '#94a3b8'); // Adjustment strap
    }
  }

  // --- Sub-Agent Sprite (Cute Mini-Bot / Helper Assistant) ---
  function subAgentPosition(parent, idx) {
    const offsets = [
      { dx: 18, dy: 2 },
      { dx: -18, dy: 2 },
      { dx: 22, dy: -8 },
      { dx: -22, dy: -8 },
      { dx: 14, dy: 11 },
      { dx: -14, dy: 11 },
    ];
    const off = offsets[idx % offsets.length];
    return {
      x: Math.max(12, Math.min(VW - 12, parent.x + off.dx)),
      y: Math.max(58, Math.min(VH - 8, parent.y + off.dy)),
    };
  }

  function drawSubAgentSprite(parent, sub, t) {
    const pos = subAgentPosition(parent, sub.idx);
    const x = Math.round(pos.x);
    const y = Math.round(pos.y);
    const ap = sub.appearance;
    const pulse = Math.round(Math.sin(t * 7 + sub.idx * 1.5));

    const steps = 6;
    for (let i = 1; i < steps; i++) {
      const lx = Math.round(parent.x + ((x - parent.x) * i) / steps);
      const ly = Math.round(parent.y - 6 + ((y - 4 - (parent.y - 6)) * i) / steps);
      const activeDot = (Math.floor(t * 8) + i) % 3 === 0;
      px(lx, ly, 1, 1, activeDot ? '#c084fc' : 'rgba(168, 85, 247, 0.45)');
    }

    drawEllipseShadow(x, y + 1, 5, 2, 0.35);

    const by = y - 8 + pulse;
    pxOutline(x - 3, by + 3, 6, 4, ap.shirt.base, '#0b0e14');
    pxOutline(x - 4, by - 3, 8, 6, '#e2e8f0', '#0b0e14');
    px(x - 3, by - 1, 6, 2, '#0f172a');
    px(x - 2, by - 1, 2, 1, '#38bdf8');
    px(x + 1, by - 1, 2, 1, '#38bdf8');
    px(x, by - 5, 1, 2, '#94a3b8');
    px(x - 1, by - 6, 3, 2, Math.floor(t * 6 + sub.idx) % 2 === 0 ? '#c084fc' : '#9333ea');
  }

  // --- Office Pet: Pink Alpaca ("Flocke") ---
  function pickAlpacaWaypoint() {
    if (!layout) return { x: 140, y: 160 };
    const { aisleX, wallH, vh, splitX, topRowY, midRowY, botRowY, rxCenter, bistroY, boardY, row2Y, row3Y } = layout;
    const lane1Y = Math.round((topRowY + midRowY) / 2) + 8;
    const lane2Y = Math.round((midRowY + botRowY) / 2) + 8;
    const spots = [
      { x: aisleX + 8, y: wallH + 26 },
      { x: aisleX + 8, y: lane1Y },
      { x: aisleX + 8, y: lane2Y },
      { x: aisleX + 8, y: vh - 20 },
      { x: Math.round(splitX * 0.25), y: lane1Y },
      { x: Math.round(splitX * 0.72), y: lane1Y },
      { x: Math.round(splitX * 0.28), y: lane2Y },
      { x: Math.round(splitX * 0.72), y: lane2Y },
      { x: Math.round(splitX * 0.35), y: vh - 16 },
      { x: Math.round(splitX * 0.68), y: vh - 16 },
      { x: rxCenter, y: bistroY + 14 },
      { x: rxCenter - 8, y: boardY + 42 },
      { x: rxCenter - 12, y: row2Y + 8 },
      { x: splitX + 34, y: row3Y - 4 },
    ];
    return spots[Math.floor(Math.random() * spots.length)];
  }

  function updateAlpaca(dt) {
    if (!layout) return;
    if (!alpaca.initialized || alpaca.x < 10 || alpaca.x > VW - 10 || alpaca.y < layout.wallH || alpaca.y > VH - 6) {
      alpaca.x = layout.aisleX + 8;
      alpaca.y = Math.round((layout.topRowY + layout.midRowY) / 2) + 8;
      alpaca.tx = alpaca.x;
      alpaca.ty = alpaca.y;
      alpaca.mode = 'wander';
      alpaca.timer = 2.5;
      alpaca.initialized = true;
    }

    const dx = alpaca.tx - alpaca.x;
    const dy = alpaca.ty - alpaca.y;
    const dist = Math.hypot(dx, dy);
    const speed = 26;

    if (dist > 0.5) {
      const step = Math.min(dist, speed * dt);
      alpaca.x += (dx / dist) * step;
      alpaca.y += (dy / dist) * step;
      if (Math.abs(dx) > 0.2) alpaca.facing = dx > 0 ? 1 : -1;
    } else {
      alpaca.x = alpaca.tx;
      alpaca.y = alpaca.ty;
      if (alpaca.mode === 'wander') {
        alpaca.mode = 'idle';
        alpaca.timer = Math.max(alpaca.timer, 2.5 + Math.random() * 3.0);
      }
    }

    alpaca.timer -= dt;
    if (alpaca.timer <= 0) {
      const r = Math.random();
      if (r < 0.44) {
        const wp = pickAlpacaWaypoint();
        alpaca.mode = 'wander';
        alpaca.tx = wp.x;
        alpaca.ty = wp.y;
        alpaca.timer = 6 + Math.random() * 5;
      } else if (r < 0.66) {
        alpaca.mode = 'idle';
        alpaca.tx = alpaca.x;
        alpaca.ty = alpaca.y;
        if (Math.random() < 0.45) alpaca.facing *= -1;
        alpaca.timer = 3 + Math.random() * 4;
      } else if (r < 0.83 && layout.plants?.length) {
        const p = layout.plants[Math.floor(Math.random() * layout.plants.length)];
        const side = p.x < layout.splitX * 0.5 ? 1 : -1;
        alpaca.mode = 'graze';
        alpaca.tx = Math.max(18, Math.min(VW - 18, p.x + side * 12));
        alpaca.ty = Math.max(layout.wallH + 14, Math.min(VH - 10, p.y + 3));
        alpaca.facing = -side;
        alpaca.timer = 6 + Math.random() * 4;
      } else {
        alpaca.mode = 'sleep';
        alpaca.tx = alpaca.x;
        alpaca.ty = alpaca.y;
        alpaca.timer = 9 + Math.random() * 7;
      }
    }
  }

  function drawPixelHeart(cx, cy, col) {
    px(cx - 2, cy, 2, 1, col);
    px(cx + 1, cy, 2, 1, col);
    px(cx - 3, cy + 1, 7, 2, col);
    px(cx - 2, cy + 3, 5, 1, col);
    px(cx - 1, cy + 4, 3, 1, col);
    px(cx, cy + 5, 1, 1, col);
  }

  function drawAlpacaSprite(t) {
    const x = Math.round(alpaca.x);
    const y = Math.round(alpaca.y);
    const f = alpaca.facing >= 0 ? 1 : -1;
    const dist = Math.hypot(alpaca.tx - alpaca.x, alpaca.ty - alpaca.y);
    const moving = dist > 0.5;
    const isSleeping = alpaca.mode === 'sleep' && !moving;
    const isGrazing = alpaca.mode === 'graze' && !moving;
    const isHappy = t < alpaca.heartsUntil || alpaca.mode === 'happy';

    // Mirrored pixel helpers relative to (x, y) facing f
    const apx = (dx, dy, w, h, col) => {
      const rx = f === 1 ? x + dx : x - dx - w;
      px(rx, y + dy, w, h, col);
    };
    const apxOut = (dx, dy, w, h, fill, out = '#1f0d1d') => {
      const rx = f === 1 ? x + dx : x - dx - w;
      pxOutline(rx, y + dy, w, h, fill, out);
    };

    drawEllipseShadow(x, y + 1, isSleeping ? 9 : 8, 3, 0.38);

    if (isSleeping) {
      // Curled-up sleeping pink alpaca on the floor
      const breath = Math.floor(t * 1.6) % 2;
      // Tucked legs & hooves
      apx(-6, -2, 4, 2, '#be185d');
      apx(2, -2, 4, 2, '#be185d');
      // Fluffy pink wool body lying down
      apxOut(-8, -8 - breath, 14, 7 + breath, '#f472b6');
      apx(-7, -7 - breath, 12, 2, '#fbcfe8');
      apx(-6, -3, 10, 2, '#db2777');
      // Fluffy tail
      apxOut(-10, -7, 3, 3, '#f9a8d4');
      // Neck & head resting forward on paws
      apxOut(3, -11, 5, 6, '#f472b6');
      apxOut(4, -14, 7, 5, '#f472b6');
      apx(5, -15, 4, 2, '#fbcfe8'); // Fluffy topknot
      // Relaxed alpaca ears
      apxOut(4, -16, 2, 3, '#db2777');
      apxOut(7, -16, 2, 3, '#f472b6');
      // Cream-pink snout
      apx(9, -12, 2, 2, '#fce7f3');
      apx(10, -12, 1, 1, '#be185d');
      // Closed sleeping eye + rosy cheek
      apx(7, -12, 2, 1, '#1f0d1d');
      apx(6, -11, 2, 1, '#fb7185');

      // Floating pink/lavender Zzz
      const zStep = Math.floor(t * 2) % 3;
      const zx = x + f * 8;
      const zy = y - 18 - zStep * 2;
      px(zx, zy, 3, 1, '#f9a8d4');
      px(zx + 1, zy + 1, 1, 1, '#f9a8d4');
      px(zx, zy + 2, 3, 1, '#f9a8d4');
      if (zStep >= 1) {
        px(zx + 4, zy - 4, 2, 1, '#f472b6');
        px(zx + 4, zy - 2, 2, 1, '#f472b6');
      }
      return;
    }

    // Standing / Walking / Grazing / Happy Alpaca
    const hop = isHappy ? Math.abs(Math.round(Math.sin(t * 11) * 2)) : 0;
    const bob = (moving ? (Math.floor(t * 10) % 2) : 0) + hop;
    const stride = moving ? Math.round(Math.sin(t * 13) * 1.5) : 0;
    const headDrop = isGrazing ? 3 + (Math.floor(t * 5) % 2) : 0;

    // 1. Back legs (darker pink)
    apx(-5 - stride, -5 - hop, 2, 5, '#be185d');
    apx(-5 - stride, -1 - hop, 2, 1, '#3b152a');
    apx(2 + stride, -5 - hop, 2, 5, '#be185d');
    apx(2 + stride, -1 - hop, 2, 1, '#3b152a');

    // 2. Front legs (bright pink + dark hooves)
    apx(-7 + stride, -5 - hop, 2, 6, '#ec4899');
    apx(-7 + stride, 0 - hop, 2, 1, '#3b152a');
    apx(4 - stride, -5 - hop, 2, 6, '#ec4899');
    apx(4 - stride, 0 - hop, 2, 1, '#3b152a');

    // 3. Fluffy pom-pom tail (wags when walking or happy)
    const tailWag = (moving || isHappy) ? (Math.floor(t * 8) % 2) : 0;
    apxOut(-10, -11 - bob - tailWag, 3, 4, '#f9a8d4');
    apx(-9, -10 - bob - tailWag, 2, 2, '#fbcfe8');

    // 4. Fluffy cotton-candy pink body
    apxOut(-8, -12 - bob, 14, 8, '#f472b6');
    apx(-7, -13 - bob, 11, 2, '#f9a8d4'); // Scalloped top wool puff
    apx(-6, -11 - bob, 9, 2, '#fbcfe8');  // Wool highlight
    apx(-7, -6 - bob, 12, 2, '#db2777');  // Underbelly shade
    // Wool curl texture dots
    apx(-4, -9 - bob, 2, 1, '#fbcfe8');
    apx(0, -8 - bob, 2, 1, '#fbcfe8');

    // 5. Long fluffy alpaca neck
    apxOut(2, -18 - bob + headDrop, 5, 8, '#f472b6');
    apx(3, -17 - bob + headDrop, 2, 6, '#f9a8d4');

    // 6. Perky alpaca ears
    const earTwitch = (!moving && Math.floor(t * 3) % 7 === 0) ? 1 : 0;
    apxOut(2, -24 - bob + headDrop, 2, 4, '#db2777');
    apxOut(5, -24 - bob + headDrop + earTwitch, 2, 4, '#f472b6');
    apx(5, -23 - bob + headDrop + earTwitch, 1, 2, '#fce7f3');

    // 7. Head, fluffy topknot & snout
    apxOut(1, -21 - bob + headDrop, 7, 6, '#f472b6');
    apx(2, -22 - bob + headDrop, 5, 2, '#fbcfe8'); // Fluffy head poof
    apxOut(7, -19 - bob + headDrop, 3, 4, '#fce7f3'); // Cream-pink muzzle
    apx(9, -19 - bob + headDrop, 1, 1, '#be185d'); // Cute nose

    // 8. Eye & rosy blush cheek
    const blinking = (t % 4.1) < 0.14;
    if (isHappy || blinking) {
      apx(5, -19 - bob + headDrop, 2, 1, '#1f0d1d');
    } else {
      apx(5, -19 - bob + headDrop, 2, 2, '#0f172a');
      apx(6, -19 - bob + headDrop, 1, 1, '#ffffff'); // Eye sparkle
    }
    apx(4, -17 - bob + headDrop, 2, 1, '#fb7185'); // Blush

    // Grazing leaf particles
    if (isGrazing) {
      const nibble = Math.floor(t * 6) % 2;
      apx(10, -18 - bob + headDrop + nibble, 2, 2, '#22c55e');
      apx(11, -19 - bob + headDrop, 1, 1, '#4ade80');
    }

    // Floating pixel hearts when petted
    if (t < alpaca.heartsUntil) {
      const floatOff = Math.round(((t * 10) % 8));
      drawPixelHeart(x - 4, y - 26 - floatOff, '#f43f5e');
      drawPixelHeart(x + 5, y - 23 - ((floatOff + 4) % 8), '#fb7185');
    }
  }

  // --- High-DPI Screen Overlay: Zone Headers & Non-Overlapping Nameplates ---
  function vToScreen(vx, vy) {
    return {
      x: vx * viewTransform.scale,
      y: vy * viewTransform.scale,
    };
  }

  function screenToV(sx, sy) {
    return {
      vx: sx / viewTransform.scale,
      vy: sy / viewTransform.scale,
    };
  }

  function drawRoundedRect(c, x, y, w, h, r) {
    const rad = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + rad, y);
    c.arcTo(x + w, y, x + w, y + h, rad);
    c.arcTo(x + w, y + h, x, y + h, rad);
    c.arcTo(x, y + h, x, y, rad);
    c.arcTo(x, y, x + w, y, rad);
    c.closePath();
  }

  function drawZoneHeadersHighDpi() {
    const { splitX, z1Top, z2Top, z3Top } = layout;
    // Place zone headers cleanly in the dedicated top header band of each zone
    const zones = [
      { vxLeft: splitX + 38, vy: z1Top + 9, icon: '☕', text: 'KAFFEEKÜCHE', color: '#60a5fa' },
      { vxLeft: splitX + 6,  vy: z2Top + 9, icon: '❓', text: 'RÜCKFRAGEN',  color: '#fbbf24' },
      { vxLeft: splitX + 6,  vy: z3Top + 9, icon: '🛋️', text: 'FEIERABEND',  color: '#94a3b8' },
    ];

    const fontPx = Math.max(10, Math.min(12.5, Math.round(viewTransform.scale * 4.8)));
    ctx.font = `700 ${fontPx}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';

    for (const z of zones) {
      const pLeft = vToScreen(z.vxLeft, z.vy);
      const label = `${z.icon} ${z.text}`;
      const tw = ctx.measureText(label).width;
      const padX = 7;
      const bh = fontPx + 6;
      const bw = tw + padX * 2;
      const bx = Math.round(pLeft.x);
      const by = Math.round(pLeft.y - bh / 2);

      drawRoundedRect(ctx, bx, by, bw, bh, 5);
      ctx.fillStyle = 'rgba(13, 17, 26, 0.86)';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
      ctx.stroke();

      ctx.fillStyle = z.color;
      ctx.fillText(label, bx + padX, by + bh / 2 + 0.5);
    }
  }

  function drawActorLabelsHighDpi() {
    labelBoxes = [];
    if (!showLabels) return;

    const fontPx = Math.max(10.5, Math.min(13, Math.round(viewTransform.scale * 5.4)));
    ctx.font = `600 ${fontPx}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';

    const statusColors = {
      active: '#4ade80',
      waiting: '#fbbf24',
      idle: '#60a5fa',
      exited: '#94a3b8',
    };

    const items = [];
    for (const a of actors.values()) {
      const anchor = vToScreen(a.x, a.y + 3);
      const rawName = a.name || '';
      const maxChars = viewTransform.scale < 1.8 ? 15 : 22;
      const shortName = rawName.length > maxChars ? rawName.slice(0, maxChars - 1) + '…' : rawName;
      const subSuffix = a.subAgents?.length ? ` +${a.subAgents.length}` : '';

      const nameW = ctx.measureText(shortName).width;
      const subW = subSuffix ? ctx.measureText(subSuffix).width + 4 : 0;
      const dotSpace = 11;
      const padX = 7;
      const bw = Math.ceil(dotSpace + nameW + subW + padX * 2);
      const bh = Math.ceil(fontPx + 7);

      items.push({
        actor: a,
        shortName,
        subSuffix,
        anchorX: anchor.x,
        anchorY: anchor.y,
        x: anchor.x - bw / 2,
        y: anchor.y + 3,
        w: bw,
        h: bh,
        dotColor: statusColors[a.mode] || '#94a3b8',
        isHovered: hoveredItem && hoveredItem.kind === 'actor' && hoveredItem.actor.id === a.id,
      });
    }

    items.sort((a, b) => a.anchorY - b.anchorY || a.anchorX - b.anchorX);

    const minX = 4;
    const maxX = viewTransform.cssW - 4;
    const minY = 4;
    const maxY = viewTransform.cssH - 4;

    // 2D collision avoidance against both other labels AND nearby character bodies
    const bodyObstacles = Array.from(actors.values()).map(a => {
      const p = vToScreen(a.x, a.y - 11);
      return {
        id: a.id,
        x: p.x - 6 * viewTransform.scale,
        y: p.y - 11 * viewTransform.scale,
        w: 12 * viewTransform.scale,
        h: 20 * viewTransform.scale,
      };
    });

    const pad = 3;
    for (let iter = 0; iter < 14; iter++) {
      let moved = false;
      for (let i = 0; i < items.length; i++) {
        const A = items[i];
        A.x = Math.max(minX, Math.min(maxX - A.w, A.x));
        A.y = Math.max(minY, Math.min(maxY - A.h, A.y));

        // Avoid covering other characters' heads/torsos
        for (const ob of bodyObstacles) {
          if (ob.id === A.actor.id) continue;
          const ox = Math.min(A.x + A.w, ob.x + ob.w) - Math.max(A.x, ob.x);
          const oy = Math.min(A.y + A.h, ob.y + ob.h) - Math.max(A.y, ob.y);
          if (ox > 0 && oy > 0) {
            moved = true;
            if (A.anchorY <= ob.y + ob.h / 2) {
              A.x += (A.anchorX >= ob.x + ob.w / 2 ? 1 : -1) * (ox * 0.45 + 1);
            } else {
              A.y += oy * 0.6 + 1;
            }
          }
        }

        // Avoid overlapping other labels
        for (let j = i + 1; j < items.length; j++) {
          const B = items[j];
          const overlapX = Math.min(A.x + A.w + pad, B.x + B.w + pad) - Math.max(A.x, B.x);
          const overlapY = Math.min(A.y + A.h + pad, B.y + B.h + pad) - Math.max(A.y, B.y);

          if (overlapX > 0 && overlapY > 0) {
            moved = true;
            if (overlapY <= overlapX * 1.4) {
              const shift = overlapY / 2 + 0.5;
              if (A.anchorY <= B.anchorY) {
                A.y -= shift * 0.5;
                B.y += shift * 1.5;
              } else {
                A.y += shift;
                B.y -= shift;
              }
            } else {
              const shift = overlapX / 2 + 0.5;
              if (A.anchorX <= B.anchorX) {
                A.x -= shift;
                B.x += shift;
              } else {
                A.x += shift;
                B.x -= shift;
              }
            }
          }
        }
      }
      if (!moved) break;
    }

    for (const it of items) {
      it.x = Math.round(Math.max(minX, Math.min(maxX - it.w, it.x)));
      it.y = Math.round(Math.max(minY, Math.min(maxY - it.h, it.y)));
      labelBoxes.push(it);
    }

    // Draw subtle leader lines when a label was displaced
    for (const it of items) {
      const boxCenterX = it.x + it.w / 2;
      const boxTopY = it.y;
      const dist = Math.hypot(boxCenterX - it.anchorX, boxTopY - it.anchorY);
      if (dist > 9) {
        ctx.beginPath();
        ctx.moveTo(it.anchorX, it.anchorY - 1);
        ctx.lineTo(boxCenterX, boxTopY + 2);
        ctx.strokeStyle = it.isHovered ? '#38bdf8' : 'rgba(148, 163, 184, 0.45)';
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
    }

    const ordered = [...items].sort((a, b) => (a.isHovered ? 1 : 0) - (b.isHovered ? 1 : 0));
    for (const it of ordered) {
      drawRoundedRect(ctx, it.x, it.y, it.w, it.h, 5);
      ctx.fillStyle = it.isHovered ? 'rgba(23, 33, 54, 0.96)' : 'rgba(13, 17, 26, 0.88)';
      ctx.fill();

      ctx.lineWidth = it.isHovered ? 1.5 : 1;
      ctx.strokeStyle = it.isHovered ? '#38bdf8' : 'rgba(148, 163, 184, 0.25)';
      ctx.stroke();

      const dotX = it.x + 8;
      const dotY = it.y + it.h / 2;
      ctx.beginPath();
      ctx.arc(dotX, dotY, 3, 0, Math.PI * 2);
      ctx.fillStyle = it.dotColor;
      ctx.fill();

      ctx.fillStyle = it.isHovered ? '#ffffff' : '#e6edf3';
      const textX = it.x + 15;
      const textY = it.y + it.h / 2 + 0.5;
      ctx.fillText(it.shortName, textX, textY);

      if (it.subSuffix) {
        const nw = ctx.measureText(it.shortName).width;
        ctx.fillStyle = '#c084fc';
        ctx.fillText(it.subSuffix, textX + nw, textY);
      }
    }
  }

  // --- Main Animation & Render Loop ---
  function ensureCanvasSize() {
    if (!canvas || !stageEl) return;
    const rect = stageEl.getBoundingClientRect();
    const cssW = Math.max(200, Math.floor(rect.width));
    const cssH = Math.max(200, Math.floor(rect.height));
    const dpr = window.devicePixelRatio || 1;
    const targetW = Math.round(cssW * dpr);
    const targetH = Math.round(cssH * dpr);

    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    // Choose uniform pixel scale so virtual room has at least 440×320 pixels and fills 100% of stage!
    const scale = Math.max(1.2, Math.min(3.5, cssW / 440, cssH / 320));
    const newVW = Math.max(440, Math.round(cssW / scale));
    const newVH = Math.max(320, Math.round(cssH / scale));

    if (newVW !== VW || newVH !== VH || !layout) {
      VW = newVW;
      VH = newVH;
      offCanvas.width = VW;
      offCanvas.height = VH;
      offCtx.imageSmoothingEnabled = false;
      layout = buildLayout(VW, VH);
      syncActors(true);
    }

    viewTransform = { scale, cssW, cssH, dpr };
  }

  function tickAndDraw(now) {
    const dt = Math.min(0.1, (now - lastTick) / 1000);
    lastTick = now;
    animClock += dt;

    ensureCanvasSize();

    const speed = 64;
    for (const a of actors.values()) {
      const dx = a.tx - a.x;
      const dy = a.ty - a.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 0.5) {
        const step = Math.min(dist, speed * dt);
        a.x += (dx / dist) * step;
        a.y += (dy / dist) * step;
      } else {
        a.x = a.tx;
        a.y = a.ty;
      }
    }

    updateAlpaca(dt);

    // 1. Render pixel-art room + characters onto offscreen virtual canvas (VW × VH)
    offCtx.imageSmoothingEnabled = false;
    offCtx.clearRect(0, 0, VW, VH);

    const hasWaiting = Array.from(actors.values()).some(a => a.mode === 'waiting');
    drawBackground(animClock);
    drawKitchenZone(animClock);
    drawBoardZone(animClock, hasWaiting);
    drawLoungeZone();

    const deskOccupant = new Map();
    for (const a of actors.values()) {
      if (a.deskIdx >= 0) deskOccupant.set(a.deskIdx, a);
    }

    const drawables = [];
    if (layout.bookcase) {
      drawables.push({ y: layout.bookcase.y, draw: () => drawBookcase(layout.bookcase) });
    }
    for (const d of layout.desks) {
      drawables.push({ y: d.y, draw: () => drawDeskBase(d, deskOccupant.get(d.idx), animClock) });
    }
    for (const p of layout.plants) {
      drawables.push({ y: p.y, draw: () => drawPlant(p) });
    }
    if (alpaca.initialized) {
      drawables.push({ y: alpaca.y + 2, draw: () => drawAlpacaSprite(animClock) });
    }
    for (const a of actors.values()) {
      drawables.push({ y: a.y + 2, draw: () => drawActorSprite(a, animClock) });
      if (a.subAgents?.length) {
        for (const sub of a.subAgents) {
          const sp = subAgentPosition(a, sub.idx);
          drawables.push({ y: sp.y + 2, draw: () => drawSubAgentSprite(a, sub, animClock) });
        }
      }
    }

    drawables.sort((a, b) => a.y - b.y);
    for (const item of drawables) item.draw();

    // 2. Blit offscreen pixel-art room onto High-DPI screen canvas (full-bleed 1:1 square pixels)
    const { cssW, cssH, dpr } = viewTransform;
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssW, cssH);

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(offCanvas, 0, 0, VW, VH, 0, 0, cssW, cssH);

    // 3. Render razor-sharp High-DPI Zone Headers & Nameplates on top
    ctx.imageSmoothingEnabled = true;
    drawZoneHeadersHighDpi();
    drawActorLabelsHighDpi();

    ctx.restore();

    rafId = requestAnimationFrame(tickAndDraw);
  }

  // --- Hit Testing & Tooltip ---
  function eventToPos(ev) {
    const rect = canvas.getBoundingClientRect();
    const sx = ev.clientX - rect.left;
    const sy = ev.clientY - rect.top;
    const { vx, vy } = screenToV(sx, sy);
    return { sx, sy, vx, vy, rect };
  }

  function hitTest(pos) {
    for (let i = labelBoxes.length - 1; i >= 0; i--) {
      const b = labelBoxes[i];
      if (pos.sx >= b.x && pos.sx <= b.x + b.w && pos.sy >= b.y && pos.sy <= b.y + b.h) {
        return { kind: 'actor', actor: b.actor };
      }
    }

    for (const a of actors.values()) {
      if (a.subAgents?.length) {
        for (const sub of a.subAgents) {
          const sp = subAgentPosition(a, sub.idx);
          if (Math.abs(pos.vx - sp.x) <= 7 && pos.vy >= sp.y - 14 && pos.vy <= sp.y + 3) {
            return { kind: 'sub', actor: sub, parent: a };
          }
        }
      }
    }

    let best = null;
    for (const a of actors.values()) {
      if (Math.abs(pos.vx - a.x) <= 8 && pos.vy >= a.y - 24 && pos.vy <= a.y + 4) {
        if (!best || a.y > best.y) best = a;
      }
    }
    if (best) return { kind: 'actor', actor: best };

    if (alpaca.initialized && Math.abs(pos.vx - alpaca.x) <= 10 && pos.vy >= alpaca.y - 24 && pos.vy <= alpaca.y + 3) {
      return { kind: 'alpaca' };
    }

    if (layout?.bookcase) {
      const b = layout.bookcase;
      if (Math.abs(pos.vx - b.x) <= b.w / 2 && pos.vy >= b.y - b.h - 4 && pos.vy <= b.y + 2) {
        return { kind: 'bookcase' };
      }
    }

    if (layout?.clock && Math.hypot(pos.vx - layout.clock.cx, pos.vy - layout.clock.cy) <= 7) {
      return { kind: 'env', target: 'clock' };
    }
    if (Array.isArray(layout?.windows)) {
      for (const w of layout.windows) {
        if (pos.vx >= w.x && pos.vx <= w.x + w.w && pos.vy >= w.y && pos.vy <= w.y + w.h) {
          return { kind: 'env', target: 'window', idx: w.idx };
        }
      }
    }
    return null;
  }

  function statusLabel(mode) {
    switch (mode) {
      case 'active':  return '💻 Arbeitet konzentriert am Schreibtisch';
      case 'waiting': return '❓ Wartet am Rückfragen-Board auf Eingabe';
      case 'idle':    return '☕ Kaffeepause in der Küche';
      case 'exited':  return '🛋️ Feierabend auf dem Lounge-Sofa';
      default:        return mode;
    }
  }

  function alpacaStatusLabel() {
    if (animClock < alpaca.heartsUntil || alpaca.mode === 'happy') {
      return '💖 Freut sich riesig über Streicheleinheiten!';
    }
    const moving = Math.hypot(alpaca.tx - alpaca.x, alpaca.ty - alpaca.y) > 0.5;
    if (alpaca.mode === 'sleep' && !moving) {
      return '😴 Macht ein gemütliches Nickerchen';
    }
    if (alpaca.mode === 'graze' && !moving) {
      return '🌿 Knabbert heimlich an einer Büropflanze';
    }
    if (moving) {
      return '🌸 Tippelt gut gelaunt durchs Büro';
    }
    return '🦙 Schaut entspannt dem Team bei der Arbeit zu';
  }

  function updateTooltip(hit, pos) {
    if (!tooltipEl) return;
    if (!hit) {
      tooltipEl.hidden = true;
      return;
    }
    if (hit.kind === 'alpaca') {
      tooltipEl.innerHTML = `
        <div class="tt-name">🦙 ${escapeHtml(alpaca.name)} (Büro-Alpaka)</div>
        <div class="tt-status s-active" style="color:#f472b6">${alpacaStatusLabel()}</div>
        <div class="tt-hint">Klicken zum Streicheln 🌸</div>
      `;
    } else if (hit.kind === 'bookcase') {
      tooltipEl.innerHTML = `
        <div class="tt-name">📚 Büro-Bibliothek</div>
        <div class="tt-status s-idle">Clean Code, Pixel-Art &amp; Alpakahaltung für Fortgeschrittene</div>
      `;
    } else if (hit.kind === 'env') {
      const env = getEnvironmentState();
      const tempPart = env.tempExact !== null ? `${env.tempExact} °C · ` : '';
      const windPart = env.windSpeed !== null ? ` · 💨 ${env.windSpeed} km/h` : '';
      tooltipEl.innerHTML = `
        <div class="tt-name">${env.icon} Bielefeld · ${env.timeStr} Uhr</div>
        <div class="tt-status s-idle">${tempPart}${escapeHtml(env.text)} (${env.cloudCover}% Bewölkung${windPart})</div>
        <div class="tt-sub">🌅 ${env.sunriseStr} Uhr · 🌇 ${env.sunsetStr} Uhr${hit.idx === 1 ? ' · 🏰 Blick zur Sparrenburg' : ''}</div>
      `;
    } else if (hit.kind === 'sub') {
      const sub = hit.actor;
      const ageSec = Math.round((sub.ageMs || 0) / 1000);
      const isRun = sub.status === 'running';
      const detailLine = sub.detail ? `${escapeHtml(sub.detail)} · ` : '';
      tooltipEl.innerHTML = `
        <div class="tt-name">🤖 ${escapeHtml(sub.slug)}${sub.role && sub.role !== sub.slug ? ` <span style="opacity:0.65;font-weight:400">(${escapeHtml(sub.role)})</span>` : ''}</div>
        <div class="tt-status ${isRun ? 's-active' : 's-idle'}">${isRun ? '⚡ Arbeitet' : '✅ Fertig'} für „${escapeHtml(sub.parentName)}"</div>
        <div class="tt-sub">${detailLine}vor ${ageSec}s · Klick öffnet Haupt-Session</div>
      `;
    } else {
      const a = hit.actor;
      const subs = a.subAgents || [];
      const nSub = subs.length;
      const nRun = subs.filter(x => x.status === 'running').length;
      const subNames = subs.slice(0, 3).map(s => escapeHtml(s.slug)).join(', ');
      const subLine = nSub > 0
        ? `<div class="tt-sub">🤖 ${nRun}/${nSub} Sub-Agent${nSub === 1 ? '' : 'en'}: ${subNames}${nSub > 3 ? '…' : ''}</div>`
        : (a.subTotalSeen > 0 ? `<div class="tt-sub">🤖 ${a.subTotalSeen} Sub-Agent${a.subTotalSeen === 1 ? '' : 'en'} genutzt</div>` : '');
      tooltipEl.innerHTML = `
        <div class="tt-name">${escapeHtml(a.name)}</div>
        <div class="tt-status s-${a.mode}">${statusLabel(a.mode)}</div>
        ${subLine}
        <div class="tt-hint">Klicken, um Session zu öffnen</div>
      `;
    }
    tooltipEl.hidden = false;

    const stageRect = stageEl.getBoundingClientRect();
    const ttRect = tooltipEl.getBoundingClientRect();
    const maxX = Math.max(8, stageRect.width - ttRect.width - 10);
    const maxY = Math.max(8, stageRect.height - ttRect.height - 10);
    tooltipEl.style.left = Math.min(maxX, Math.max(8, pos.sx + 14)) + 'px';
    tooltipEl.style.top = Math.min(maxY, Math.max(8, pos.sy - 10)) + 'px';
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
          <canvas class="buero-canvas"></canvas>
          <div class="buero-tooltip" hidden></div>
        </div>
      </div>
    `;
    statsEl = el.querySelector('.buero-stats');
    stageEl = el.querySelector('.buero-stage');
    canvas = el.querySelector('.buero-canvas');
    ctx = canvas.getContext('2d');

    offCanvas = document.createElement('canvas');
    offCanvas.width = VW;
    offCanvas.height = VH;
    offCtx = offCanvas.getContext('2d');
    offCtx.imageSmoothingEnabled = false;

    tooltipEl = el.querySelector('.buero-tooltip');

    if (resizeObserver) resizeObserver.disconnect();
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => ensureCanvasSize());
      resizeObserver.observe(stageEl);
    }

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
      const pos = eventToPos(ev);
      const hit = hitTest(pos);
      hoveredItem = hit;
      canvas.style.cursor = hit && hit.kind !== 'env' && hit.kind !== 'bookcase' ? 'pointer' : 'default';
      updateTooltip(hit, pos);
    });

    canvas.addEventListener('mouseleave', () => {
      hoveredItem = null;
      if (tooltipEl) tooltipEl.hidden = true;
    });

    canvas.addEventListener('click', ev => {
      const pos = eventToPos(ev);
      const hit = hitTest(pos);
      if (!hit || hit.kind === 'env' || hit.kind === 'bookcase') return;
      if (hit.kind === 'alpaca') {
        alpaca.heartsUntil = animClock + 4.0;
        alpaca.mode = 'happy';
        alpaca.tx = alpaca.x;
        alpaca.ty = alpaca.y;
        alpaca.timer = 3.5;
        updateTooltip(hit, pos);
        return;
      }
      if (!api?.openSession) return;
      const targetSessionId = hit.kind === 'sub' ? hit.actor.parentId : hit.actor.id;
      api.openSession(targetSessionId);
    });

    ensureCanvasSize();
    syncActors(true);
    try { api?.send?.({ action: 'refresh' }); } catch {}
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
