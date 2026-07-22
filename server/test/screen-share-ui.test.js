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
  assert.match(engine, /relayFallbackTargets\.has\(deviceId\) \? 'relay \(video only\)'/);
  assert.match(signaling, /socket\.on\('screen-share:frame'/);
  assert.match(signaling, /session\.broadcasterSocketId !== socket\.id/);
  assert.match(signaling, /RELAY_FRAME_MAX_BASE64_CHARS/);
  assert.match(receiver, /sock\.on\('device:screen-share-frame'/);
  assert.match(receiver, /clearSetupWatchdog\(\);[\s\S]*mountFrameOverlay\(imageB64\)/);
});

test('screen share quality choices and degraded transport labels are operator-accurate', () => {
  const view = fs.readFileSync(
    path.resolve(__dirname, '../../frontend/js/views/screen-share.js'),
    'utf8'
  );
  const engine = fs.readFileSync(
    path.resolve(__dirname, '../../frontend/js/services/screen-share-engine.js'),
    'utf8'
  );

  assert.match(view, /name="content-hint" value="motion60"/);
  assert.match(view, /requests up to 60fps/);
  assert.match(engine, /motion60:[\s\S]*?frameRate:\s*\{\s*ideal:\s*60,\s*max:\s*60\s*\}/);
  assert.match(engine, /relay \(video only\)/);
  assert.match(engine, /mode:\s*'socket-frame-relay'/);
  assert.match(engine, /audioIncluded:\s*false/);
});

test('screen share supports explicit fit modes through authenticated signaling', () => {
  const view = fs.readFileSync(
    path.resolve(__dirname, '../../frontend/js/views/screen-share.js'),
    'utf8'
  );
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

  for (const fitMode of ['auto', 'contain', 'cover', 'fill']) {
    assert.match(view, new RegExp(`value="${fitMode}"`));
  }
  assert.match(engine, /fit_mode:\s*fitMode/);
  assert.match(signaling, /ALLOWED_FIT_MODES/);
  assert.match(signaling, /fit_mode:\s*safeFitMode/);
  assert.match(receiver, /window\.__screentinkerScreenShare\.fitMode/);
  assert.match(receiver, /object-fit:' \+ resolveObjectFit/);
});

test('screen share exposes live per-target WebRTC transport diagnostics', () => {
  const engine = fs.readFileSync(
    path.resolve(__dirname, '../../frontend/js/services/screen-share-engine.js'),
    'utf8'
  );
  const view = fs.readFileSync(
    path.resolve(__dirname, '../../frontend/js/views/screen-share.js'),
    'utf8'
  );

  assert.match(engine, /export async function getTargetDiagnostics\(\)/);
  assert.match(engine, /currentRoundTripTime/);
  assert.match(engine, /qualityLimitationReason/);
  assert.match(view, /refreshSessionDiagnostics/);
  assert.match(view, /ss-session-metrics/);
});

test('screen share REST config reports the real TURN provider and safe bitrate ceiling', () => {
  const route = fs.readFileSync(
    path.resolve(__dirname, '../routes/screen-share.js'),
    'utf8'
  );

  assert.match(route, /turnProvider:\s*config\.turnProvider/);
  assert.match(route, /SCREEN_SHARE_MAX_BITRATE_KBPS[^\n]*\|\| 8000/);
  assert.doesNotMatch(route, /\|\| 50000/);
});

test('screen share runbook distinguishes direct WebRTC from the video-only frame fallback', () => {
  const docs = fs.readFileSync(
    path.resolve(__dirname, '../../docs/SCREEN_SHARE.md'),
    'utf8'
  );

  assert.match(docs, /video-only/i);
  assert.match(docs, /1280.{0,10}720/i);
  assert.match(docs, /5 fps/i);
  assert.doesNotMatch(docs, /server is a \*\*stateless signaling relay\*\*/i);
});

test('screen share uses stable 1080p profiles and starts relay only after confirmed failure', () => {
  const engine = fs.readFileSync(
    path.resolve(__dirname, '../../frontend/js/services/screen-share-engine.js'),
    'utf8'
  );

  assert.match(engine, /CAPTURE_PROFILES/);
  assert.match(engine, /width:\s*\{\s*ideal:\s*1920,\s*max:\s*1920\s*\}/);
  assert.match(engine, /height:\s*\{\s*ideal:\s*1080,\s*max:\s*1080\s*\}/);
  assert.match(engine, /detail:[\s\S]*?frameRate:\s*\{\s*ideal:\s*24,\s*max:\s*30\s*\}/);
  assert.match(engine, /motion:[\s\S]*?frameRate:\s*\{\s*ideal:\s*30,\s*max:\s*30\s*\}/);
  assert.match(engine, /motion60:[\s\S]*?frameRate:\s*\{\s*ideal:\s*60,\s*max:\s*60\s*\}/);
  assert.doesNotMatch(engine, /peerConnections\.set\(deviceId, pc\);\s*relayFallbackTargets\.add\(deviceId\)/);
  assert.match(engine, /function enableRelayFallback\(deviceId, reason\)/);
  assert.match(engine, /requestVideoFrameCallback/);
  assert.match(engine, /typeof pc\.setRemoteDescription !== 'function'/);
  assert.match(engine, /typeof pc\.addIceCandidate !== 'function'/);
});
