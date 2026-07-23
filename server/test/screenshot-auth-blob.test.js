'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

function read(...parts) {
  return fs.readFileSync(path.join(__dirname, '..', '..', ...parts), 'utf8');
}

test('screenshot route accepts Bearer and httpOnly cookie, never query tokens', () => {
  const server = read('server', 'server.js');
  assert.match(server, /function extractScreenshotToken/);
  assert.match(server, /cookies\.mc_token/);
  assert.match(server, /Bearer /);
  assert.doesNotMatch(server, /const tokenParam = req\.query\.token/);
  assert.match(server, /Query-string tokens are rejected|never[\s\S]*URLs/i);
});

test('authenticated screenshot loading uses fetch Blob object URLs', () => {
  const displayState = read('frontend', 'js', 'services', 'display-state.js');
  const mediaControl = read('frontend', 'js', 'views', 'media-control.js');
  const stage = read('frontend', 'js', 'views', 'media-control', 'stage.js');
  assert.match(displayState, /export async function secureScreenshotUrl/);
  assert.match(displayState, /URL\.createObjectURL/);
  assert.match(displayState, /URL\.revokeObjectURL/);
  assert.match(displayState, /Authorization: `Bearer \$\{token\}`/);
  assert.match(displayState, /AbortController/);
  assert.match(mediaControl, /displayState\.secureScreenshotUrl/);
  assert.match(stage, /data-mc-shot-api/);
  assert.match(stage, /function shotImg/);
});

test('screenshot poller dedupes, backoff, teardown, and pauses when hidden', () => {
  const poll = read('frontend', 'js', 'services', 'screenshot-poll.js');
  assert.match(poll, /inFlight\.has\(id\)/);
  assert.match(poll, /document\.hidden/);
  assert.match(poll, /visibilitychange/);
  assert.match(poll, /function stop\(\)/);
  assert.match(poll, /maxBackoffMs/);
  assert.match(poll, /getScreenshotPollMetrics/);
});

test('Firefox shared stylesheet has no webkit-scrollbar selectors', () => {
  const css = read('frontend', 'css', 'main.css');
  assert.doesNotMatch(css, /::-webkit-scrollbar/);
  assert.doesNotMatch(css, /@supports selector\(::-webkit-scrollbar\)/);
  assert.match(css, /scrollbar-width:\s*thin/);
  assert.match(css, /scrollbar-color:/);
});

test('live-preview iframe allow list is modern and not bare autoplay', () => {
  const live = read('frontend', 'js', 'views', 'media-control', 'live-preview.js');
  assert.match(live, /const IFRAME_ALLOW/);
  assert.match(live, /encrypted-media/);
  assert.match(live, /picture-in-picture/);
  assert.doesNotMatch(live, /allow="autoplay; fullscreen"/);
});

test('operator fast state endpoint and UI poll contract', () => {
  const route = read('server', 'routes', 'live-stream.js');
  const api = read('frontend', 'js', 'api.js');
  const dock = read('frontend', 'js', 'views', 'media-control', 'action-dock.js');
  assert.match(route, /router\.get\('\/operator-state'/);
  assert.match(route, /callDirector\('GET', '\/director\/state'\)/);
  assert.match(route, /deepHealthCache|cacheDeepHealth/);
  assert.match(api, /operatorState: \(\) => request\('\/live-stream\/operator-state'/);
  assert.match(dock, /api\.liveStream\.operatorState\(\)/);
  // Deep status remains available for diagnostics; UI fast path does not block on it.
  assert.match(route, /router\.get\('\/status'/);
});

test('requestScreenshot production spam is diagnostics-gated', () => {
  const socket = read('frontend', 'js', 'socket.js');
  assert.match(socket, /localStorage\.getItem\('mc_diag'\) === '1'/);
  assert.doesNotMatch(socket, /export function requestScreenshot\(deviceId\) \{\s*console\.log/);
});

test('tus vendor drops missing source map directive', () => {
  const tus = read('frontend', 'js', 'vendor', 'tus.min.js');
  assert.doesNotMatch(tus, /sourceMappingURL=tus\.min\.js\.map/);
});

test('applyTileSize defers layout measurement', () => {
  const stage = read('frontend', 'js', 'views', 'media-control', 'stage.js');
  assert.match(stage, /requestAnimationFrame/);
  assert.match(stage, /function applyTileSize/);
});
