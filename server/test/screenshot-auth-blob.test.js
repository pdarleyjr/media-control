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
  assert.match(server, /app\.get\('\/api\/devices\/:id\/screenshot',\s*rateLimit\(rateLimitOptions\(60000,\s*600\)\)/);
});

test('authenticated screenshot loading uses fetch Blob object URLs', () => {
  const server = read('server', 'server.js');
  const displayState = read('frontend', 'js', 'services', 'display-state.js');
  const mediaControl = read('frontend', 'js', 'views', 'media-control.js');
  const stage = read('frontend', 'js', 'views', 'media-control', 'stage.js');
  assert.match(displayState, /export async function secureScreenshotUrl/);
  assert.match(displayState, /URL\.createObjectURL/);
  assert.match(displayState, /URL\.revokeObjectURL/);
  assert.match(displayState, /Authorization: `Bearer \$\{token\}`/);
  assert.match(displayState, /AbortController/);
  assert.match(server, /if \(!screenshot\)[\s\S]{0,160}status\(204\)[\s\S]{0,80}end\(\)/);
  assert.match(displayState, /res\.status === 204/);
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

test('live-preview iframes use least-privilege (no Feature-Policy allow on passive previews)', () => {
  const live = read('frontend', 'js', 'views', 'media-control', 'live-preview.js');
  // Passive, muted, same-origin dashboard previews must NOT request an overbroad
  // Feature-Policy allow list — that produced Firefox "Skipping unsupported
  // feature name" warnings on every preview iframe. The overbroad constant is
  // gone entirely; presentation/grid/web/youtube frames carry no `allow` attr.
  assert.doesNotMatch(live, /IFRAME_ALLOW/);
  assert.doesNotMatch(live, /allow="accelerometer/);
  assert.doesNotMatch(live, /allow="autoplay; fullscreen"/);
  // Same-origin presentation frames still carry the slide-sync data attr and
  // no permissions; the YouTube/content-library minimal allow lives elsewhere.
  assert.match(live, /data-mc-presentation="1"/);
  assert.match(live, /referrerpolicy="no-referrer"/);
});

test('operator fast state endpoint and UI poll contract', () => {
  const route = read('server', 'routes', 'live-stream.js');
  const api = read('frontend', 'js', 'api.js');
  const dock = read('frontend', 'js', 'views', 'media-control', 'action-dock.js');
  assert.match(route, /router\.get\('\/operator-state'/);
  assert.match(route, /getCameraDirectorState/);
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

test('action-dock always polls live-production status (classroom mode no longer suppresses polling)', () => {
  const dock = read('frontend', 'js', 'views', 'media-control', 'action-dock.js');
  // Still imports the classroom-mode flag for AI-Deck-only nav hiding.
  assert.match(dock, /isClassroomModeEnabled/);
  // The syncLive function does NOT short-circuit on classroomModeActive.
  assert.doesNotMatch(dock, /if \(classroomModeActive\) \{ syncingLive = false; return; \}/);
  // The periodic health timer always starts (capability-driven, not flag-gated).
  assert.match(dock, /syncLive\(\);[\s\S]*?healthTimer = setInterval/);
});

test('stage uses a stable keyed render to avoid iframe recreation storms', () => {
  const stage = read('frontend', 'js', 'views', 'media-control', 'stage.js');
  // A structural signature is computed and the innerHTML rebuild is skipped when
  // it is unchanged, patching labels in place instead.
  assert.match(stage, /function stageRenderSignature/);
  assert.match(stage, /sig === container\._mcRenderSig/);
  assert.match(stage, /function updateStageInPlace/);
  // Instrumentation for soak verification is exposed.
  assert.match(stage, /bumpStageMetric/);
  assert.match(stage, /iframeCreates/);
  assert.match(stage, /iframeRemoves/);
});
