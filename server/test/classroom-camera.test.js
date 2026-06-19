'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  cameraUpstreamUrl,
  rewriteCameraManifest,
} = require('../lib/classroom-camera');

test('cameraUpstreamUrl only permits the two fixed classroom cameras', () => {
  assert.equal(
    cameraUpstreamUrl('1', 'index.m3u8'),
    'http://host.docker.internal:8766/camera-hls/1/index.m3u8'
  );
  assert.throws(() => cameraUpstreamUrl('3', 'index.m3u8'), /camera/);
  assert.throws(() => cameraUpstreamUrl('1', '../config.yml'), /asset/);
});

test('rewriteCameraManifest keeps every HLS request on the same-origin locked proxy', () => {
  const manifest = [
    '#EXTM3U',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:2.0,',
    'segment-001.mp4?token=abc',
  ].join('\n');

  const rewritten = rewriteCameraManifest(manifest, '2');

  assert.match(rewritten, /URI="\/player\/classroom-camera\/2\/init\.mp4"/);
  assert.match(rewritten, /\/player\/classroom-camera\/2\/segment-001\.mp4\?token=abc/);
});
