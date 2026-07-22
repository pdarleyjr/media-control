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
  assert.match(source, /requestedDirectorMode[\s\S]*=== 'auto' \? 'auto' : 'manual'/);
  assert.match(source, /confirm_auto_canary/);
  assert.match(source, /Automatic direction requires an explicit completed-canary confirmation/);
  assert.match(source, /callDirector\('POST', `\/mode\/\$\{directorMode\}`\)/);
  assert.match(source, /require\('\.\.\/lib\/live-stream-safety'\)/);
  assert.match(source, /OBS program scene is not safe to stream/);
});

test('live start reports failure unless OBS confirms the stream is active', () => {
  assert.match(source, /if \(!streamStarted\)[\s\S]*return res\.status\(502\)/);
  assert.match(source, /waitForDirector\(data => data\.stream_active === true, 8000\)/);
  assert.match(source, /if \(!streamVerified\)[\s\S]*callDirector\('POST', '\/stream\/stop'\)/);
});

test('live start replaces and refreshes the OBS browser source before scene selection', () => {
  assert.match(source, /function freshProgramUrl/);
  assert.match(source, /_mc_live_session/);
  assert.match(source, /callDirector\('POST', '\/media-control\/program-url', \{ url: playerUrl \}\)/);
  assert.match(source, /callDirector\('POST', '\/media-control\/refresh'\)/);
  assert.match(source, /if \(!programRefresh\.ok[\s\S]*return res\.status\(502\)/);
});

test('stopping a stream preserves the current classroom scene and director mode by default', () => {
  const stopRoute = source.match(/router\.post\('\/stop'[\s\S]*?\n\}\);/);
  assert.ok(stopRoute, 'stop route should exist');
  assert.doesNotMatch(stopRoute[0], /\/mode\/manual/);
  assert.doesNotMatch(stopRoute[0], /\/scene\//);
});
