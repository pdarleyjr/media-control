'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  detectMediaMime,
  validateMediaIntegrity,
  isActiveContentMime,
} = require('../lib/media-integrity');

test('magic-byte detection identifies supported raster, PDF, MP4, WebM, and active content', () => {
  assert.equal(detectMediaMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), { filename: 'photo.bin' }), 'image/jpeg');
  assert.equal(detectMediaMime(Buffer.from('%PDF-1.7\n')), 'application/pdf');
  assert.equal(detectMediaMime(Buffer.from('\x00\x00\x00\x18ftypisom\x00\x00\x00\x00isommp42', 'binary')), 'video/mp4');
  assert.equal(detectMediaMime(Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
    Buffer.from('webm', 'ascii'),
  ])), 'video/webm');
  assert.equal(detectMediaMime(Buffer.from('<!doctype html><script>alert(1)</script>')), 'text/html');
  assert.equal(detectMediaMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')), 'image/svg+xml');
  assert.equal(detectMediaMime(Buffer.from('RIFF\x00\x00\x00\x00WAVEfmt ', 'binary')), 'audio/wav');
  assert.equal(detectMediaMime(Buffer.from('ID3\x04\x00\x00', 'binary')), 'audio/mpeg');
});

test('active content is rejected even when renamed and claimed as a safe image', () => {
  const result = validateMediaIntegrity({
    bytes: Buffer.from('<html><script>fetch("/api/users")</script></html>'),
    claimedMime: 'image/jpeg',
    filename: 'class-photo.jpg',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ACTIVE_CONTENT_REJECTED');
  assert.equal(result.detectedMime, 'text/html');
  assert.equal(isActiveContentMime(result.detectedMime), true);
});

test('specific MIME confusion fails closed while equivalent aliases and generic claims use detected bytes', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
  assert.equal(validateMediaIntegrity({
    bytes: jpeg,
    claimedMime: 'video/mp4',
    filename: 'wrong.mp4',
  }).code, 'MIME_MISMATCH');

  const generic = validateMediaIntegrity({
    bytes: jpeg,
    claimedMime: 'application/octet-stream',
    filename: 'photo.jpg',
  });
  assert.equal(generic.ok, true);
  assert.equal(generic.detectedMime, 'image/jpeg');
});
