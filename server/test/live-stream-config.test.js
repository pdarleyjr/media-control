const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const configPath = path.join(__dirname, '..', 'config.js');

function readPlayerBaseUrl(env) {
  const script = `const c=require(${JSON.stringify(configPath)}); process.stdout.write(JSON.stringify(c.liveStream.playerBaseUrl));`;
  const result = spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, APP_URL: '', LIVE_STREAM_PLAYER_BASE_URL: '', ...env },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('public APP_URL never becomes the default OBS browser-source URL', () => {
  assert.equal(readPlayerBaseUrl({ APP_URL: 'https://media-control.example.test' }), '');
});

test('a dedicated live-stream player base URL remains configurable', () => {
  assert.equal(readPlayerBaseUrl({
    APP_URL: 'https://media-control.example.test',
    LIVE_STREAM_PLAYER_BASE_URL: 'http://192.168.1.10:8096',
  }), 'http://192.168.1.10:8096');
});
