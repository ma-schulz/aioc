// Selbst erzeugtes TLS-Zertifikat fuer den LAN-Listener (einmalig unter ~/.aioc/tls, 10 Jahre).
// Der Fingerprint (sha256 ueber DER, base64) wandert in den Verbindungslink; aioc-remote.cmd pinnt
// darauf statt einer Zertifikatswarnung.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const state = require('./state');

const TLS_DIR = path.join(state.DIR, 'tls');

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

function fingerprintOf(certPem) {
  const x = new crypto.X509Certificate(certPem);
  return crypto.createHash('sha256').update(x.raw).digest('base64');
}

// Echtes Zertifikat, falls vorhanden: ein Paar <name>.crt/<name>.key im TLS-Ordner, wie es
// `tailscale cert <name>.ts.net` dort ablegt. Dann ist der Name oeffentlich vertrauenswuerdig -
// der Verbindungslink braucht keinen Fingerprint mehr, und Chrome laesst auf Android die
// Installation als App zu (ueber ein selbstsigniertes Zertifikat verweigert er sie).
// Erneuern: `tailscale cert` erneut laufen lassen (Laufzeit ~90 Tage), danach LAN aus und wieder an.
function trustedCert() {
  let files = [];
  try { files = fs.readdirSync(TLS_DIR); } catch { return null; }
  for (const crtFile of files.filter(f => f.endsWith('.crt'))) {
    const host = crtFile.slice(0, -4);
    const keyFile = path.join(TLS_DIR, host + '.key');
    if (!fs.existsSync(keyFile)) continue;
    try {
      const cert = fs.readFileSync(path.join(TLS_DIR, crtFile), 'utf8');
      const key = fs.readFileSync(keyFile, 'utf8');
      const x = new crypto.X509Certificate(cert);
      if (new Date(x.validTo) < new Date()) {
        console.log(`[aioc] Zertifikat ${crtFile} ist abgelaufen (${x.validTo}) - bitte "tailscale cert ${host}" erneut ausfuehren`);
        continue;
      }
      return { key, cert, fp: fingerprintOf(cert), host, trusted: true, validTo: x.validTo };
    } catch (err) {
      console.log(`[aioc] Zertifikat ${crtFile} nicht lesbar: ${err.message}`);
    }
  }
  return null;
}

async function ensureCert() {
  fs.mkdirSync(TLS_DIR, { recursive: true });
  const trusted = trustedCert();
  if (trusted) return trusted;
  const keyFile = path.join(TLS_DIR, 'key.pem');
  const certFile = path.join(TLS_DIR, 'cert.pem');
  if (fs.existsSync(keyFile) && fs.existsSync(certFile)) {
    const cert = fs.readFileSync(certFile, 'utf8');
    return { key: fs.readFileSync(keyFile, 'utf8'), cert, fp: fingerprintOf(cert) };
  }
  const selfsigned = require('selfsigned');
  const altNames = [
    { type: 2, value: os.hostname() },
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    ...lanAddresses().map(ip => ({ type: 7, ip })),
  ];
  const pems = await selfsigned.generate(
    [{ name: 'commonName', value: 'Aioc ' + os.hostname() }],
    { days: 3650, keySize: 2048, algorithm: 'sha256', extensions: [{ name: 'subjectAltName', altNames }] }
  );
  fs.writeFileSync(keyFile, pems.private);
  fs.writeFileSync(certFile, pems.cert);
  return { key: pems.private, cert: pems.cert, fp: fingerprintOf(pems.cert) };
}

module.exports = { ensureCert, lanAddresses, fingerprintOf };
