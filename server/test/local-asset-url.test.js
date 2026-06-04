const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeBaseUrl,
  localContentBaseUrlFromEnv,
  withLocalAssetUrls,
} = require('../lib/local-asset-url');

test('normalizeBaseUrl accepts http(s) and strips path slash/query/hash', () => {
  assert.equal(normalizeBaseUrl('http://192.168.1.10:8096/?x=1#y'), 'http://192.168.1.10:8096');
  assert.equal(normalizeBaseUrl('https://media.example.test/local/'), 'https://media.example.test/local');
});

test('normalizeBaseUrl rejects non-http values', () => {
  assert.equal(normalizeBaseUrl('file:///etc/passwd'), '');
  assert.equal(normalizeBaseUrl('not a url'), '');
});

test('localContentBaseUrlFromEnv prefers explicit URL then builds from LAN host', () => {
  assert.equal(localContentBaseUrlFromEnv({ LOCAL_CONTENT_BASE_URL: 'http://gmktec.local:8096/' }), 'http://gmktec.local:8096');
  assert.equal(localContentBaseUrlFromEnv({ LOCAL_PROXY_IP: '10.0.0.5', LOCAL_PROXY_PORT: '8096' }), 'http://10.0.0.5:8096');
});

test('withLocalAssetUrls adds local asset_url only to local file content', () => {
  const out = withLocalAssetUrls([
    { filepath: 'clip one.mp4', mime_type: 'video/mp4' },
    { filepath: '', remote_url: 'https://example.test/video.mp4' },
    { widget_id: 'w1' },
  ], 'http://10.0.0.5:8096');
  assert.equal(out[0].asset_url, 'http://10.0.0.5:8096/uploads/content/clip%20one.mp4');
  assert.equal(out[0].asset_proxy, 'local');
  assert.equal(out[1].asset_url, undefined);
  assert.equal(out[2].asset_url, undefined);
});

test('withLocalAssetUrls is a no-op without a valid base URL', () => {
  const items = [{ filepath: 'clip.mp4' }];
  assert.equal(withLocalAssetUrls(items, ''), items);
  assert.equal(withLocalAssetUrls(items, 'ftp://bad'), items);
});
