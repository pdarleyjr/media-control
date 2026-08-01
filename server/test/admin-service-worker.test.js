'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const workerPath = path.join(__dirname, '..', '..', 'frontend', 'sw-admin.js');

function compileWorker({ fetchImpl, cacheMatch } = {}) {
  const listeners = new Map();
  const cacheWrites = [];
  const context = {
    URL,
    Request,
    Response,
    Headers,
    fetch: fetchImpl || (() => Promise.reject(new TypeError('offline'))),
    caches: {
      keys: async () => [],
      delete: async () => true,
      match: cacheMatch || (async () => undefined),
      open: async () => ({
        put: async (request, response) => {
          cacheWrites.push({ request, response });
        },
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
  return { listeners, cacheWrites };
}

function dispatchFetch(listener, request) {
  let responsePromise;
  let responded = false;
  const lifetime = [];
  listener({
    request,
    respondWith(value) {
      responded = true;
      responsePromise = Promise.resolve(value);
    },
    waitUntil(value) {
      lifetime.push(Promise.resolve(value));
    },
  });
  return {
    responded,
    response: () => responsePromise,
    lifetimeCount: () => lifetime.length,
    lifetime: () => Promise.all(lifetime),
  };
}

test('offline admin navigation always resolves to a real Response on a cache miss', async () => {
  const { listeners } = compileWorker();
  const event = dispatchFetch(
    listeners.get('fetch'),
    new Request('https://media.mbfdhub.com/app#/control', {
      headers: { Accept: 'text/html' },
    }),
  );

  assert.equal(event.responded, true);
  const response = await event.response();
  assert.ok(response instanceof Response, 'respondWith must never resolve undefined');
  assert.equal(response.status, 503);
  assert.match(response.headers.get('content-type') || '', /text\/html/);
});

test('admin worker bypasses content, streaming, range, player, API, and cross-origin requests', () => {
  const { listeners } = compileWorker();
  const fetchListener = listeners.get('fetch');
  const requests = [
    new Request('https://media.mbfdhub.com/content/large-presentation-video.mp4'),
    new Request('https://media.mbfdhub.com/uploads/clip.webm'),
    new Request('https://media.mbfdhub.com/player/'),
    new Request('https://media.mbfdhub.com/api/displays'),
    new Request('https://media.mbfdhub.com/socket.io/?EIO=4'),
    new Request('https://media.mbfdhub.com/js/app.js', {
      headers: { Range: 'bytes=0-1023' },
    }),
    new Request('https://cdn.example.test/media/segment.m4s'),
  ];

  for (const request of requests) {
    const event = dispatchFetch(fetchListener, request);
    assert.equal(
      event.responded,
      false,
      `service worker must not intercept ${request.url}`,
    );
  }
});

test('admin static assets remain network-first and use a cached Response only offline', async () => {
  const cached = new Response('cached-app', {
    status: 200,
    headers: { 'Content-Type': 'application/javascript' },
  });
  const { listeners } = compileWorker({
    cacheMatch: async () => cached.clone(),
  });
  const event = dispatchFetch(
    listeners.get('fetch'),
    new Request('https://media.mbfdhub.com/js/app.js'),
  );

  assert.equal(event.responded, true);
  const response = await event.response();
  assert.ok(response instanceof Response);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'cached-app');
});

test('cache persistence extends the FetchEvent lifetime synchronously without delaying the response contract', async () => {
  const { listeners, cacheWrites } = compileWorker({
    fetchImpl: async () => new Response('fresh-app', { status: 200 }),
  });
  const event = dispatchFetch(
    listeners.get('fetch'),
    new Request('https://media.mbfdhub.com/js/app.js'),
  );

  assert.equal(event.responded, true);
  assert.equal(
    event.lifetimeCount(),
    1,
    'waitUntil must be registered before the fetch listener returns',
  );
  assert.equal(await (await event.response()).text(), 'fresh-app');
  await event.lifetime();
  assert.equal(cacheWrites.length, 1);
});
