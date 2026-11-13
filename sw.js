/* Service worker : l'app et les cartes fonctionnent sans réseau sur le parcours. */
const VERSION = 'golf-v1.0.0';
const SHELL = ['./', 'index.html', 'app.css', 'manifest.webmanifest', 'lib/leaflet.js', 'lib/leaflet.css',
  'js/store.js', 'js/geo.js', 'js/osm.js', 'js/app.js', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== 'tiles').map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Tuiles satellite : cache d'abord, réseau sinon (et on garde la tuile).
  if (url.hostname.endsWith('arcgisonline.com')) {
    e.respondWith(caches.open('tiles').then(async c => {
      const hit = await c.match(req.url);
      if (hit) return hit;
      try { const r = await fetch(req); c.put(req.url, r.clone()); return r; } catch (err) { return new Response('', { status: 504 }); }
    }));
    return;
  }
  if (url.origin !== location.origin) return; // OpenStreetMap : réseau uniquement
  // Fichiers de l'app : réponse immédiate depuis le cache, mise à jour en arrière-plan.
  e.respondWith(caches.open(VERSION).then(async c => {
    const hit = await c.match(req, { ignoreSearch: true });
    const net = fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => null);
    return hit || (await net) || c.match('index.html');
  }));
});
