const assert = require('assert');
const test = require('node:test');
const { isHeicMime } = require('../lib/media-transcode');

test('isHeicMime detects iPhone HEIC/HEIF variants (case-insensitive)', () => {
  assert.equal(isHeicMime('image/heic'), true);
  assert.equal(isHeicMime('image/heif'), true);
  assert.equal(isHeicMime('image/heic-sequence'), true);
  assert.equal(isHeicMime('IMAGE/HEIC'), true);
  assert.equal(isHeicMime('image/jpeg'), false);
  assert.equal(isHeicMime('image/avif'), false);
  assert.equal(isHeicMime('video/quicktime'), false);
  assert.equal(isHeicMime(''), false);
  assert.equal(isHeicMime(null), false);
});
