'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const workerPath = path.join(__dirname, '..', 'player', 'sw.js');

function compileWorker() {
  const listeners = new Map();
  const context = {
    URL,
    Request,
    Response,
    fetch: async () => new Response('network', { status: 200 }),
    caches: {
      match: async () => undefined,
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
  return listeners;
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

test('player worker never intercepts live streams, document pages, media assets, or range requests', () => {
  const fetchListener = compileWorker().get('fetch');
  const requests = [
    new Request('https://media.mbfdhub.com/player/live-source/guest-computer/index.m3u8'),
    new Request('https://media.mbfdhub.com/player/live-source/guest-computer/segment-42.ts'),
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
  const fetchListener = compileWorker().get('fetch');
  const requests = [
    new Request('https://media.mbfdhub.com/player/'),
    new Request('https://media.mbfdhub.com/player/device-contract.js'),
    new Request('https://media.mbfdhub.com/player/doc.html'),
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
