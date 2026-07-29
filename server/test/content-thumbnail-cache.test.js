'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  requestMatchesEtag,
  thumbnailCacheIdentity,
} = require('../lib/content-thumbnail-cache');

test('thumbnail identity is stable for one generation and changes with generation or bytes', () => {
  const content = {
    id: 'content-1',
    version: 7,
    thumbnail_generation: 7,
    updated_at: 100,
    thumbnail_path: 'thumb_content-1.jpg',
  };
  const first = thumbnailCacheIdentity(content, { size: 1234 });
  const repeated = thumbnailCacheIdentity({ ...content }, { size: 1234 });
  assert.deepEqual(repeated, first);
  assert.match(first.contentLocation, /\?v=7$/);
  assert.notEqual(
    thumbnailCacheIdentity({ ...content, thumbnail_generation: 8 }, { size: 1234 }).etag,
    first.etag,
  );
  assert.notEqual(thumbnailCacheIdentity(content, { size: 1235 }).etag, first.etag);
});

test('If-None-Match accepts exact list members and wildcard only', () => {
  const etag = 'W/"thumb-abc"';
  assert.equal(requestMatchesEtag(etag, etag), true);
  assert.equal(requestMatchesEtag(`"other", ${etag}`, etag), true);
  assert.equal(requestMatchesEtag('*', etag), true);
  assert.equal(requestMatchesEtag('W/"thumb-ab"', etag), false);
});
