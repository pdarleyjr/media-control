const assert = require('assert');
const test = require('node:test');
const path = require('node:path');
const { isHeicMime } = require('../lib/media-transcode');
const MT = require('../lib/media-transcode');

test('resume scan skips empty, missing, directory, and invalid rows without aborting valid videos', () => {
  const contentDir = path.resolve('bounded-resume-content');
  const enqueued = [];
  const skipped = [];
  const fsApi = {
    statSync(candidate) {
      const name = path.basename(candidate);
      if (name === 'missing.mp4') {
        const error = new Error('not found');
        error.code = 'ENOENT';
        throw error;
      }
      return { isFile: () => name !== 'directory.mp4' };
    },
  };
  const pipeline = {
    enqueueVideo(job) {
      if (job.contentId === 'invalid') throw new Error('invalid legacy row');
      enqueued.push(job);
    },
  };

  const queued = MT.enqueuePendingTranscodeRows([
    { id: 'blank', filepath: '   ', version: 1 },
    { id: 'missing', filepath: 'missing.mp4', version: 1 },
    { id: 'directory', filepath: 'directory.mp4', version: 1 },
    { id: 'invalid', filepath: 'invalid.mp4', version: 1 },
    {
      id: 'valid',
      user_id: 'operator-1',
      workspace_id: 'workspace-1',
      filepath: 'valid.mp4',
      version: 2,
    },
  ], {
    contentDir,
    fsApi,
    pipeline,
    onSkip(entry) {
      skipped.push(entry);
    },
  });

  assert.equal(queued, 1);
  assert.deepEqual(enqueued, [{
    contentId: 'valid',
    workspaceId: 'workspace-1',
    userId: 'operator-1',
    absolutePath: path.join(contentDir, 'valid.mp4'),
    expectedVersion: 2,
    expectedFilepath: 'valid.mp4',
    sourceType: 'restart_recovery',
  }]);
  assert.deepEqual(
    skipped.map((entry) => [entry.contentId, entry.reason]),
    [
      ['blank', 'empty_filepath'],
      ['missing', 'missing_file'],
      ['directory', 'not_a_file'],
      ['invalid', 'invalid legacy row'],
    ],
  );
});

test('resume query excludes empty legacy filepaths before constructing pipeline jobs', () => {
  let query = '';
  let schedules = 0;
  const db = {
    prepare(sql) {
      query = sql;
      return { all: () => [] };
    },
  };

  MT.resumePendingTranscodes({
    contentDir: path.resolve('bounded-resume-content'),
    db,
    getMediaPipeline() {
      return {
        enqueueVideo() {
          assert.fail('empty result set must not enqueue');
        },
        schedule() {
          schedules += 1;
        },
      };
    },
  });

  assert.match(query, /TRIM\(filepath\) <> ''/);
  assert.equal(schedules, 1);
});

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
  assert.deepEqual(MT.classifyMedia({
    ext: '.mp4',
    vcodec: 'h264',
    pixfmt: 'yuv420p',
    transfer: 'bt709',
    audio_codec: 'aac',
    audio_channels: 2,
    audio_profile: 'LC',
    audio_sample_fmt: 'fltp',
    has_audio: true,
  }), {
    webSafe: true,
    needsReencode: false,
    audioNeedsTranscode: false,
    tonemap: false,
  });
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
    { webSafe: false, needsReencode: true, audioNeedsTranscode: false, tonemap: false });
  assert.equal(MT.classifyMedia({ ext: '.mp4', vcodec: 'h264', pixfmt: 'yuv420p10le' }).needsReencode, true);
  // The DolbyElement case: HEVC Main10 + Dolby Vision (PQ) in an .mkv
  const dv = MT.classifyMedia({ ext: '.mkv', vcodec: 'hevc', pixfmt: 'yuv420p10le', transfer: 'smpte2084', colorspace: 'bt2020nc' });
  assert.deepEqual(dv, { webSafe: false, needsReencode: true, audioNeedsTranscode: false, tonemap: 'pq' });
  // HLG source → 'hlg' (stamps a different input transfer)
  assert.equal(MT.classifyMedia({ ext: '.mkv', vcodec: 'hevc', pixfmt: 'yuv420p10le', transfer: 'arib-std-b67' }).tonemap, 'hlg');
});

