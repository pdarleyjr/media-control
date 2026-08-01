// Service worker for the admin SPA. Stable JS module names must always be
// network-first; the cache is only an offline fallback.
const CACHE = 'rd-admin-v5';
const ADMIN_STATIC_PREFIXES = Object.freeze([
  '/js/',
  '/css/',
  '/assets/',
  '/icons/',
  '/locales/',
]);
const ADMIN_STATIC_FILES = new Set([
  '/favicon.ico',
  '/manifest.json',
  '/site.webmanifest',
  '/sw-admin.js',
]);

self.addEventListener('install', () => {
  // Do not make activation depend on a precache batch. One unavailable asset
  // used to strand clients on the old worker and a blank dashboard.
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  // Never delete player/offline caches or caches owned by another application
  // on the same origin. This worker owns only the rd-admin-* namespace.
  e.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(k => /^rd-admin-/.test(k) && k !== CACHE).map(k => caches.delete(k))
  )));
  self.clients.claim();
});

function shouldHandleAdminRequest(request) {
  if (!request || request.method !== 'GET') return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  if (request.headers && request.headers.has('range')) return false;
  if (url.pathname.includes('/api/') || url.pathname.includes('/socket.io/')) return false;
  if (url.pathname === '/app' || url.pathname === '/app/') return true;
  if (ADMIN_STATIC_FILES.has(url.pathname)) return true;
  return ADMIN_STATIC_PREFIXES.some(prefix => url.pathname.startsWith(prefix));
}

function offlineResponse(request) {
  const acceptsHtml = request.mode === 'navigate'
    || String(request.headers?.get('accept') || '').includes('text/html');
  if (acceptsHtml) {
    return new Response(
      '<!doctype html><meta charset="utf-8"><title>Media Control offline</title>'
        + '<main><h1>Media Control is temporarily offline</h1>'
        + '<p>Check the network connection, then reload this page.</p></main>',
      {
        status: 503,
        statusText: 'Service Unavailable',
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      },
    );
  }
  return new Response('Offline', {
    status: 503,
    statusText: 'Service Unavailable',
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function networkFirst(event) {
  let cacheUpdate = Promise.resolve();
  const responsePromise = fetch(event.request)
    .then((response) => {
      if (response.ok && response.type !== 'opaque') {
        cacheUpdate = caches.open(CACHE)
          .then(cache => cache.put(event.request, response.clone()))
          .catch(() => {});
      }
      return response;
    })
    .catch(async () => {
      const cached = await caches.match(event.request).catch(() => null);
      return cached || offlineResponse(event.request);
    });
  if (typeof event.waitUntil === 'function') {
    // Register synchronously while the ExtendableEvent is active. The cache
    // write continues after the network Response is handed to the page.
    event.waitUntil(responsePromise.then(() => cacheUpdate).catch(() => {}));
  }
  return responsePromise;
}

self.addEventListener('fetch', e => {
  // Media, content, preview/player, range, API, socket, and cross-origin traffic
  // must flow directly through the browser. Cloning those streams into Cache
  // Storage stalls video previews and can retain very large responses.
  if (!shouldHandleAdminRequest(e.request)) return;
  // Network-first for the small dashboard shell only. A cache miss while
  // offline always resolves to a real Response; respondWith must never receive
  // undefined.
  e.respondWith(networkFirst(e));
});
