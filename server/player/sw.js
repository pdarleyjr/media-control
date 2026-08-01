const CACHE_NAME = 'rd-player-v12';

// Install: skip waiting to activate immediately
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

// Activate: claim clients immediately so the new SW takes over on next
// navigation. Keep prior shell caches as a rollback/offline fallback.
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

function isPlayerShellRequest(request) {
  if (!request || request.method !== 'GET') return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  if (request.headers && request.headers.has('range')) return false;
  if (url.pathname === '/socket.io/socket.io.js') return true;
  if (url.pathname === '/player' || url.pathname === '/player/') return true;
  // Cache only one-segment, static player shell files. Dynamic presentation,
  // document, screenshot, asset, HLS, and camera paths have deeper routes or
  // no static extension and must stay on the browser's native fetch path.
  return /^\/player\/[^/]+\.(?:html|js|css|json|webmanifest|svg|png|ico)$/.test(url.pathname);
}

function playerNetworkFirst(event) {
  let cacheUpdate = Promise.resolve();
  const responsePromise = fetch(event.request)
    .then((response) => {
      if (response.ok && response.type !== 'opaque') {
        cacheUpdate = caches.open(CACHE_NAME)
          .then(cache => cache.put(event.request, response.clone()))
          .catch(() => {});
      }
      return response;
    })
    .catch(async () => {
      const cached = await caches.match(event.request, { ignoreSearch: true }).catch(() => null);
      return cached || new Response('Offline', {
        status: 503,
        statusText: 'Service Unavailable',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    });
  if (typeof event.waitUntil === 'function') {
    event.waitUntil(responsePromise.then(() => cacheUpdate).catch(() => {}));
  }
  return responsePromise;
}

// Fetch handler — cache only the small player shell. Content responses rely on
// their server Cache-Control headers and native browser range/media handling.
self.addEventListener('fetch', (event) => {
  if (!isPlayerShellRequest(event.request)) return;
  event.respondWith(playerNetworkFirst(event));
});