test('classifyMedia: MP4 audio compatibility covers AAC stereo, multichannel, AC-3, E-AC-3, PCM, Opus, MP3, and silence', () => {
  const base = {
    ext: '.mp4',
    vcodec: 'h264',
    pixfmt: 'yuv420p',
    transfer: 'bt709',
    has_audio: true,
    audio_channels: 2,
    audio_sample_fmt: 'fltp',
  };
  const compatible = MT.classifyMedia({ ...base, audio_codec: 'aac', audio_profile: 'LC' });
  assert.equal(compatible.webSafe, true);
  assert.equal(compatible.audioNeedsTranscode, false);

  for (const sample of [
    { audio_codec: 'aac', audio_channels: 6, audio_profile: 'LC' },
    { audio_codec: 'ac3' },
    { audio_codec: 'eac3' },
    { audio_codec: 'pcm_s16le', audio_sample_fmt: 's16' },
    { audio_codec: 'opus' },
    { audio_codec: 'mp3' },
  ]) {
    const classification = MT.classifyMedia({ ...base, ...sample });
    assert.equal(classification.webSafe, false, JSON.stringify(sample));
    assert.equal(classification.needsReencode, false, 'audio-only repair must copy H.264');
    assert.equal(classification.audioNeedsTranscode, true, JSON.stringify(sample));
  }

  const silent = MT.classifyMedia({ ...base, has_audio: false, audio_codec: null, audio_channels: null });
  assert.equal(silent.webSafe, true);
  assert.equal(silent.audioNeedsTranscode, false);
});

test('classifyMedia: WebM accepts Opus stereo but remuxes multichannel audio and rejects VP9 in MP4', () => {
  const webm = {
    ext: '.webm',
    vcodec: 'vp9',
    pixfmt: 'yuv420p',
    has_audio: true,
    audio_codec: 'opus',
    audio_channels: 2,
  };
  assert.equal(MT.classifyMedia(webm).webSafe, true);
  const multichannel = MT.classifyMedia({ ...webm, audio_channels: 6 });
  assert.equal(multichannel.webSafe, false);
  assert.equal(multichannel.needsReencode, true, 'VP9 cannot be copied into the MP4 delivery profile');
  assert.equal(multichannel.audioNeedsTranscode, true);
  assert.equal(MT.classifyMedia({ ...webm, ext: '.mp4' }).needsReencode, true);
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
  assert.match(a[a.indexOf('-vf') + 1], /format=yuv420p/);
  assert.match(a[a.indexOf('-vf') + 1], /min\(iw,1920\)/);
  assert.equal(a[a.indexOf('-maxrate') + 1], '12M');
  assert.ok(a.includes('-threads') && a[a.indexOf('-threads') + 1] === '8');
  assert.ok(!a.some((x) => typeof x === 'string' && x.includes('tonemap')));
  assert.ok(a.includes('-ac') && a[a.indexOf('-ac') + 1] === '2');
});

test('buildTranscodeArgs preserves compatible AAC while bounding an ultrawide derivative', () => {
  const args = MT.buildTranscodeArgs('/wall.mkv', '/wall.mp4', {
    needsReencode: true,
    tonemap: false,
    audioNeedsTranscode: false,
    sourceWidth: 5760,
    sourceHeight: 1080,
  });
  assert.equal(args[args.indexOf('-c:a') + 1], 'copy');
  assert.match(args[args.indexOf('-vf') + 1], /min\(iw,7680\)/);
  assert.equal(args[args.indexOf('-maxrate') + 1], '35M');
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
