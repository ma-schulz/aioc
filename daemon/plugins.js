// Plugins: optionale Erweiterungen, die außerhalb von Aioc liegen. <AIOC_HOME>/plugins.json listet
// ihre Ordner; ohne diese Datei lädt Aioc nichts. Ein Plugin-Ordner enthält plugin.json
// ({ id, name, icon, daemon, ui, css }) und die dort genannten Dateien:
// - daemon: Node-Modul mit activate(ctx) -> { handle(msg)?, sessionsChanged()? }. Es läuft im Daemon
//   mit dessen Rechten - deshalb nur Ordner eintragen, deren Code man kennt.
// - ui / css: werden der Oberfläche ausgeliefert; ui.js meldet sich über AiocPlugins.register an.
// Ein Plugin bekommt einen schmalen Kontext statt des SessionManagers: eigener Datenordner, Zustand
// an die Oberfläche schicken, Feed-Einträge, Sessions anlegen und nur die eigenen steuern.
const fs = require('fs');
const path = require('path');
const state = require('./state');

const PLUGINS_FILE = path.join(state.DIR, 'plugins.json');
const ID = /^[a-z][a-z0-9-]{1,30}$/;

function sessionView(s) {
  const e = s.entry;
  return { id: e.id, name: e.name, agent: e.agent, cwd: e.cwd, status: e.status, detail: e.detail, running: !!s.proc, owner: e.owner || null };
}

class PluginHost {
  constructor({ mgr, publish }) {
    this.mgr = mgr;
    this.publish = publish; // (plugin) => an alle Clients
    this.plugins = new Map();
  }

  load() {
    const list = state.readJson(PLUGINS_FILE, []);
    for (const item of Array.isArray(list) ? list : []) {
      const dir = typeof item === 'string' ? item : item?.path;
      if (!dir || item?.enabled === false) continue;
      try {
        this.loadOne(path.resolve(dir));
      } catch (err) {
        console.error(`[aioc] Plugin ${dir}: ${err.message}`);
        this.mgr.pushFeed(`Plugin ${path.basename(dir)} nicht geladen: ${err.message}`);
      }
    }
  }

  loadOne(dir) {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
    if (!ID.test(meta.id || '')) throw new Error('plugin.json: id fehlt oder ungültig');
    if (this.plugins.has(meta.id)) throw new Error(`id „${meta.id}" ist doppelt`);
    const inside = f => {
      const p = path.resolve(dir, f);
      if (!p.startsWith(dir + path.sep)) throw new Error(`${f} liegt außerhalb des Plugin-Ordners`);
      return p;
    };
    const p = {
      id: meta.id,
      name: String(meta.name || meta.id).slice(0, 40),
      icon: String(meta.icon || '◆').slice(0, 4),
      dir,
      files: { ui: meta.ui ? inside(meta.ui) : null, css: meta.css ? inside(meta.css) : null },
      state: null,
      impl: {},
    };
    this.plugins.set(p.id, p);
    if (meta.daemon) {
      const mod = require(inside(meta.daemon));
      p.impl = (typeof mod.activate === 'function' && mod.activate(this.context(p))) || {};
    }
    console.log(`[aioc] Plugin geladen: ${p.id} (${dir})`);
  }

  context(p) {
    const mgr = this.mgr;
    const dataDir = path.join(state.DIR, p.id);
    fs.mkdirSync(dataDir, { recursive: true });
    const own = id => {
      const s = mgr.sessions.get(id);
      if (!s || s.entry.owner !== p.id) throw new Error('Session gehört nicht zu diesem Plugin');
      return s;
    };
    return {
      id: p.id,
      name: p.name,
      dataDir,
      // Zustand für die Oberfläche: kommt beim Verbindungsaufbau mit und wird bei jeder Änderung verteilt
      publish: data => { p.state = data; this.publish(p); },
      feed: text => { mgr.pushFeed(`${p.name} · ${text}`); mgr.persistAndBroadcast(); },
      sessions: {
        list: () => [...mgr.sessions.values()].map(sessionView),
        // owned: true -> gehört dem Plugin (geschützt); sonst eine ganz normale Session
        create: ({ agent, cwd, name, args, cols, rows, owned = false }) =>
          sessionView(mgr.create({ agent, cwd, name, args, cols, rows, owner: owned ? p.id : undefined })),
        restore: (id, cols, rows) => { own(id); mgr.restore(id, cols, rows); },
        prompt: (id, text) => own(id).sendPrompt(text),
        kill: id => own(id).kill(),
      },
    };
  }

  handle(m) {
    const p = this.plugins.get(m.id);
    if (!p || typeof p.impl.handle !== 'function') throw new Error('Unbekanntes Plugin: ' + m.id);
    p.impl.handle(m.msg && typeof m.msg === 'object' ? m.msg : {});
  }

  sessionsChanged() {
    for (const p of this.plugins.values()) {
      try { p.impl.sessionsChanged?.(); } catch (err) { console.error(`[aioc] Plugin ${p.id}:`, err.message); }
    }
  }

  // Statische Dateien eines Plugins: nur ui und css aus plugin.json
  file(urlPath) {
    const m = urlPath.match(/^\/plugins\/([a-z][a-z0-9-]{1,30})\/(ui\.js|ui\.css)$/);
    const p = m && this.plugins.get(m[1]);
    if (!p) return null;
    return m[2] === 'ui.js' ? (p.files.ui && [p.files.ui, 'text/javascript']) : (p.files.css && [p.files.css, 'text/css']);
  }

  toClient() {
    return [...this.plugins.values()].map(p => ({
      id: p.id, name: p.name, icon: p.icon,
      ui: p.files.ui ? `/plugins/${p.id}/ui.js` : null,
      css: p.files.css ? `/plugins/${p.id}/ui.css` : null,
      state: p.state,
    }));
  }
}

module.exports = { PluginHost };
