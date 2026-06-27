const CACHE_NAME = 'rd-player-v11';

// Install: skip waiting to activate immediately
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

// Activate: claim clients immediately so the new SW takes over on next
// navigation. Do NOT delete old caches — the network-first fallback needs
// them. When the Cloudflare tunnel is slow/unreliable (which it is for the
// classroom displays), the SW falls back to cache. If we deleted the old
// cache on activation, the first reload after a SW bump would have NO cache
// to fall back to, causing 503s that break the player's JS (no socket
// connection, no content, blank wall). Keeping old caches means the fallback
// always has SOMETHING to serve. New responses are written to CACHE_NAME
// (v10), overwriting stale entries incrementally.
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Fetch handler — ONLY cache player page and static assets.
// Content files (/uploads/content/) are NOT intercepted — the server sets
// Cache-Control: public, max-age=2592000, immutable which lets the browser
// cache them natively without SW complications (range requests, opaque
// responses, video seeking, etc.)
self.addEventListener('fetch', (event) => {
  // Only handle GET requests
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Player page and static assets: network-first, fall back to cache
  if (url.pathname.startsWith('/player') || url.pathname === '/socket.io/socket.io.js') {
    event.respondWith(
      fetch(event.request).then(response => {
        if (response.ok && response.type !== 'opaque') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() =>
        caches.match(event.request, { ignoreSearch: true }).then(cached =>
          cached || new Response('Offline', {
            status: 503,
            statusText: 'Service Unavailable',
            headers: { 'Content-Type': 'text/plain' }
          })
        )
      )
    );
    return;
  }

  // Everything else (content files, API calls, etc.): don't intercept.
  // Returning without event.respondWith lets the browser handle it natively.
});
