const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('idle screen-share rendering cannot recurse between UI synchronizers', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../frontend/js/views/screen-share.js'),
    'utf8'
  );

  assert.match(source, /function syncCaptureStoppedUI\(\{ refreshSessions = true \} = \{\}\)/);
  assert.match(source, /syncCaptureStoppedUI\(\{ refreshSessions: false \}\)/);
});

test('screen share falls back to an authenticated bounded frame relay', () => {
  const engine = fs.readFileSync(
    path.resolve(__dirname, '../../frontend/js/services/screen-share-engine.js'),
    'utf8'
  );
  const signaling = fs.readFileSync(
    path.resolve(__dirname, '../ws/screen-share-signaling.js'),
    'utf8'
  );
  const receiver = fs.readFileSync(
    path.resolve(__dirname, '../player/screen-share-receiver.js'),
    'utf8'
  );

  assert.match(engine, /sock\.emit\(SS\.FRAME/);
  assert.match(engine, /relayFallbackTargets\.has\(deviceId\) \? 'relay'/);
  assert.match(signaling, /socket\.on\('screen-share:frame'/);
  assert.match(signaling, /session\.broadcasterSocketId !== socket\.id/);
  assert.match(signaling, /RELAY_FRAME_MAX_BASE64_CHARS/);
  assert.match(receiver, /sock\.on\('device:screen-share-frame'/);
  assert.match(receiver, /clearSetupWatchdog\(\);[\s\S]*mountFrameOverlay\(imageB64\)/);
});
