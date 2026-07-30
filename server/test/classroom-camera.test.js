'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  cameraUpstreamUrl,
  rewriteCameraManifest,
} = require('../lib/classroom-camera');

test('cameraUpstreamUrl only permits the two canonical live source identities', () => {
  assert.equal(
    cameraUpstreamUrl('anpviz', 'index.m3u8'),
    'http://192.168.1.122:8888/anpviz-main/index.m3u8'
  );
  assert.equal(
    cameraUpstreamUrl('guest-computer', 'index.m3u8'),
    'http://192.168.1.122:8888/guest-computer/index.m3u8'
  );
  assert.throws(() => cameraUpstreamUrl('focus-210', 'index.m3u8'), /source/);
  assert.throws(() => cameraUpstreamUrl('anpviz', '../config.yml'), /asset/);
});

test('rewriteCameraManifest keeps every HLS request on the same-origin locked proxy', () => {
  const manifest = [
    '#EXTM3U',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:2.0,',
    'segment-001.mp4?token=abc',
  ].join('\n');

  const rewritten = rewriteCameraManifest(manifest, 'guest-computer');

  assert.match(rewritten, /URI="\/player\/live-source\/guest-computer\/init\.mp4"/);
  assert.match(rewritten, /\/player\/live-source\/guest-computer\/segment-001\.mp4\?token=abc/);
});

test('rewriteCameraManifest keeps the canonical Anpviz assets on the same-origin proxy', () => {
  const manifest = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=2000000',
    'http://192.168.1.122:8888/anpviz-main/video1_stream.m3u8',
  ].join('\n');

  const rewritten = rewriteCameraManifest(manifest, 'anpviz');

  assert.match(rewritten, /\/player\/live-source\/anpviz\/video1_stream\.m3u8/);
  assert.doesNotMatch(rewritten, /192\.168\.1\.122/);
});
