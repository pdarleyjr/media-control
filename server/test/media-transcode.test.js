const assert = require('assert');
const test = require('node:test');
const { isHeicMime } = require('../lib/media-transcode');
const MT = require('../lib/media-transcode');

test('isHeicMime detects iPhone HEIC/HEIF variants (case-insensitive)', () => {
  assert.equal(isHeicMime('image/heic'), true);
  assert.equal(isHeicMime('image/heif'), true);
  assert.equal(isHeicMime('image/heic-sequence'), true);
  assert.equal(isHeicMime('IMAGE/HEIC'), true);
  assert.equal(isHeicMime('image/jpeg'), false);
  assert.equal(isHeicMime('image/avif'), false);
  assert.equal(isHeicMime('video/quicktime'), false);
  assert.equal(isHeicMime(''), false);
  assert.equal(isHeicMime(null), false);
});

// ---- video normalization decisions (pure; no ffmpeg) -----------------------
// The contract that keeps uploads web-safe: only 8-bit SDR H.264-in-mp4/mov (or
// VP8/9/AV1-in-webm) is left alone; everything else is remuxed (video stream OK)
// or re-encoded (HDR → tone-mapped), always with forced stereo AAC.

test('is10bit: flags 10/12/16-bit pixel formats only', () => {
  for (const p of ['yuv420p10le', 'yuv422p10le', 'yuv444p12le', 'p010le', 'p016le', 'yuv420p10be']) {
    assert.equal(MT.is10bit(p), true, p);
  }
  for (const p of ['yuv420p', 'yuvj420p', 'nv12', 'rgb24', 'yuv410p', '']) {
    assert.equal(MT.is10bit(p), false, p);
  }
});

test('isHdr: PQ / HLG / BT.2020 are HDR; bt709 is not', () => {
  assert.equal(MT.isHdr('smpte2084', ''), true);          // PQ / HDR10 / Dolby Vision base
  assert.equal(MT.isHdr('arib-std-b67', ''), true);       // HLG
  assert.equal(MT.isHdr('', 'bt2020nc'), true);           // wide-gamut colorspace
  assert.equal(MT.isHdr('bt709', 'bt709'), false);
  assert.equal(MT.isHdr('', ''), false);
});

test('classifyMedia: already-web-safe sources are left alone', () => {
  assert.deepEqual(MT.classifyMedia({ ext: '.mp4', vcodec: 'h264', pixfmt: 'yuv420p', transfer: 'bt709' }),
    { webSafe: true, needsReencode: false, tonemap: false });
  assert.equal(MT.classifyMedia({ ext: '.mov', vcodec: 'h264', pixfmt: 'yuv420p' }).webSafe, true);
  assert.equal(MT.classifyMedia({ ext: '.webm', vcodec: 'vp9', pixfmt: 'yuv420p' }).webSafe, true);
  assert.equal(MT.classifyMedia({ ext: '.webm', vcodec: 'av1', pixfmt: 'yuv420p' }).webSafe, true);
  assert.equal(MT.classifyMedia(null).webSafe, true);     // unreadable → never touch
});

test('classifyMedia: H.264 in a non-web container → REMUX (copy video, fix container/audio)', () => {
  const c = MT.classifyMedia({ ext: '.mkv', vcodec: 'h264', pixfmt: 'yuv420p', transfer: 'bt709' });
  assert.equal(c.webSafe, false);       // .mkv won't play in a browser
  assert.equal(c.needsReencode, false); // but the H.264 stream is fine → copy it
  assert.equal(c.tonemap, false);
});

test('classifyMedia: HEVC / 10-bit / HDR → RE-ENCODE (tonemap PQ vs HLG only when HDR)', () => {
  assert.deepEqual(MT.classifyMedia({ ext: '.mp4', vcodec: 'hevc', pixfmt: 'yuv420p' }),
    { webSafe: false, needsReencode: true, tonemap: false });
  assert.equal(MT.classifyMedia({ ext: '.mp4', vcodec: 'h264', pixfmt: 'yuv420p10le' }).needsReencode, true);
  // The DolbyElement case: HEVC Main10 + Dolby Vision (PQ) in an .mkv
  const dv = MT.classifyMedia({ ext: '.mkv', vcodec: 'hevc', pixfmt: 'yuv420p10le', transfer: 'smpte2084', colorspace: 'bt2020nc' });
  assert.deepEqual(dv, { webSafe: false, needsReencode: true, tonemap: 'pq' });
  // HLG source → 'hlg' (stamps a different input transfer)
  assert.equal(MT.classifyMedia({ ext: '.mkv', vcodec: 'hevc', pixfmt: 'yuv420p10le', transfer: 'arib-std-b67' }).tonemap, 'hlg');
});

test('buildTranscodeArgs: REMUX path copies video, forces stereo AAC + faststart', () => {
  const a = MT.buildTranscodeArgs('/in.mkv', '/out.mp4', { needsReencode: false, tonemap: false });
  assert.ok(a.includes('-c:v') && a[a.indexOf('-c:v') + 1] === 'copy');
  assert.ok(!a.includes('libx264'));
  assert.ok(a.includes('-ac') && a[a.indexOf('-ac') + 1] === '2');
  assert.ok(a.includes('+faststart'));
  assert.deepEqual(a.slice(0, 8), ['-y', '-i', '/in.mkv', '-map', '0:v:0', '-map', '0:a:0?', '-sn']);
  assert.equal(a[a.length - 1], '/out.mp4');
});

test('buildTranscodeArgs: RE-ENCODE (SDR) uses libx264 8-bit, no tonemap filter', () => {
  const a = MT.buildTranscodeArgs('/in.mp4', '/out.mp4', { needsReencode: true, tonemap: false });
  assert.ok(a.includes('libx264'));
  assert.ok(a.includes('-pix_fmt') && a[a.indexOf('-pix_fmt') + 1] === 'yuv420p');
  assert.ok(a.includes('-threads') && a[a.indexOf('-threads') + 1] === '8');
  assert.ok(!a.some((x) => typeof x === 'string' && x.includes('tonemap')));
  assert.ok(a.includes('-ac') && a[a.indexOf('-ac') + 1] === '2');
});

test('buildTranscodeArgs: RE-ENCODE (HDR) stamps input + tonemaps; PQ vs HLG transfer', () => {
  const pq = MT.buildTranscodeArgs('/in.mkv', '/out.mp4', { needsReencode: true, tonemap: 'pq' });
  const vf = pq[pq.indexOf('-vf') + 1];
  assert.ok(vf.includes('setparams'), 'stamps assumed color tags so unknown-tag HDR does not fail zscale');
  assert.ok(vf.includes('smpte2084') && vf.includes('tonemap') && vf.includes('zscale'));
  assert.ok(pq.includes('libx264'));
  const hlg = MT.buildTranscodeArgs('/in.mkv', '/out.mp4', { needsReencode: true, tonemap: 'hlg' });
  assert.ok(hlg[hlg.indexOf('-vf') + 1].includes('arib-std-b67'));
});
