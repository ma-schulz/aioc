// Claude-Anmeldung je Konto erneuern und rechtzeitig daran erinnern. Die claude.ai-Anmeldung läuft
// rund einmal im Monat ab; Claude selbst warnt erst drei Tage vorher und nur beim Start einer Session.
// „Neu anmelden“ startet `claude auth login` als sichtbare pwsh-Session mit dem Konfigurationsordner
// des Kontos (Browser-URL und Code-Eingabe bleiben so erreichbar). Mehrere Konten laufen nacheinander,
// damit nie zwei Browser-Anmeldungen gleichzeitig offen sind. Danach prüft Aioc Ablaufdatum und Organisation.
const os = require('os');
const state = require('./state');
const accounts = require('./claude-accounts');

const WARN = new Set(['bald', 'abgelaufen', 'abgemeldet', 'fremdeOrg']);
const MAIL = /^[^\s"'`$;&|<>()]+@[^\s"'`$;&|<>()]+$/;
const bis = ms => new Date(ms).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function meldung(k) {
  const n = `„${accounts.labelOf(k)}“`;
  switch (k.status) {
    case 'bald': return `Claude-Login ${n} läuft am ${bis(k.loginBis)} ab · „Neu anmelden“ in der Seitenleiste`;
    case 'abgelaufen': return `Claude-Login ${n} ist abgelaufen · Sessions dieses Kontos arbeiten nicht mehr`;
    case 'abgemeldet': return `Claude-Konto ${n} ist nicht mehr angemeldet`;
    case 'fremdeOrg': return `⚠ Claude-Konto „${k.id}“ ist bei „${k.org}“ angemeldet statt bei „${k.erwartetOrg}“`;
    default: return null;
  }
}

class ClaudeLogin {
  // onChange: Konten oder Feed haben sich geändert (Daemon schickt beides an die Oberflächen)
  constructor({ mgr, onChange }) {
    this.mgr = mgr;
    this.onChange = onChange;
    this.queue = [];
    this.active = null; // { konto, sessionId, before }
    this.last = new Map(); // zuletzt gemeldeter Status je Konto
  }

  // Konten für die Oberfläche, mit Stand der Anmeldung: login = 'laeuft' | 'wartet' | null
  toClient(opts) {
    return accounts.toClient(opts).map(k => ({
      ...k,
      login: this.active?.konto === k.id ? 'laeuft' : this.queue.includes(k.id) ? 'wartet' : null,
    }));
  }

  start(ids, { cols, rows } = {}) {
    if (!Array.isArray(ids) || !ids.length) throw new Error('Kein Konto angegeben');
    const known = accounts.list({ fresh: true });
    for (const id of ids) {
      if (!known.some(k => k.id === id)) throw new Error('Unbekanntes Claude-Konto: ' + id);
      if (this.active?.konto !== id && !this.queue.includes(id)) this.queue.push(id);
    }
    this.size = { cols, rows };
    this.next();
    this.onChange();
  }

  next() {
    if (this.active || !this.queue.length) return;
    const id = this.queue.shift();
    const k = accounts.list({ fresh: true }).find(x => x.id === id);
    if (!k) { this.next(); return; }
    const cmd = 'claude auth login' + (k.email && MAIL.test(k.email) ? ' --email ' + k.email : '');
    // Die Login-Session soll nicht als zuletzt benutzter Ordner im Dialog „+ Neu“ auftauchen
    const recents = state.loadUiState().recents;
    const s = this.mgr.create({
      agent: 'pwsh', cwd: os.homedir(), name: `Login ${accounts.labelOf(k)}`,
      args: `-NoProfile -Command "${cmd}"`, cols: this.size?.cols, rows: this.size?.rows,
      env: accounts.envFor(id),
    });
    const ui = state.loadUiState();
    ui.recents = recents || [];
    state.saveUiState(ui);
    this.active = { konto: id, sessionId: s.entry.id, before: { angemeldet: k.angemeldet, loginBis: k.loginBis, credMtime: k.credMtime } };
  }

  // Statuswechsel einer Session (Daemon onStatus): Ende der Login-Session auswerten
  sessionStatus(entry) {
    if (!this.active || entry.id !== this.active.sessionId || entry.status !== 'exited') return;
    const { konto, sessionId, before } = this.active;
    this.active = null;
    const k = accounts.list({ fresh: true }).find(x => x.id === konto);
    const erneuert = !!k?.angemeldet && (
      !before.angemeldet || (k.loginBis || 0) > (before.loginBis || 0) || (!k.loginBis && k.credMtime > before.credMtime));
    if (!erneuert) {
      this.mgr.pushFeed(`Claude-Login „${k ? accounts.labelOf(k) : konto}“ nicht abgeschlossen · Ausgabe in der Login-Session`);
    } else if (k.status === 'fremdeOrg') {
      this.mgr.pushFeed(meldung(k));
    } else {
      this.mgr.pushFeed(`Claude-Login „${accounts.labelOf(k)}“ erneuert${k.loginBis ? ' · gültig bis ' + bis(k.loginBis) : ''}`);
      // Erfolgreiche Login-Session nach kurzer Zeit wegräumen, eine gescheiterte bleibt zum Nachlesen
      setTimeout(() => { try { this.mgr.dispose(sessionId); } catch {} }, 4000).unref?.();
    }
    if (k) this.last.set(k.id, k.status);
    this.next();
    this.onChange();
  }

  // Login-Session entfernt, bevor sie fertig war
  sessionGone(id) {
    if (this.active?.sessionId !== id) return;
    this.active = null;
    this.next();
    this.onChange();
  }

  acceptOrg(id) {
    accounts.acceptOrg(id);
    const k = accounts.list({ fresh: true }).find(x => x.id === id);
    if (k) this.last.set(k.id, k.status);
    this.mgr.pushFeed(`Claude-Konto „${id}“ gehört jetzt zu „${k?.org || '?'}“`);
    this.onChange();
  }

  // Regelmäßig (und beim Start): Statuswechsel melden, Oberflächen nur bei Änderung neu versorgen
  check() {
    let changed = false;
    const seen = new Set();
    for (const k of accounts.list({ fresh: true })) {
      seen.add(k.id);
      if (this.last.get(k.id) === k.status) continue;
      changed = true;
      this.last.set(k.id, k.status);
      if (WARN.has(k.status) && this.active?.konto !== k.id) this.mgr.pushFeed(meldung(k));
    }
    for (const id of [...this.last.keys()]) if (!seen.has(id)) { this.last.delete(id); changed = true; }
    if (changed) this.onChange();
  }
}

module.exports = { ClaudeLogin };
