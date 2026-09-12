// Aioc Service Worker. Chrome verlangt fuer die Installation als App (Android) einen Service Worker
// mit fetch-Behandlung - ohne ihn gibt es nur eine Verknuepfung, keine installierte PWA.
// Gecacht wird bewusst nichts: die Oberflaeche lebt von der WebSocket-Verbindung zum Daemon, und ein
// Cache wuerde nach einem Update nur alte Staende ausliefern.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => e.respondWith(fetch(e.request)));
