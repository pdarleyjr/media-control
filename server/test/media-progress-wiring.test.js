'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const serverRoot = path.join(__dirname, '..');

test('player and HLS paths report bounded software progress through the existing state-report path', () => {
  const rootPlayer = fs.readFileSync(path.join(serverRoot, 'player', 'index.html'), 'utf8');
  const hlsPlayer = fs.readFileSync(path.join(serverRoot, 'player', 'hls.html'), 'utf8');
  const deviceSocket = fs.readFileSync(path.join(serverRoot, 'ws', 'deviceSocket.js'), 'utf8');

  assert.match(rootPlayer, /\/player\/media-progress\.js/);
  assert.match(rootPlayer, /createMediaProgressTracker/);
  assert.match(rootPlayer, /readDecodedFrames\(video\)/);
  assert.match(rootPlayer, /publishPlayerState\(\{ state \}\)/);
  assert.match(hlsPlayer, /media-progress\.js/);
  assert.match(hlsPlayer, /Hls\.Events\.ERROR/);
  assert.match(hlsPlayer, /window\.__mcGetTransportState = playbackState/);
  assert.doesNotMatch(hlsPlayer, /setInterval\(function \(\) \{ notifyParent\('__mc_transport_state', playbackState\(\)\); \}, 15000\)/);
  assert.match(rootPlayer, /__mcGetTransportState/);
  assert.match(deviceSocket, /state\.render_telemetry/);
  assert.match(deviceSocket, /rendererProgress\.record/);
  assert.match(deviceSocket, /rendererProgress\.clear/);
  assert.doesNotMatch(deviceSocket, /INSERT INTO .*render_progress/i);
});

test('the schema stays unchanged: progress is not a migration or a per-frame database write', () => {
  const schema = fs.readFileSync(path.join(serverRoot, 'db', 'schema.sql'), 'utf8');
  const progressService = fs.readFileSync(path.join(serverRoot, 'services', 'renderer-progress.js'), 'utf8');
  assert.doesNotMatch(schema, /last_media_progress_at|decoded_frame_progress|render_progress/i);
  assert.match(progressService, /maxEntries: 50/);
  assert.doesNotMatch(progressService, /db\.prepare|INSERT|UPDATE/i);
});

test('fatal HLS callbacks protect recovery before hostile telemetry getters are inspected', async () => {
  const hlsPage = fs.readFileSync(path.join(serverRoot, 'player', 'hls.html'), 'utf8');
  const inlineScript = hlsPage.match(/<script>\s*([\s\S]*?)\s*<\/script>\s*<\/body>/)[1];
  const posted = [];
  const timers = [];
  const listeners = new Map();
  const videoListeners = new Map();
  const video = {
    duration: Number.NaN,
    currentTime: 0,
    paused: false,
    ended: false,
    readyState: 4,
    muted: true,
    volume: 1,
    style: {},
    seekable: { length: 0 },
    addEventListener(type, callback) { videoListeners.set(type, callback); },
    canPlayType() { return ''; },
    play() { return Promise.resolve(); },
    pause() {},
    removeAttribute() {},
  };
  const elements = {
    cam: video,
    state: { classList: { toggle() {} } },
    statetext: { textContent: '' },
    label: { hidden: true },
    labeltext: { textContent: '' },
  };
  let hlsInstance;
  function Hls() { this.handlers = new Map(); hlsInstance = this; }
  Hls.isSupported = () => true;
  Hls.Events = { MANIFEST_PARSED: 'manifest', ERROR: 'error' };
  Hls.prototype.loadSource = function () {};
  Hls.prototype.attachMedia = function () {};
  Hls.prototype.destroy = function () {};
  Hls.prototype.on = function (event, callback) { this.handlers.set(event, callback); };
  const context = {
    URLSearchParams,
    Date,
    Math,
    crypto: { randomUUID: () => 'test-renderer-session' },
    Number,
    Promise,
    encodeURIComponent,
    location: { search: '?station=city', origin: 'https://example.test' },
    parent: { postMessage(message) { posted.push(message); } },
    document: {
      hidden: false,
      getElementById(id) { return elements[id]; },
      addEventListener(type, callback) { listeners.set(type, callback); },
    },
    addEventListener(type, callback) { listeners.set(type, callback); },
    setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; },
    clearTimeout() {},
    setInterval(callback, delay) { timers.push({ callback, delay, interval: true }); return timers.length; },
    clearInterval() {},
    fetch() { return Promise.resolve({ ok: true, json: () => Promise.resolve({ source: 'https://stream.test/live.m3u8' }) }); },
    Hls,
    MbfdMediaProgress: {
      createMediaProgressTracker() { return null; },
      normalizePlaybackError() { throw new Error('normalizer fault'); },
    },
    MbfdDeviceContract: { normalizeCommand() { return { ok: false, error: 'unused' }; } },
  };
  context.window = context;
  vm.runInNewContext(inlineScript, context, { filename: 'hls.html' });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(hlsInstance, 'the HLS page should attach after stream resolution');
  const hostileEvents = [
    Object.defineProperties({}, {
      fatal: { get: () => true },
      type: { get() { throw new Error('type getter'); } },
    }),
    Object.defineProperties({}, {
      fatal: { get: () => true },
      details: { get() { throw new Error('details getter'); } },
    }),
    { fatal: true, type: 'mediaError', details: { toString() { throw new Error('nested detail coercion'); } } },
    { fatal: true, type: 42, details: ['malformed'] },
  ];
  for (const hostileEvent of hostileEvents) {
    posted.length = 0;
    timers.length = 0;
    assert.doesNotThrow(() => hlsInstance.handlers.get(Hls.Events.ERROR)(null, hostileEvent));
    assert.equal(posted.length, 1);
    const state = posted[0].__mc_transport_state;
    assert.equal(state.render_state, 'error');
    assert.equal(state.error_state, null);
    assert.ok(timers.some((timer) => timer.delay === 45000));
    assert.ok(timers.some((timer) => timer.delay === 3000));
  }
});

test('HLS renderer session identity uses browser cryptography instead of Math.random', () => {
  const hlsPage = fs.readFileSync(path.join(serverRoot, 'player', 'hls.html'), 'utf8');
  const sessionLine = hlsPage.split(/\r?\n/).find((line) => line.includes('rendererSessionId'));
  assert.match(hlsPage, /crypto\.randomUUID|crypto\.getRandomValues/);
  assert.doesNotMatch(sessionLine, /Math\.random/);
});
