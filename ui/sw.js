// Aioc Service Worker. Chrome verlangt fuer die Installation als App (Android) lediglich, dass ein
// fetch-Handler vorhanden ist - er darf nichts tun. Deshalb ist dieser hier bewusst ein Leerlauf:
// kein respondWith, kein Cache. Der Browser laedt alles genau wie ohne ihn.
//
// Ebenso bewusst OHNE skipWaiting/clients.claim: ein Service Worker, der die Seite mitten im ersten
// Laden uebernimmt, kann bereits laufende Anfragen (z. B. /vendor/xterm.css) ins Leere laufen lassen.
// Dann fehlen Schrift, Farben und Layout - einmalig und nur beim allerersten Fensterstart.
// So wird er erst beim naechsten Laden zustaendig, wo nichts mehr in der Luft haengt.
self.addEventListener('install', () => {});
self.addEventListener('activate', () => {});
self.addEventListener('fetch', () => {});
