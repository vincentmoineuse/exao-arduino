/* Service worker : garde l'appli en mémoire pour qu'elle fonctionne sans réseau.
   En ligne : on charge la dernière version (délai max 4 s), sinon on sert la copie gardée.
   Après une modification des fichiers, augmenter VERSION. */
const VERSION = 'exao-v1';
const FICHIERS = [
  './', './index.html', './app.js', './app.css', './serial-polyfill.js', './manifest.webmanifest',
  './vitesse_son.html', './icones/icone-192.png', './icones/icone-512.png', './icones/icone-maskable-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FICHIERS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(k => Promise.all(k.filter(n => n !== VERSION).map(n => caches.delete(n))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    try {
      const rep = await Promise.race([
        fetch(e.request),
        new Promise((_, rej) => setTimeout(() => rej(new Error('délai')), 4000))
      ]);
      if (rep && rep.ok) cache.put(e.request, rep.clone());
      return rep;
    } catch (err) {
      return (await cache.match(e.request, { ignoreSearch: true })) || (await cache.match('./index.html')) || Response.error();
    }
  })());
});
