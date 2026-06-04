const { test } = require('node:test');
const assert = require('node:assert/strict');
const { contentRowsWithThumbnailUrls } = require('../lib/content-response');

test('contentRowsWithThumbnailUrls adds public thumbnail URLs for rows with generated thumbnails', () => {
  const rows = [
    { id: 'img-1', filename: 'training-room.jpg', thumbnail_path: 'thumb-img-1.jpg' },
    { id: 'doc-1', filename: 'remote', thumbnail_path: null },
  ];

  assert.deepEqual(contentRowsWithThumbnailUrls(rows), [
    { id: 'img-1', filename: 'training-room.jpg', thumbnail_path: 'thumb-img-1.jpg', thumbnail_url: '/api/content/img-1/thumbnail' },
    { id: 'doc-1', filename: 'remote', thumbnail_path: null, thumbnail_url: null },
  ]);
});

test('contentRowsWithThumbnailUrls never mutates DB-backed row objects', () => {
  const rows = [{ id: 'video-1', thumbnail_path: 'thumb-video-1.jpg' }];
  const mapped = contentRowsWithThumbnailUrls(rows);

  assert.equal(rows[0].thumbnail_url, undefined);
  assert.notEqual(mapped[0], rows[0]);
});

test('contentRowsWithThumbnailUrls tolerates non-array input', () => {
  assert.deepEqual(contentRowsWithThumbnailUrls(null), []);
});
