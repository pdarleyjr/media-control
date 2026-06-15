const assert = require('assert');
const test = require('node:test');

const {
  clampPage,
  isDocumentMime,
  parsePdfInfo,
  pageCacheBasename,
} = require('../lib/doc-render');

test('isDocumentMime accepts PDF and Office/ODF documents only', () => {
  assert.equal(isDocumentMime('application/pdf'), true);
  assert.equal(isDocumentMime('application/vnd.ms-powerpoint'), true);
  assert.equal(isDocumentMime('application/vnd.openxmlformats-officedocument.presentationml.presentation'), true);
  assert.equal(isDocumentMime('application/vnd.oasis.opendocument.presentation'), true);
  assert.equal(isDocumentMime('image/png'), false);
  assert.equal(isDocumentMime('video/mp4'), false);
  assert.equal(isDocumentMime('text/html'), false);
});

test('parsePdfInfo extracts page count defensively', () => {
  assert.equal(parsePdfInfo('Title: Demo\nPages: 16\nPage size: 960 x 540 pts'), 16);
  assert.equal(parsePdfInfo('Pages: 1'), 1);
  assert.equal(parsePdfInfo('Title: missing pages'), 1);
  assert.equal(parsePdfInfo('Pages: nope'), 1);
});

test('clampPage keeps document navigation inside bounds', () => {
  assert.equal(clampPage(1, 10), 1);
  assert.equal(clampPage(99, 10), 10);
  assert.equal(clampPage(0, 10), 1);
  assert.equal(clampPage(-4, 10), 1);
  assert.equal(clampPage('3', 10), 3);
  assert.equal(clampPage('bad', 10), 1);
});

test('pageCacheBasename is deterministic and path-safe', () => {
  assert.equal(
    pageCacheBasename('abc-123', 1700000000123.4, 2, 216),
    'docpage_abc-123_1700000000123_216_2.png'
  );
  assert.equal(
    pageCacheBasename('../bad id', 1, 1, 216),
    'docpage____bad_id_1_216_1.png'
  );
});
