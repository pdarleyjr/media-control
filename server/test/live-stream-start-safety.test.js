const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'live-stream.js'), 'utf8');

test('deprecated live-program preparation remains side-effect free for rolling clients', () => {
  assert.match(source, /router\.post\('\/prepare'/);
  assert.match(source, /async function prepareLiveProgram/);
  const prepareRoute = source.match(/router\.post\('\/prepare'[\s\S]*?\n\}\);/);
  assert.ok(prepareRoute, 'prepare route should exist');
  assert.doesNotMatch(prepareRoute[0], /\/mode\//);
  assert.doesNotMatch(prepareRoute[0], /\/stream\/start/);
  assert.doesNotMatch(prepareRoute[0], /\/scene\//);
  assert.match(source, /STREAM_ALREADY_ACTIVE/);
});

test('live start is one-click, operator-only, and does not consume a production plan', () => {
  const startRoute = source.match(/router\.post\('\/start'[\s\S]*?\n\}\);/);
  assert.ok(startRoute, 'start route should exist');
  assert.doesNotMatch(startRoute[0], /consumePlanForStart/);
  assert.match(startRoute[0], /production_mode:\s*'fixed_camera'/);
  assert.match(startRoute[0], /camera_id:\s*3/);
  assert.match(source, /initiator !== 'operator' && initiator !== 'user'/);
  assert.match(source, /AUTOMATIC_STREAM_START_DISABLED/);
});

test('live start selects Camera Only and uses exactly one configured publisher', () => {
  const startRoute = source.match(/router\.post\('\/start'[\s\S]*?\n\}\);/);
  assert.ok(startRoute);
  assert.match(startRoute[0], /PUBLISHER_MODES\.FIXED_COMPOSITOR/);
  assert.match(startRoute[0], /selectCameraOnly/);
  assert.match(startRoute[0], /startStreaming/);
  assert.match(startRoute[0], /cameraControl\.startLivestream\(\)/);
  assert.match(startRoute[0], /DUPLICATE_PUBLISHER_ACTIVE/);
  assert.doesNotMatch(startRoute[0], /Promise\.all\([\s\S]*(?:startStreaming|startLivestream)/);
});

test('live start reports failure unless the selected publisher confirms active state', () => {
  assert.match(source, /STREAM_START_NOT_CONFIRMED/);
  assert.match(source, /publisherStatus[\s\S]*active === true/);
  assert.match(source, /rollbackSelectedPublisher/);
});

test('live start retains the credential-free OBS receiver URL and Camera Only composition', () => {
  assert.match(source, /buildLiveStreamPlayerUrl/);
  assert.match(source, /program_url/);
  assert.match(source, /FIXED_SCENES\.CAMERA_ONLY/);
});

test('stopping a stream preserves the current classroom composition', () => {
  const stopRoute = source.match(/router\.post\('\/stop'[\s\S]*?\n\}\);/);
  assert.ok(stopRoute, 'stop route should exist');
  assert.doesNotMatch(stopRoute[0], /setCurrentProgramScene/);
  assert.match(source, /STREAM_STOP_NOT_CONFIRMED/);
});

test('live-stream responses always use JSON error envelopes with request_id', () => {
  assert.match(source, /errorEnvelope|request_id/);
  assert.match(source, /createRequestId/);
  assert.match(source, /redactDirectorResult/);
  assert.match(source, /buildLivestreamCapabilities/);
});
