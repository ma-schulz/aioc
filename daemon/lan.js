// LAN-Hilfen: Verbindungslinks bauen; als CLI schaltet `node daemon/lan.js on|off|status` das
// persistente LAN-Flag (wirkt beim naechsten Daemon-Start oder sofort ueber den Schalter im Fenster).
const state = require('./state');
const { lanAddresses } = require('./tls');

// Echte LAN-Adressen zuerst (192.168.x, 10.x), virtuelle Adapter (WSL/Hyper-V, meist 172.x) danach
function rank(ip) { return ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2; }

// Link ohne '&' und '%': der Fingerprint steht URL-sicher (base64url) im Fragment, damit der Link
// auch unquotiert in cmd/PowerShell heil bleibt ('&' wuerde ihn sonst zerschneiden).
function lanLinks(info, fp) {
  const port = info.lanPort || 43443;
  const fpUrl = fp.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return lanAddresses()
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map(ip => `https://${ip}:${port}/?token=${info.token}#fp=${fpUrl}`);
}

if (require.main === module) {
  const cmd = process.argv[2];
  const info = state.loadDaemonInfo();
  if (cmd === 'on' || cmd === 'off') {
    info.lan = cmd === 'on';
    state.saveDaemonInfo(info);
    console.log(`LAN-Zugriff ${info.lan ? 'EIN' : 'AUS'} gespeichert – wirkt beim nächsten Daemon-Start (im laufenden Fenster: Schalter in der Titelleiste).`);
  } else {
    console.log(`LAN-Zugriff: ${info.lan ? 'EIN' : 'AUS'} · HTTPS-Port ${info.lanPort || 43443} · Adressen: ${lanAddresses().join(', ') || '-'}`);
  }
}

module.exports = { lanLinks };
