// Aioc Service Worker. Zwei Aufgaben:
//
// 1. Installierbarkeit: Chrome verlangt fuer die Installation als App (Android) lediglich, dass ein
//    fetch-Handler vorhanden ist - er darf nichts tun. Deshalb ist er bewusst ein Leerlauf: kein
//    respondWith, kein Cache. Der Browser laedt alles genau wie ohne ihn.
// 2. Benachrichtigungen auf dem Handy: Chrome auf Android verbietet `new Notification()` in der Seite,
//    dort zeigt die Seite Meldungen ueber registration.showNotification() - der Klick darauf landet hier.
//
// Ebenso bewusst OHNE skipWaiting/clients.claim: ein Service Worker, der die Seite mitten im ersten
// Laden uebernimmt, kann bereits laufende Anfragen (z. B. /vendor/xterm.css) ins Leere laufen lassen.
// Dann fehlen Schrift, Farben und Layout - einmalig und nur beim allerersten Fensterstart.
// So wird er erst beim naechsten Laden zustaendig, wo nichts mehr in der Luft haengt. Eine neue
// Fassung dieser Datei gilt deshalb erst, wenn alle Aioc-Fenster einmal geschlossen waren.
self.addEventListener('install', () => {});
self.addEventListener('activate', () => {});
self.addEventListener('fetch', () => {});

// Klick auf eine Meldung: laufendes Aioc nach vorn holen und die Session dort oeffnen, sonst Aioc mit
// dieser Session starten (das Token liegt im localStorage der Seite, die URL braucht keins).
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const id = event.notification.data && event.notification.data.id;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find(w => w.focused) || wins.find(w => w.visibilityState === 'visible') || wins[0];
    if (!win) {
      await self.clients.openWindow('/' + (id ? '?open=' + encodeURIComponent(id) : ''));
      return;
    }
    if (id) win.postMessage({ t: 'open', id }); // vor focus(): das kann der Browser ablehnen
    await win.focus().catch(() => {});
  })());
});
