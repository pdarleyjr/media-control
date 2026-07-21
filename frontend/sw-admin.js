// Service worker for the admin SPA. Bumped to v2 to invalidate the cache-first
// caches that were shipping stale JS to existing clients (the server already
// sends Cache-Control: no-cache + ETag, but the previous SW intercepted before
// any of that mattered). Strategy is now network-first with offline fallback.
const CACHE = 'rd-admin-v2';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll([
    '/', '/index.html', '/css/variables.css', '/css/reset.css', '/css/main.css',
    '/js/app.js', '/js/api.js', '/js/socket.js', '/js/i18n.js',
    '/js/components/toast.js'
  ])));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Don't intercept API or socket.io traffic - those need to hit the network unmediated.
  if (e.request.url.includes('/api/') || e.request.url.includes('/socket.io/')) return;
  // Network-first: respect the server's Cache-Control: no-cache + ETag (304s
  // stay fast); fall back to cache only when offline. Re-populate the cache
  // on every successful fetch so the offline fallback stays current.
  e.respondWith(
    fetch(e.request)
      .then(resp => {
        const copy = resp.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return resp;
      })
      .catch(() => caches.match(e.request))
  );
});
