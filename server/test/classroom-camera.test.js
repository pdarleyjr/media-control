'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  cameraUpstreamUrl,
  rewriteCameraManifest,
} = require('../lib/classroom-camera');

test('cameraUpstreamUrl only permits the three fixed classroom cameras', () => {
  assert.equal(
    cameraUpstreamUrl('1', 'index.m3u8'),
    'http://host.docker.internal:8766/camera-hls/1/index.m3u8'
  );
  assert.equal(
    cameraUpstreamUrl('3', 'index.m3u8'),
    'http://host.docker.internal:8766/camera-hls/3/index.m3u8'
  );
  assert.throws(() => cameraUpstreamUrl('4', 'index.m3u8'), /camera/);
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

test('rewriteCameraManifest keeps ANNKE camera 3 assets on the same-origin proxy', () => {
  const manifest = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=2000000',
    'http://100.81.154.123:8888/annke-camera-3/video1_stream.m3u8',
  ].join('\n');

  const rewritten = rewriteCameraManifest(manifest, '3');

  assert.match(rewritten, /\/player\/classroom-camera\/3\/video1_stream\.m3u8/);
  assert.doesNotMatch(rewritten, /100\.81\.154\.123/);
});
