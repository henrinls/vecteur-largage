// Service worker : appli disponible hors-ligne + images satellite en cache.
const APP_CACHE = 'vl-app-v0.26.0';
const TILE_CACHE = 'vl-tiles-v1';
const APP_FILES = ['./', 'index.html', 'style.css', 'geo.js', 'undo.js', 'clubs.js', 'wmm.js', 'lpmove.js', 'app.js', 'showmenu.js', 'photo.js', 'windpick.js', 'pdfview.js', 'vendor/pdfjs/pdf.min.js', 'vendor/pdfjs/pdf.worker.min.js', 'manifest.webmanifest',
  'icon-192.png', 'icon-512.png', 'vendor/leaflet.js', 'vendor/leaflet-rotate.js', 'vendor/leaflet.css', 'vendor/jspdf.umd.min.js',
  'vendor/images/marker-icon.png', 'vendor/images/marker-icon-2x.png', 'vendor/images/marker-shadow.png',
  'vendor/images/layers.png', 'vendor/images/layers-2x.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(APP_CACHE).then(c => c.addAll(APP_FILES.map(f => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(k => k.startsWith('vl-app-') && k !== APP_CACHE).map(k => caches.delete(k))
  )).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.hostname === 'server.arcgisonline.com' || url.hostname === 'data.geopf.fr') {
    // Images satellite : cache d'abord, sinon réseau (et mise en cache)
    e.respondWith(caches.open(TILE_CACHE).then(async c => {
      const hit = await c.match(e.request.url);
      if (hit) return hit;
      try {
        const r = await fetch(e.request);
        if (r.ok || r.type === 'opaque') c.put(e.request.url, r.clone());
        return r;
      } catch (err) { return new Response('', { status: 504 }); }
    }));
    return;
  }
  if (url.origin === location.origin) {
    // Appli : réseau d'abord (pour recevoir les mises à jour), cache si pas de réseau
    // cache: 'no-cache' : on revalide toujours auprès du serveur (GitHub Pages met 10 min de cache navigateur)
    const net = Promise.race([fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' }), new Promise((_, rej) => setTimeout(() => rej(new Error('lent')), 3500))]);
    e.respondWith(net.then(r => {
      const copy = r.clone(); caches.open(APP_CACHE).then(c => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
  }
});
