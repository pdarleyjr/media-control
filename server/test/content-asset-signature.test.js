const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  signedContentAssetUrl,
  verifyContentAssetSignature,
} = require('../lib/content-asset-signature');
const { canServePublicContent } = require('../lib/public-content-access');

test('content asset signatures bind id, kind, and expiry', () => {
  const now = 1_750_000_000;
  const url = signedContentAssetUrl('asset one', 'thumbnail', 'test-secret', { now, ttlSeconds: 300 });
  const parsed = new URL(url, 'https://media.invalid');
  const query = Object.fromEntries(parsed.searchParams.entries());

  assert.equal(parsed.pathname, '/api/content/asset%20one/thumbnail');
  assert.equal(verifyContentAssetSignature('asset one', 'thumbnail', query, 'test-secret', now + 299), true);
  assert.equal(verifyContentAssetSignature('asset one', 'file', query, 'test-secret', now + 299), false);
  assert.equal(verifyContentAssetSignature('other', 'thumbnail', query, 'test-secret', now + 299), false);
  assert.equal(verifyContentAssetSignature('asset one', 'thumbnail', query, 'test-secret', now + 301), false);
});

test('malformed or excessively distant expiry is rejected', () => {
  assert.equal(verifyContentAssetSignature('id', 'file', {}, 'secret', 100), false);
  assert.equal(verifyContentAssetSignature('id', 'file', { asset_exp: 'NaN', asset_sig: 'x' }, 'secret', 100), false);
});

test('archived content is never served through the unattended-display fallback', () => {
  const db = { prepare() { throw new Error('archived path must short-circuit before DB assignment lookup'); } };
  assert.equal(canServePublicContent(db, { id: 'archived', archived_at: 1 }), false);
});

test('legacy raw upload route is guarded by content assignment authorization', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /app\.use\('\/uploads\/content',[\s\S]*rows\.find\(\(row\) => canServePublicContent\(db, row\)\)/);
  assert.match(source, /Raw content asset authorization required/);
});
