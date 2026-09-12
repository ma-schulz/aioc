// Bettet die Agenten-Symbole dieses Ordners als data:-URIs in ui/style.css ein (Block zwischen den
// Markern). Grund: style.css liefert jeder Daemon aus, eigene Dateien unter /agents/ dagegen nur ein
// Daemon, der diese Routen schon kennt. Nach einem Oberflaechen-Update ohne Daemon-Neustart - der
// laufende Sessions beenden wuerde - waeren die Symbole sonst kaputte Bildverweise.
// Nach Aenderungen an den Dateien hier: node ui/agents/embed.js
const fs = require('fs');
const path = require('path');

const CSS = path.join(__dirname, '..', 'style.css');
const BEGIN = '/* agent-icons:begin - erzeugt von ui/agents/embed.js, nicht von Hand aendern */';
const END = '/* agent-icons:end */';
const FILES = [
  ['claude', 'claude.svg', 'image/svg+xml'],
  ['codex', 'codex.svg', 'image/svg+xml'],
  ['pi', 'pi.svg', 'image/svg+xml'],
  ['pwsh', 'pwsh.png', 'image/png'],
];

const rules = FILES.map(([agent, file, mime]) => {
  const b64 = fs.readFileSync(path.join(__dirname, file)).toString('base64');
  return `.agi-${agent} { background-image: url("data:${mime};base64,${b64}"); }`;
});
let css = fs.readFileSync(CSS, 'utf8');
const eol = css.includes('\r\n') ? '\r\n' : '\n'; // Zeilenende der Datei uebernehmen, sonst entsteht ein Mix
const block = [BEGIN, ...rules, END].join(eol);
const a = css.indexOf('/* agent-icons:begin');
const b = css.indexOf(END);
css = a >= 0 && b > a
  ? css.slice(0, a) + block + css.slice(b + END.length)
  : css.replace(/\s*$/, eol) + block + eol; // Block steht am Ende, damit er nach der .agi-Grundregel greift
fs.writeFileSync(CSS, css.replace(/\r?\n/g, eol));
console.log(`style.css: ${rules.length} Agenten-Symbole eingebettet (${rules.reduce((n, r) => n + r.length, 0)} Zeichen)`);
