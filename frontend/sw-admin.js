// Service worker for the admin SPA. Stable JS module names must always be
// network-first; the cache is only an offline fallback.
const CACHE = 'rd-admin-v3';

self.addEventListener('install', () => {
  // Do not make activation depend on a precache batch. One unavailable asset
  // used to strand clients on the old worker and a blank dashboard.
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // Don't intercept API or socket.io traffic - those need to hit the network unmediated.
  if (e.request.url.includes('/api/') || e.request.url.includes('/socket.io/')) return;
  // Network-first: respect the server's Cache-Control: no-cache + ETag (304s
  // stay fast); fall back to cache only when offline. Re-populate the cache
  // on every successful fetch so the offline fallback stays current.
  e.respondWith(
    fetch(e.request)
      .then(resp => {
        if (resp.ok && resp.type !== 'opaque') {
          const copy = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        }
        return resp;
      })
      .catch(() => caches.match(e.request))
  );
});
