'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const packageJson = require('./package.json');
const {
  CACHE_PROTOCOL_VERSION,
  authoritativeManifestItems,
  legacyManifestItems,
  purgeAcknowledgement,
} = require('./cache-manifest-protocol');

test('the P3 package and heartbeat protocol expose the destructive reconciliation contract', () => {
  assert.equal(CACHE_PROTOCOL_VERSION, 2);
  assert.equal(packageJson.version, '1.2.0');
});

test('only a versioned authoritative envelope may trigger destructive cache reconciliation', () => {
  assert.deepEqual(authoritativeManifestItems({
    protocol_version: CACHE_PROTOCOL_VERSION,
    authoritative: true,
    items: [],
  }), []);
  assert.equal(authoritativeManifestItems([]), null);
  assert.equal(authoritativeManifestItems({ protocol_version: 2, authoritative: false, items: [] }), null);
  assert.equal(authoritativeManifestItems({ protocol_version: 1, authoritative: true, items: [] }), null);
  assert.equal(authoritativeManifestItems({ protocol_version: 2, authoritative: true }), null);
});

test('legacy arrays remain a separate bounded non-authoritative prewarm payload', () => {
  const items = Array.from({ length: 10_005 }, (_, index) => ({ content_id: `asset-${index}` }));
  const legacy = legacyManifestItems(items);

  assert.equal(legacy.length, 10_000);
  assert.deepEqual(legacy[0], { content_id: 'asset-0' });
  assert.equal(legacyManifestItems({ items }), null);
  assert.equal(authoritativeManifestItems(items), null);
});

test('malformed, non-authoritative, and wrong-version envelopes authorize no reconciliation', () => {
  assert.equal(authoritativeManifestItems(null), null);
  assert.equal(authoritativeManifestItems('not-a-manifest'), null);
  assert.equal(authoritativeManifestItems({ protocol_version: 2, authoritative: false, items: [] }), null);
  assert.equal(authoritativeManifestItems({ protocol_version: 1, authoritative: true, items: [] }), null);
});

test('the real cache purge shape is promoted only when post-delete absence was verified', () => {
  assert.deepEqual(purgeAcknowledgement({ ok: true, removed: false }, { content_id: 'asset' }), {
    content_id: 'asset',
    ok: true,
    removed: false,
    purged: true,
    absent_verified: true,
  });
  assert.deepEqual(purgeAcknowledgement({ ok: false, removed: true }, { content_id: 'asset' }), {
    content_id: 'asset',
    ok: false,
    removed: true,
    purged: false,
    absent_verified: false,
  });
});
