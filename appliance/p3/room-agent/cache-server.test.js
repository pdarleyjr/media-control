const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { checksumMatches } = require('./cache-server');

test('checksumMatches validates SHA256 and rejects absent or mismatched digests', () => {
  const bytes = Buffer.from('classroom-cache-asset');
  const expected = crypto.createHash('sha256').update(bytes).digest('hex');
  assert.equal(checksumMatches(bytes, expected), true);
  assert.equal(checksumMatches(bytes, 'b'.repeat(64)), false);
  assert.equal(checksumMatches(bytes, ''), false);
});
