const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'live-stream.js'), 'utf8');

test('live start waits for a current director scene that matches program state', () => {
  assert.match(source, /function sceneMatchesProgramState/);
  assert.match(source, /waitForDirector\(\s*data => sceneMatchesProgramState\(data, programState\.content_active\)/);
  assert.match(source, /AI Director did not prepare a current camera scene/);
});

test('live start reports failure unless OBS confirms the stream is active', () => {
  assert.match(source, /if \(!streamStarted\)[\s\S]*return res\.status\(502\)/);
  assert.match(source, /waitForDirector\(data => data\.stream_active === true, 8000\)/);
  assert.match(source, /if \(!streamVerified\)[\s\S]*callDirector\('POST', '\/stream\/stop'\)/);
});
