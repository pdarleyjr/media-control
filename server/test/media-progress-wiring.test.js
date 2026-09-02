'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const serverRoot = path.join(__dirname, '..');

test('player and HLS paths report bounded software progress through the existing state-report path', () => {
  const rootPlayer = fs.readFileSync(path.join(serverRoot, 'player', 'index.html'), 'utf8');
  const hlsPlayer = fs.readFileSync(path.join(serverRoot, 'player', 'hls.html'), 'utf8');
  const deviceSocket = fs.readFileSync(path.join(serverRoot, 'ws', 'deviceSocket.js'), 'utf8');

  assert.match(rootPlayer, /\/player\/media-progress\.js/);
  assert.match(rootPlayer, /createMediaProgressTracker/);
  assert.match(rootPlayer, /getVideoPlaybackQuality/);
  assert.match(hlsPlayer, /media-progress\.js/);
  assert.match(hlsPlayer, /Hls\.Events\.ERROR/);
  assert.match(hlsPlayer, /window\.__mcGetTransportState = playbackState/);
  assert.doesNotMatch(hlsPlayer, /setInterval\(function \(\) \{ notifyParent\('__mc_transport_state', playbackState\(\)\); \}, 15000\)/);
  assert.match(rootPlayer, /__mcGetTransportState/);
  assert.match(deviceSocket, /state\.render_telemetry/);
  assert.match(deviceSocket, /rendererProgress\.record/);
  assert.doesNotMatch(deviceSocket, /INSERT INTO .*render_progress/i);
});

test('the schema stays unchanged: progress is not a migration or a per-frame database write', () => {
  const schema = fs.readFileSync(path.join(serverRoot, 'db', 'schema.sql'), 'utf8');
  const progressService = fs.readFileSync(path.join(serverRoot, 'services', 'renderer-progress.js'), 'utf8');
  assert.doesNotMatch(schema, /last_media_progress_at|decoded_frame_progress|render_progress/i);
  assert.match(progressService, /maxEntries: 50/);
  assert.doesNotMatch(progressService, /db\.prepare|INSERT|UPDATE/i);
});
