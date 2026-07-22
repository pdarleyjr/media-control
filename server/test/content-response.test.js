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

test('contentRowsWithThumbnailUrls can issue signed thumbnail and file URLs', () => {
  const [row] = contentRowsWithThumbnailUrls(
    [{ id: 'private-1', thumbnail_path: 'thumb.jpg', filepath: 'clip.mp4' }],
    { secret: 'response-secret', now: 1_750_000_000, ttlSeconds: 60 },
  );
  assert.match(row.thumbnail_url, /^\/api\/content\/private-1\/thumbnail\?asset_exp=1750000060&asset_sig=/);
  assert.match(row.file_url, /^\/api\/content\/private-1\/file\?asset_exp=1750000060&asset_sig=/);
});
