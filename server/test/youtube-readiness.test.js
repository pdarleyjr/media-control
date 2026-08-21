'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isYouTubeContentBroadcastReady } = require('../../frontend/js/views/media-control/youtube-readiness.js');

test('a content row without an id is not broadcast-ready', () => {
  assert.equal(isYouTubeContentBroadcastReady(null), false);
  assert.equal(isYouTubeContentBroadcastReady({}), false);
});

test('a materialized row with a local path is broadcast-ready', () => {
  assert.equal(isYouTubeContentBroadcastReady({ id: 'c1', local_path: '/content/yt.mp4' }), true);
  assert.equal(isYouTubeContentBroadcastReady({ id: 'c2', asset_id: 'asset-9' }), true);
  assert.equal(isYouTubeContentBroadcastReady({ id: 'c3', status: 'ready' }), true);
  assert.equal(isYouTubeContentBroadcastReady({ id: 'c4', materialized: true }), true);
});

test('a row created but still pending/failed without a local asset is NOT broadcast-ready', () => {
  assert.equal(isYouTubeContentBroadcastReady({ id: 'pending-1' }), false);
  assert.equal(isYouTubeContentBroadcastReady({ id: 'pending-2', status: 'pending' }), false);
  assert.equal(isYouTubeContentBroadcastReady({ id: 'failed-1', status: 'failed' }), false);
  assert.equal(isYouTubeContentBroadcastReady({ id: 'yt-1', remote_url: 'https://youtube.com/watch?v=abc' }), false);
});
