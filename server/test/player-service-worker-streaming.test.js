'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const workerPath = path.join(__dirname, '..', 'player', 'sw.js');

function compileWorker({
  fetchImpl = async () => new Response('network', { status: 200 }),
  cacheEntries = [],
} = {}) {
  const listeners = new Map();
  const cacheMatches = [];
  const context = {
    URL,
    Request,
    Response,
    fetch: fetchImpl,
    caches: {
      match: async (request, options) => {
        cacheMatches.push({ request, options });
        const requestUrl = new URL(request.url);
        const entry = cacheEntries.find(({ url }) => {
          const cachedUrl = new URL(url);
          if (cachedUrl.origin !== requestUrl.origin || cachedUrl.pathname !== requestUrl.pathname) return false;
          return options?.ignoreSearch === true || cachedUrl.search === requestUrl.search;
        });
        return entry ? new Response(entry.body, { status: entry.status || 200 }) : undefined;
      },
      open: async () => ({
        put: async () => {},
      }),
    },
    self: {
      location: { origin: 'https://media.mbfdhub.com' },
      skipWaiting() {},
      clients: { claim() {} },
      addEventListener(type, listener) {
        listeners.set(type, listener);
      },
    },
  };
  vm.runInNewContext(fs.readFileSync(workerPath, 'utf8'), context, {
    filename: workerPath,
  });
  return { listeners, cacheMatches };
}

function isIntercepted(listener, request) {
  let intercepted = false;
  listener({
    request,
    respondWith() {
      intercepted = true;
    },
    waitUntil() {},
  });
  return intercepted;
}

async function fetchThroughWorker(listener, request) {
  let responsePromise = null;
  let completion = Promise.resolve();
  listener({
    request,
    respondWith(response) {
      responsePromise = Promise.resolve(response);
    },
    waitUntil(promise) {
      completion = Promise.resolve(promise);
    },
  });
  assert.ok(responsePromise, `worker did not intercept ${request.url}`);
  const response = await responsePromise;
  await completion;
  return response;
}

test('player worker never intercepts live streams, document pages, media assets, or range requests', () => {
  const fetchListener = compileWorker().listeners.get('fetch');
  const requests = [
    new Request('https://media.mbfdhub.com/player/live-source/guest-computer/index.m3u8'),
    new Request('https://media.mbfdhub.com/player/live-source/guest-computer/segment-42.ts'),
    new Request('https://media.mbfdhub.com/player/live-source/podium-computer/index.m3u8'),
    new Request('https://media.mbfdhub.com/player/live-source/podium-computer/segment-42.ts'),
    new Request('https://media.mbfdhub.com/player/hls-proxy?url=stream'),
    new Request('https://media.mbfdhub.com/player/doc-page/content-id/4.png'),
    new Request('https://media.mbfdhub.com/player/doc-meta/content-id'),
    new Request('https://media.mbfdhub.com/player/doc-pdf/content-id'),
    new Request('https://media.mbfdhub.com/player/canvas-asset/a/b/1920/1080/signature'),
    new Request('https://media.mbfdhub.com/player/asset/content-id'),
    new Request('https://media.mbfdhub.com/player/site-shot/content-id'),
    new Request('https://media.mbfdhub.com/player/device-contract.js', {
      headers: { Range: 'bytes=0-1023' },
    }),
  ];

  for (const request of requests) {
    assert.equal(
      isIntercepted(fetchListener, request),
      false,
      `player service worker must not intercept ${request.url}`,
    );
  }
});

test('player worker still provides network-first offline fallback for its small shell files', () => {
  const fetchListener = compileWorker().listeners.get('fetch');
  const requests = [
    new Request('https://media.mbfdhub.com/player/'),
    new Request('https://media.mbfdhub.com/player/device-contract.js'),
    new Request('https://media.mbfdhub.com/player/doc.html'),
    new Request('https://media.mbfdhub.com/player/live-source.html?source=anpviz'),
    new Request('https://media.mbfdhub.com/player/live-source.html?source=podium-computer'),
    new Request('https://media.mbfdhub.com/player/live-source.html?source=guest-computer'),
    new Request('https://media.mbfdhub.com/socket.io/socket.io.js'),
  ];

  for (const request of requests) {
    assert.equal(
      isIntercepted(fetchListener, request),
      true,
      `player shell should remain offline-capable: ${request.url}`,
    );
  }
});

test('live-source offline fallback never cross-matches Anpviz or Guest legacy shells to Podium', async () => {
  for (const sourceId of ['anpviz', 'guest-computer']) {
    const { listeners, cacheMatches } = compileWorker({
      fetchImpl: async () => { throw new Error('network unavailable'); },
      // These represent entries discovered through global CacheStorage, which
      // includes rollback caches created by prior service-worker versions.
      cacheEntries: [{
        cacheName: 'rd-player-v12',
        url: `https://media.mbfdhub.com/player/live-source.html?source=${sourceId}`,
        body: `${sourceId}-legacy-shell`,
      }],
    });
    const response = await fetchThroughWorker(
      listeners.get('fetch'),
      new Request('https://media.mbfdhub.com/player/live-source.html?source=podium-computer'),
    );

    assert.equal(response.status, 503, `${sourceId} cache entry must not satisfy Podium`);
    assert.equal(await response.text(), 'Offline');
    assert.equal(cacheMatches.length, 1);
    assert.equal(cacheMatches[0].options, undefined, 'managed source matching must preserve query identity');
  }
});

test('live-source offline fallback may use only the exact cached Podium shell', async () => {
  const { listeners, cacheMatches } = compileWorker({
    fetchImpl: async () => { throw new Error('network unavailable'); },
    cacheEntries: [
      {
        cacheName: 'rd-player-v12',
        url: 'https://media.mbfdhub.com/player/live-source.html?source=anpviz',
        body: 'anpviz-legacy-shell',
      },
      {
        cacheName: 'rd-player-v13',
        url: 'https://media.mbfdhub.com/player/live-source.html?source=podium-computer',
        body: 'podium-shell',
      },
    ],
  });
  const response = await fetchThroughWorker(
    listeners.get('fetch'),
    new Request('https://media.mbfdhub.com/player/live-source.html?source=podium-computer'),
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'podium-shell');
  assert.equal(cacheMatches.length, 1);
  assert.equal(cacheMatches[0].options, undefined);
});

test('live-source offline fallback returns deterministic 503 when no exact source shell exists', async () => {
  const { listeners } = compileWorker({
    fetchImpl: async () => { throw new Error('network unavailable'); },
    cacheEntries: [],
  });
  const response = await fetchThroughWorker(
    listeners.get('fetch'),
    new Request('https://media.mbfdhub.com/player/live-source.html?source=podium-computer'),
  );

  assert.equal(response.status, 503);
  assert.equal(response.statusText, 'Service Unavailable');
  assert.equal(await response.text(), 'Offline');
});

test('ordinary static player-shell fallback retains ignoreSearch behavior', async () => {
  const { listeners, cacheMatches } = compileWorker({
    fetchImpl: async () => { throw new Error('network unavailable'); },
    cacheEntries: [{
      cacheName: 'rd-player-v12',
      url: 'https://media.mbfdhub.com/player/device-contract.js?v=legacy',
      body: 'static-shell',
    }],
  });
  const response = await fetchThroughWorker(
    listeners.get('fetch'),
    new Request('https://media.mbfdhub.com/player/device-contract.js?v=current'),
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'static-shell');
  assert.equal(cacheMatches[0].options?.ignoreSearch, true);
});
