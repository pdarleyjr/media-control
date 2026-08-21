'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const packageJson = require('./package.json');
const {
  CACHE_PROTOCOL_VERSION,
  authoritativeManifestItems,
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
