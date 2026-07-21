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
  const manifest = buildContentManifest(fakeDb, { queueMissing: false });
  assert.deepEqual(manifest, [{
    asset_id: 'asset-ready',
    content_id: 'ready',
    sha256: 'a'.repeat(64),
    size: 12,
    size_bytes: 12,
    canonical_url: '/api/content/ready/file',
  }]);
});
