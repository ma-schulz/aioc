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

async function ensureCert() {
  fs.mkdirSync(TLS_DIR, { recursive: true });
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
