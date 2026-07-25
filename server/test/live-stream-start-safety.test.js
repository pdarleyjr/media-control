const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'live-stream.js'), 'utf8');

test('live-program preparation is explicit and does not start the stream or change director mode', () => {
  assert.match(source, /router\.post\('\/prepare'/);
  assert.match(source, /async function prepareLiveProgram/);
  const prepareRoute = source.match(/router\.post\('\/prepare'[\s\S]*?\n\}\);/);
  assert.ok(prepareRoute, 'prepare route should exist');
  assert.doesNotMatch(prepareRoute[0], /\/mode\//);
  assert.doesNotMatch(prepareRoute[0], /\/stream\/start/);
  assert.doesNotMatch(prepareRoute[0], /\/scene\//);
  assert.match(source, /STREAM_ALREADY_ACTIVE/);
});

test('live start defaults to manual mode and gates automatic direction explicitly', () => {
  assert.match(source, /const directorMode = 'manual'/);
  assert.match(source, /confirm_auto_canary/);
  assert.match(source, /initiator !== 'operator' && initiator !== 'user'/);
  assert.match(source, /cameraControl\.startLivestream\(\)/);
  assert.match(source, /require\('\.\.\/lib\/live-stream-safety'\)/);
  assert.match(source, /APPROVED_PROGRAM_SCENES/);
  assert.match(source, /OPERATOR_STREAM_START_DISABLED|startGateFailure/);
  assert.match(source, /AUTOMATIC_STREAM_START_DISABLED/);
});

test('live start reports failure unless OBS confirms the stream is active', () => {
  assert.match(source, /STREAM_START_NOT_CONFIRMED/);
  assert.match(source, /stream_active === true/);
  assert.match(source, /if \(!verified\)[\s\S]*cameraControl\.stopLivestream\(\)/);
});

test('live start replaces and refreshes the OBS browser source before scene selection', () => {
  assert.match(source, /buildLiveStreamPlayerUrl/);
  assert.match(source, /program_url/);
  assert.match(source, /program_refresh/);
  assert.match(source, /prepareLiveProgram/);
});

test('stopping a stream preserves the current classroom scene and director mode by default', () => {
  const stopRoute = source.match(/router\.post\('\/stop'[\s\S]*?\n\}\);/);
  assert.ok(stopRoute, 'stop route should exist');
  assert.doesNotMatch(stopRoute[0], /\/mode\/manual/);
  assert.doesNotMatch(stopRoute[0], /\/scene\//);
  assert.match(source, /STREAM_STOP_NOT_CONFIRMED/);
});

test('live-stream responses always use JSON error envelopes with request_id', () => {
  assert.match(source, /errorEnvelope|request_id/);
  assert.match(source, /createRequestId/);
  assert.match(source, /redactDirectorResult/);
  assert.match(source, /buildLivestreamCapabilities/);
});
