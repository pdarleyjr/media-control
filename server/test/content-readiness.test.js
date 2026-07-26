'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { contentBroadcastReadiness } = require('../lib/content-readiness');

function fakeDb(manifest) {
  return {
    prepare(sql) {
      assert.match(sql, /asset_checksums/);
      return { get: () => manifest };
    },
  };
}

test('local video broadcasts require the ready final generation manifest', () => {
  const content = {
    id: 'video-id',
    filepath: 'final.mp4',
    mime_type: 'video/mp4',
    processing_status: 'ready',
    version: 5,
  };
  assert.deepEqual(contentBroadcastReadiness(fakeDb({
    generation: 5,
    sha256: 'a'.repeat(64),
    canonical_path: 'final.mp4',
    size_bytes: 123,
  }), content), { ready: true });

  assert.equal(contentBroadcastReadiness(fakeDb(null), content).code, 'CONTENT_MANIFEST_PENDING');
  assert.equal(contentBroadcastReadiness(fakeDb({
    generation: 4,
    sha256: 'b'.repeat(64),
    canonical_path: 'original.mov',
    size_bytes: 456,
  }), content).code, 'CONTENT_MANIFEST_PENDING');
});

test('processing and failed videos fail closed while non-video and remote content remain eligible', () => {
  const processing = contentBroadcastReadiness(fakeDb(null), {
    id: 'video-id',
    filepath: 'original.mov',
    mime_type: 'video/quicktime',
    processing_status: 'processing',
    version: 1,
  });
  assert.equal(processing.ready, false);
  assert.equal(processing.status, 409);
  assert.equal(processing.code, 'CONTENT_PROCESSING');

  const failed = contentBroadcastReadiness(fakeDb(null), {
    id: 'video-id',
    filepath: 'original.mov',
    mime_type: 'video/quicktime',
    processing_status: 'failed',
    processing_error: 'media_probe_failed',
    version: 1,
  });
  assert.equal(failed.status, 422);
  assert.equal(failed.code, 'CONTENT_PROCESSING_FAILED');

  assert.deepEqual(contentBroadcastReadiness(fakeDb(null), {
    id: 'image-id',
    filepath: 'image.png',
    mime_type: 'image/png',
  }), { ready: true });
  assert.deepEqual(contentBroadcastReadiness(fakeDb(null), {
    id: 'youtube-id',
    filepath: null,
    remote_url: 'https://www.youtube.com/watch?v=example',
    mime_type: 'video/youtube',
  }), { ready: true });
});
