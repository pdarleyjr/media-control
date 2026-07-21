const test = require('node:test');
const assert = require('node:assert/strict');

const {
  collectAllowedHosts,
  normalizeUrl,
  resolveServerUrl,
} = require('./server-url');

test('normalizeUrl accepts http(s) and strips query/hash/trailing slash', () => {
  assert.equal(normalizeUrl('http://gmktec.local:8096/app/?x=1#y'), 'http://gmktec.local:8096/app');
  assert.equal(normalizeUrl('https://media-control.mbfdhub.com/app/'), 'https://media-control.mbfdhub.com/app');
});

test('normalizeUrl rejects non-http values', () => {
  assert.equal(normalizeUrl('file:///etc/passwd'), '');
  assert.equal(normalizeUrl('not a url'), '');
});

test('resolveServerUrl prefers LAN URL before the fallback URL', () => {
  assert.equal(
    resolveServerUrl({
      MC_SERVER_LAN_URL: 'http://gmktec.local:8096',
      MC_SERVER_URL: 'http://100.81.154.123:8096',
    }),
    'http://gmktec.local:8096'
  );
  assert.equal(
    resolveServerUrl({
      MC_SERVER_URL: 'http://100.81.154.123:8096',
    }, { defaultUrl: 'http://fallback.example.test:8096' }),
    'http://100.81.154.123:8096'
  );
});

test('collectAllowedHosts deduplicates hosts from URLs', () => {
  assert.deepEqual(
    collectAllowedHosts(
      'https://media-control.mbfdhub.com/app',
      'https://media-control.mbfdhub.com/app#section',
      'http://127.0.0.1:8097'
    ).sort(),
    ['127.0.0.1:8097', 'media-control.mbfdhub.com'].sort()
  );
});
