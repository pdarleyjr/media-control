'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateRemoteMedia } = require('../lib/remote-media');
const MP4_BYTES = Buffer.from('\x00\x00\x00\x18ftypisom\x00\x00\x00\x00isommp42', 'binary');

test('remote validation records MIME, size, Range, CORS, final URL, and dependency health', async () => {
  const calls = [];
  const result = await validateRemoteMedia('https://cdn.example.test/video.mp4', {
    now: () => 1234,
    safetyCheck: async (url) => ({ ok: true, parsed: new URL(url) }),
    request: async (url, options) => {
      calls.push({ url, options });
      return {
        statusCode: 200,
        headers: {
          'content-type': 'video/mp4; charset=binary',
          'content-length': '1024',
          'accept-ranges': 'bytes',
          'access-control-allow-origin': '*',
        },
        body: MP4_BYTES,
      };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'healthy');
  assert.equal(result.detectedMime, 'video/mp4');
  assert.equal(result.contentLength, 1024);
  assert.equal(result.rangeSupported, true);
  assert.equal(result.corsAllowed, true);
  assert.equal(result.lastValidatedAt, 1234);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers.Range, 'bytes=0-65535');
});

test('every redirect target is safety-checked and private rebinding is rejected before request', async () => {
  const requested = [];
  const result = await validateRemoteMedia('https://public.example.test/start', {
    safetyCheck: async (url) => (
      url.includes('internal') ? { ok: false, reason: 'private_target', error: 'Internal URLs are not allowed' }
        : { ok: true, parsed: new URL(url) }
    ),
    request: async (url) => {
      requested.push(url);
      return {
        statusCode: 302,
        headers: { location: 'http://internal.example.test/secret.mp4' },
      };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'private_target');
  assert.deepEqual(requested, ['https://public.example.test/start']);
});

test('remote validation enforces redirect, response-size, timeout, and status boundaries', async () => {
  const tooLarge = await validateRemoteMedia('https://cdn.example.test/huge.mp4', {
    maxBytes: 100,
    safetyCheck: async (url) => ({ ok: true, parsed: new URL(url) }),
    request: async () => ({ statusCode: 200, headers: { 'content-length': '101' } }),
  });
  assert.equal(tooLarge.errorCode, 'remote_too_large');

  const unavailable = await validateRemoteMedia('https://cdn.example.test/missing.mp4', {
    safetyCheck: async (url) => ({ ok: true, parsed: new URL(url) }),
    request: async () => ({ statusCode: 404, headers: {} }),
  });
  assert.equal(unavailable.errorCode, 'remote_http_status');

  const timedOut = await validateRemoteMedia('https://cdn.example.test/slow.mp4', {
    safetyCheck: async (url) => ({ ok: true, parsed: new URL(url) }),
    request: async () => {
      const error = new Error('timeout');
      error.code = 'ETIMEDOUT';
      throw error;
    },
  });
  assert.equal(timedOut.errorCode, 'remote_timeout');
});

test('remote validation rejects MIME confusion and distinguishes web pages and HLS', async () => {
  const safetyCheck = async (value) => ({ ok: true, parsed: new URL(value) });
  const confused = await validateRemoteMedia('https://cdn.example.test/photo.jpg', {
    safetyCheck,
    request: async () => ({
      statusCode: 200,
      headers: { 'content-type': 'image/jpeg' },
      body: Buffer.from('<!doctype html><script>alert(1)</script>'),
    }),
  });
  assert.equal(confused.errorCode, 'remote_mime_mismatch');

  const page = await validateRemoteMedia('https://public.example.test/status', {
    safetyCheck,
    request: async () => ({
      statusCode: 200,
      headers: { 'content-type': 'text/html' },
      body: Buffer.from('<!doctype html><title>Status</title>'),
    }),
  });
  assert.equal(page.ok, true);
  assert.equal(page.sourceKind, 'web_page');

  const hls = await validateRemoteMedia('https://cdn.example.test/live.m3u8', {
    safetyCheck,
    request: async () => ({
      statusCode: 206,
      headers: {
        'content-type': 'application/vnd.apple.mpegurl',
        'content-range': 'bytes 0-20/500',
      },
      body: Buffer.from('#EXTM3U\n#EXT-X-VERSION:3'),
    }),
  });
  assert.equal(hls.ok, true);
  assert.equal(hls.sourceKind, 'live_stream');
  assert.equal(hls.rangeSupported, true);
  assert.equal(hls.contentLength, 500);
});
