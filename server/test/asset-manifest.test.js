const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { sha256File, canonicalAssetPath } = require('../lib/asset-manifest');
const { buildContentManifest } = require('../lib/node-registry');

test('sha256File records immutable content bytes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-asset-'));
  const file = path.join(dir, 'sample.bin');
  fs.writeFileSync(file, 'mbfd-cache-checksum');
  try {
    const actual = await sha256File(file);
    const expected = crypto.createHash('sha256').update('mbfd-cache-checksum').digest('hex');
    assert.equal(actual, expected);
    assert.equal(canonicalAssetPath('content id'), '/api/content/content%20id/file');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('node manifest contains only checksum-ready canonical assets', () => {
  const fakeDb = {
    prepare() {
      return {
        all() {
          return [
            { content_id: 'ready', size_bytes: 12, sha256: 'a'.repeat(64), asset_id: 'asset-ready' },
            { content_id: 'pending', size_bytes: 8, sha256: null, asset_id: null },
          ];
        },
      };
    },
  };
  const manifest = buildContentManifest(fakeDb, { queueMissing: false, allowUnscoped: true });
  assert.deepEqual(manifest, [{
    asset_id: 'asset-ready',
    content_id: 'ready',
    sha256: 'a'.repeat(64),
    size: 12,
    size_bytes: 12,
    canonical_url: '/api/content/ready/file',
  }]);
});

test('node manifest stages videos first and newest content first within a media class', () => {
  const fakeDb = {
    prepare() {
      return {
        all() {
          return [
            { content_id: 'old-image', size_bytes: 1, sha256: 'a'.repeat(64), mime_type: 'image/png', created_at: 10 },
            { content_id: 'new-image', size_bytes: 2, sha256: 'b'.repeat(64), mime_type: 'image/png', created_at: 30 },
            { content_id: 'video', size_bytes: 3, sha256: 'c'.repeat(64), mime_type: 'video/mp4', created_at: 5 },
          ];
        },
      };
    },
  };

  const manifest = buildContentManifest(fakeDb, { queueMissing: false, allowUnscoped: true });
  assert.deepEqual(manifest.map((item) => item.content_id), ['video', 'new-image', 'old-image']);
});
