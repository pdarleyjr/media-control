// Upload media normalization.
//
//   * HEIC/HEIF stills  -> JPEG, inline at upload. The display players and sharp
//     cannot decode HEIC (sharp's bundled libheif only does AVIF), so we decode
//     with heif-convert (libheif-tools + libde265) and re-encode JPEG. The stored
//     /served file becomes a normal JPEG, so it renders + thumbnails everywhere.
//   * Video -> a browser-safe MP4 (H.264 8-bit + stereo AAC), in the background.
//     Display browsers can only play H.264 (in mp4/mov) or VP8/VP9/AV1 (in webm),
//     8-bit, SDR, with AAC/Opus stereo-ish audio. ANYTHING else — an .mkv/.avi
//     container, HEVC/H.265, 10-bit, HDR/Dolby-Vision, or TrueHD/E-AC3/Atmos audio
//     — renders as "sound only / stutter / black". classifyMedia() decides; we
//     REMUX (lossless -c:v copy) when only the container/audio is wrong, else
//     re-encode with libx264 (HDR sources are tone-mapped to SDR). The row is
//     swapped in place on success and the original removed, mirroring the YouTube
//     transcode. Already-web-safe video (e.g. H.264 .mp4/.mov) is left untouched.
//
//   Memory/robustness: transcodes run IN this container (which is mem-capped), so
//   they go through a SINGLE-FLIGHT queue with bounded ffmpeg threads — one 4K
//   encode at a time, never N concurrent uploads stacking. resumePendingTranscodes()
//   re-queues any not-yet-web-safe video on boot, so a transcode killed mid-flight
//   by a deploy/restart self-heals on the next start.

const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { promisify } = require('util');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const { sha256File } = require('./asset-manifest');
const { emitContentUpdated, finalizeContentAsset } = require('./content-finalization');
const { mediaLimits } = require('./media-integrity');

const pexecFile = promisify(execFile);

const HEIC_MIMES = new Set(['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']);
function isHeicMime(mt) { return HEIC_MIMES.has((mt || '').toLowerCase()); }

/**
 * Decode a HEIC/HEIF file to JPEG (same uuid base, .jpg extension) in contentDir.
 * Applies EXIF orientation (iPhone photos are usually rotated). Deletes nothing;
 * the caller owns the original. Returns { absPath, filename, size, width, height }
 * or null on failure (non-fatal — caller keeps the original).
 */
async function heicToJpeg(absPath, contentDir) {
  const dir = contentDir || config.contentDir;
  const base = path.basename(absPath).replace(/\.[^.]+$/, '');
  const outName = `${base}.jpg`;
  const outPath = path.join(dir, outName);
  const rawJpg = path.join(dir, `${base}.heicraw.jpg`);
  try {
    await pexecFile('heif-convert', [absPath, rawJpg], { timeout: 60000 });
    // Single-image HEIC -> exactly rawJpg; multi-image (live photos) -> rawJpg-1.jpg.
    let src = rawJpg;
    if (!fs.existsSync(src)) {
      const alt = rawJpg.replace(/\.jpg$/i, '-1.jpg');
      if (fs.existsSync(alt)) src = alt; else throw new Error('heif-convert produced no output');
    }
    const sharp = require('sharp');
    await sharp(src, { failOn: 'none' }).rotate().jpeg({ quality: 85 }).toFile(outPath);
    let width = null, height = null;
    try { const m = await sharp(outPath).metadata(); width = m.width; height = m.height; } catch { /* ignore */ }
    try { fs.unlinkSync(src); } catch { /* ignore */ }
    const size = fs.statSync(outPath).size;
    return { absPath: outPath, filename: outName, size, width, height };
  } catch (e) {
    console.warn('heicToJpeg failed (non-fatal):', e && e.message);
    try { if (fs.existsSync(rawJpg)) fs.unlinkSync(rawJpg); } catch { /* ignore */ }
    try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch { /* ignore */ }
    return null;
  }
}

// Probe the first video stream's codec (e.g. "hevc", "h264"). Null on failure.
function probeVideoCodec(absPath) {
  try {
    return execFileSync('ffprobe',
      ['-v', 'quiet', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'default=nw=1:nk=1', absPath],
      { timeout: 15000 }).toString().trim().toLowerCase() || null;
  } catch { return null; }
}

function needsHevcTranscode(absPath) {
  const codec = probeVideoCodec(absPath);
  return codec === 'hevc' || codec === 'h265';
}

// Full asynchronous probe of the first video stream -> the fields
// classifyMedia() needs. The durable worker must not stall the main Node event
// loop while ffprobe inspects a large or remote-backed file.
async function probeMedia(absPath) {
  try {
    const { stdout } = await pexecFile('ffprobe',
      ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', absPath],
      { timeout: 20000, maxBuffer: 5 * 1024 * 1024, windowsHide: true });
    const info = JSON.parse(String(stdout));
    const streams = info.streams || [];
    const v = streams.find((stream) => stream.codec_type === 'video') || {};
    const a = streams.find((stream) => stream.codec_type === 'audio') || {};
    const frameRate = String(v.avg_frame_rate || v.r_frame_rate || '').split('/');
    const fps = frameRate.length === 2 && Number(frameRate[1])
      ? Number(frameRate[0]) / Number(frameRate[1])
      : null;
    return {
      ext: path.extname(absPath).toLowerCase(),
      vcodec: (v.codec_name || '').toLowerCase(),
      video_codec: (v.codec_name || '').toLowerCase() || null,
      video_profile: v.profile || null,
      audio_codec: (a.codec_name || '').toLowerCase() || null,
      audio_profile: a.profile || null,
      audio_sample_fmt: (a.sample_fmt || '').toLowerCase() || null,
      audio_channels: Number(a.channels) || null,
      audio_channel_layout: a.channel_layout || null,
      audio_sample_rate: Number(a.sample_rate) || null,
      audio_bitrate_bps: Number(a.bit_rate) || null,
      has_audio: !!a.codec_name,
      width: Number(v.width) || null,
      height: Number(v.height) || null,
      frame_rate: Number.isFinite(fps) ? fps : null,
      duration_seconds: Number(info.format && info.format.duration) || null,
      bitrate_bps: Number(info.format && info.format.bit_rate) || null,
      container: (info.format && info.format.format_name) || null,
      pixfmt: (v.pix_fmt || '').toLowerCase(),
      transfer: (v.color_transfer || '').toLowerCase(),
      colorspace: (v.color_space || '').toLowerCase(),
    };
  } catch { return null; }
}

// PURE helpers — unit-tested without ffmpeg.
const MP4_EXTS = new Set(['.mp4', '.m4v', '.mov']);
// 10/12/16-bit pixel formats: yuv420p10le, yuv444p12le, p010le, p016le, ...
function is10bit(pixfmt) {
  pixfmt = (pixfmt || '').toLowerCase();
  return /(?:10|12|16)(?:le|be)$/.test(pixfmt) || /^p0?1[0-6]/.test(pixfmt);
}
// HDR: PQ (smpte2084), HLG (arib-std-b67), or a BT.2020 colorspace.
function isHdr(transfer, colorspace) {
  transfer = (transfer || '').toLowerCase();
  return transfer === 'smpte2084' || transfer === 'arib-std-b67' || /bt2020/.test((colorspace || '').toLowerCase());
}
// PURE. Decide what to do with a probed file:
//   webSafe       — already plays in a display browser; do nothing.
//   needsReencode — the video stream itself is unplayable (HEVC/10-bit/HDR/etc.)
//                   so re-encode with libx264; else only the container/audio is
//                   wrong and we REMUX (-c:v copy, lossless).
//   tonemap       — source is HDR; tone-map to SDR during re-encode.
// A null probe (unreadable) is treated as web-safe so we never touch a file we
// can't understand.
function classifyMedia(m) {
  if (!m) {
    return {
      webSafe: true,
      needsReencode: false,
      audioNeedsTranscode: false,
      tonemap: false,
    };
  }
  const ext = (m.ext || '').toLowerCase();
  const vcodec = (m.vcodec || '').toLowerCase();
  const tenbit = is10bit(m.pixfmt);
  const hdr = isHdr(m.transfer, m.colorspace);
  // tonemap carries WHICH HDR transfer so buildTranscodeArgs can stamp the right
  // input characteristics: 'hlg' for arib-std-b67, else 'pq' (HDR10 / Dolby Vision).
  const tonemap = hdr ? ((m.transfer || '').toLowerCase() === 'arib-std-b67' ? 'hlg' : 'pq') : false;
  const containerOk = ext === '.webm' || MP4_EXTS.has(ext);
  const codecOk = ext === '.webm' ? ['vp8', 'vp9', 'av1'].includes(vcodec) : vcodec === 'h264';
  const hasAudio = m.has_audio === true || Boolean(m.audio_codec);
  const audioCodec = String(m.audio_codec || '').toLowerCase();
  const audioProfile = String(m.audio_profile || '').toLowerCase();
  const channels = Number(m.audio_channels) || 0;
  const channelCountOk = channels === 0 || channels <= 2;
  const sourceAudioSafe = !hasAudio || (
    channelCountOk && (
      (ext === '.webm' && ['opus', 'vorbis'].includes(audioCodec))
      || (MP4_EXTS.has(ext)
        && audioCodec === 'aac'
        && (!audioProfile || audioProfile === 'lc' || audioProfile === 'aac lc'))
    )
  );
  const webSafe = containerOk && codecOk && !tenbit && !hdr && sourceAudioSafe;
  // Any non-web-safe source is normalized to MP4. AAC-LC stereo can be copied
  // from another container; WebM Opus/Vorbis must be transcoded for that MP4
  // delivery derivative even though it is safe when the WebM remains untouched.
  const mp4AudioSafe = !hasAudio || (
    channelCountOk
    && audioCodec === 'aac'
    && (!audioProfile || audioProfile === 'lc' || audioProfile === 'aac lc')
  );
  const audioNeedsTranscode = !webSafe && hasAudio && !mp4AudioSafe;
  // The video ELEMENTARY stream is browser-decodable as-is only when it's 8-bit
  // SDR H.264 — then we can copy it and just fix the container + audio.
  const videoStreamFine = vcodec === 'h264' && !tenbit && !hdr;
  return {
    webSafe,
    needsReencode: !videoStreamFine,
    audioNeedsTranscode,
    tonemap,
  };
}

// PURE. The HDR->SDR -vf filtergraph. setparams STAMPS the assumed input
// characteristics first, so files with missing/unknown color tags (common in DV /
// some HDR encodes) don't fail zscale with "no path between colorspaces". Then
// PQ/HLG -> linear -> hable tonemap -> BT.709 SDR 8-bit.
function hdrToSdrVf(kind) {
  const trc = kind === 'hlg' ? 'arib-std-b67' : 'smpte2084';
  return `setparams=color_primaries=bt2020:color_trc=${trc}:colorspace=bt2020nc,` +
    'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,' +
    'zscale=t=bt709:m=bt709:p=bt709:r=tv,format=yuv420p';
}
// PURE. ffmpeg argv to normalize `inPath` -> browser-safe MP4 at `outPath`.
function buildTranscodeArgs(inPath, outPath, cls) {
  const args = ['-y', '-i', inPath, '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn'];
  if (cls.needsReencode) {
    const width = Math.max(0, Number(cls.sourceWidth) || 0);
    const height = Math.max(0, Number(cls.sourceHeight) || 0);
    const ultrawide = width > 0 && height > 0 && width / height >= 2.5;
    const maxWidth = ultrawide
      ? Math.max(1920, Number(process.env.MEDIA_ULTRAWIDE_MAX_WIDTH) || 7680)
      : Math.max(640, Number(process.env.MEDIA_DELIVERY_MAX_WIDTH) || 1920);
    const maxHeight = ultrawide
      ? Math.max(1080, Number(process.env.MEDIA_ULTRAWIDE_MAX_HEIGHT) || 2160)
      : Math.max(360, Number(process.env.MEDIA_DELIVERY_MAX_HEIGHT) || 1080);
    const scale = `scale=w='min(iw,${maxWidth})':h='min(ih,${maxHeight})':` +
      'force_original_aspect_ratio=decrease:force_divisible_by=2';
    const filters = cls.tonemap
      ? `${hdrToSdrVf(cls.tonemap)},${scale}`
      : `${scale},format=yuv420p`;
    args.push('-vf', filters);
    // -threads 8 bounds memory (an all-cores 4K encode spikes several GB); medium
    // /crf20 + profile high + 8-bit = high-quality, universally decodable default.
    const maxRate = ultrawide
      ? String(process.env.MEDIA_ULTRAWIDE_MAXRATE || '35M')
      : String(process.env.MEDIA_DELIVERY_MAXRATE || '12M');
    const bufferSize = ultrawide
      ? String(process.env.MEDIA_ULTRAWIDE_BUFSIZE || '70M')
      : String(process.env.MEDIA_DELIVERY_BUFSIZE || '24M');
    args.push(
      '-c:v', 'libx264',
      '-profile:v', 'high',
      '-preset', 'medium',
      '-crf', '20',
      '-maxrate', maxRate,
      '-bufsize', bufferSize,
      '-threads', '8',
    );
  } else {
    args.push('-c:v', 'copy');   // only the container/audio was wrong — keep the H.264 stream
  }
  if (cls.audioNeedsTranscode === false) {
    args.push('-c:a', 'copy');
  } else {
    // Atmos/TrueHD/E-AC3/5.1/7.1 don't play reliably in display browsers.
    args.push('-c:a', 'aac', '-profile:a', 'aac_low', '-ac', '2', '-b:a', '256k');
  }
  args.push('-movflags', '+faststart', outPath);
  return args;
}

function transcodeTimeoutMs() {
  const v = parseInt(process.env.HEVC_TIMEOUT_MS, 10);
  return Number.isFinite(v) && v > 0 ? v : 60 * 60 * 1000;   // 1h ceiling (4K encodes are slow)
}

function safeUnlink(filePath) {
  try { if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) {}
}

function setProcessingState(db, contentId, expectedFilepath, expectedVersion, status, error, probe) {
  return db.prepare(`
    UPDATE content
    SET processing_status=?, processing_error=?, media_probe_json=COALESCE(?, media_probe_json),
        original_filepath=COALESCE(original_filepath, filepath), updated_at=?
    WHERE id=? AND filepath=? AND COALESCE(version, 1)=?
  `).run(
    status,
    error ? String(error).slice(0, 2000) : null,
    probe ? JSON.stringify(probe) : null,
    Math.floor(Date.now() / 1000),
    contentId,
    expectedFilepath,
    expectedVersion,
  ).changes > 0;
}

let ffmpegTail = Promise.resolve();
function defaultTranscode(inputPath, outputPath, classification) {
  const run = ffmpegTail.then(() => pexecFile(
    'ffmpeg',
    buildTranscodeArgs(inputPath, outputPath, classification),
    { timeout: transcodeTimeoutMs(), maxBuffer: 2 * 1024 * 1024, windowsHide: true },
  ));
  // Keep the global one-at-a-time lane usable after a failed encode while
  // returning the real outcome to this normalization job.
  ffmpegTail = run.catch(() => {});
  return run;
}

async function defaultThumbnail(inputPath, outputName, contentDir, options = {}) {
  const thumbnailName = `thumb_${outputName.replace(/\.[^.]+$/, '.jpg')}`;
  const thumbnailPath = path.join(contentDir, thumbnailName);
  try {
    if (typeof options.registerArtifact === 'function') options.registerArtifact(thumbnailPath);
    await pexecFile('ffmpeg', [
      '-y', '-i', inputPath, '-vframes', '1',
      '-vf', `scale=${config.thumbnailWidth}:-1`,
      thumbnailPath,
    ], { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true });
    return thumbnailName;
  } catch (_) {
    return null;
  }
}

// Run one lifecycle: uploaded -> probing -> [processing] -> ready|failed.
// The finalizer owns the one atomic DB/manifest generation swap and the one
// priority P3 handoff. Unreadable video fails closed and is never prewarmed.
async function normalizeVideoJob(job = {}) {
  const contentId = String(job.contentId || '');
  const absPath = job.absPath;
  const db = job.db || require('../db/database').db;
  const contentDir = job.contentDir || config.contentDir;
  const probe = job.probeMedia || probeMedia;
  const classify = job.classifyMedia || classifyMedia;
  const hashFile = job.sha256File || sha256File;
  const transcode = job.transcode || defaultTranscode;
  const createThumbnail = job.createThumbnail || defaultThumbnail;
  const finalize = job.finalizeContentAsset || finalizeContentAsset;
  const makeUuid = job.uuid || uuidv4;
  const registerArtifact = typeof job.registerArtifact === 'function' ? job.registerArtifact : () => {};
  const releaseArtifact = typeof job.releaseArtifact === 'function' ? job.releaseArtifact : () => {};
  const isCancellationRequested = typeof job.isCancellationRequested === 'function'
    ? job.isCancellationRequested
    : () => false;
  const expectedFilepath = String(job.expectedFilepath || path.basename(absPath || ''));
  let stagedPath = null;
  let thumbnailPath = null;

  if (!contentId || !absPath || !fs.existsSync(absPath)) {
    return { status: 'failed', content_id: contentId, error: 'source_missing' };
  }
  const initial = db.prepare('SELECT * FROM content WHERE id = ?').get(contentId);
  if (!initial || initial.filepath !== expectedFilepath) {
    return { status: 'stale', content_id: contentId };
  }
  const expectedVersion = Math.max(1, Number(initial.version) || 1);
  if (!setProcessingState(db, contentId, expectedFilepath, expectedVersion, 'probing', null, null)) {
    return { status: 'stale', content_id: contentId };
  }

  try {
    const sourceProbe = await Promise.resolve(probe(absPath));
    if (!sourceProbe) throw new Error('media_probe_failed');
    const limits = mediaLimits();
    if (Number(sourceProbe.duration_seconds) > limits.maxDurationSeconds) {
      throw new Error('media_duration_limit_exceeded');
    }
    if (Number(sourceProbe.width) > 0 && Number(sourceProbe.height) > 0
        && Number(sourceProbe.width) * Number(sourceProbe.height) > limits.maxImagePixels) {
      throw new Error('media_pixel_limit_exceeded');
    }
    const classification = classify(sourceProbe);
    let originalSha = null;
    try {
      originalSha = await hashFile(absPath);
      db.prepare(`
        UPDATE content SET original_sha256=?
        WHERE id=? AND filepath=? AND COALESCE(version, 1)=?
      `).run(originalSha, contentId, expectedFilepath, expectedVersion);
    } catch (_) {
      originalSha = null;
    }

    if (classification.webSafe) {
      // Posters are part of canonical readiness even when no transcode is
      // necessary. A stale/version-mismatched finalizer will discard the new
      // poster rather than attaching it to replacement bytes.
      let webSafeThumbnail = null;
      try {
        webSafeThumbnail = await createThumbnail(absPath, expectedFilepath, contentDir, { registerArtifact });
      } catch (_) {
        webSafeThumbnail = null;
      }
      if (isCancellationRequested()) throw new Error('media_job_cancelled');
      const result = await finalize({
        db,
        io: job.io,
        contentId,
        expectedFilepath,
        expectedVersion,
        candidatePath: absPath,
        finalPath: absPath,
        finalFilepath: expectedFilepath,
        metadata: {
          mimeType: initial.mime_type || 'video/mp4',
          durationSec: sourceProbe.duration_seconds,
          width: sourceProbe.width,
          height: sourceProbe.height,
          thumbnailPath: webSafeThumbnail || null,
          thumbnailProvenance: webSafeThumbnail ? 'video_frame' : null,
          thumbnailSourceSha256: originalSha,
          probe: sourceProbe,
          originalFilepath: expectedFilepath,
          originalSha256: originalSha,
        },
        staleAbsolutePaths: job.staleAbsolutePaths || [],
        discardPathsOnStale: webSafeThumbnail
          ? [path.join(contentDir, webSafeThumbnail)]
          : [],
        prewarmContent: job.prewarmContent,
        sha256File: job.sha256File,
      });
      if (result?.status === 'ready' && webSafeThumbnail) {
        releaseArtifact(path.join(contentDir, webSafeThumbnail));
      }
      return result;
    }

    if (!setProcessingState(
      db, contentId, expectedFilepath, expectedVersion, 'processing', null, sourceProbe,
    )) return { status: 'stale', content_id: contentId };

    const outputBase = String(makeUuid());
    const outputName = `${outputBase}.mp4`;
    stagedPath = path.join(contentDir, `${outputBase}.part.mp4`);
    const finalPath = path.join(contentDir, outputName);
    registerArtifact(stagedPath);
    registerArtifact(finalPath);
    console.log(`[transcode] ${contentId}: ${classification.needsReencode
      ? (classification.tonemap ? 're-encode+tonemap' : 're-encode')
      : 'remux'} -> ${outputName}`);
    await transcode(absPath, stagedPath, {
      ...classification,
      sourceWidth: sourceProbe.width,
      sourceHeight: sourceProbe.height,
    });
    if (isCancellationRequested()) throw new Error('media_job_cancelled');

    const outputProbe = await Promise.resolve(probe(stagedPath));
    if (!outputProbe || !classify(outputProbe).webSafe) throw new Error('normalized_output_not_web_safe');
    const thumbnailName = await createThumbnail(stagedPath, outputName, contentDir, { registerArtifact });
    thumbnailPath = thumbnailName ? path.join(contentDir, thumbnailName) : null;
    // Preserve the current original/master bytes. They are retained through
    // original_filepath/original_sha256 unless an explicit retention policy
    // later authorizes deletion. Superseded prior generations remain eligible
    // for cleanup after this generation commits.
    const stalePaths = [...(job.staleAbsolutePaths || [])];
    if (initial.thumbnail_path && (!thumbnailName || initial.thumbnail_path !== thumbnailName)) {
      stalePaths.push(path.join(contentDir, initial.thumbnail_path));
    }

    if (isCancellationRequested()) throw new Error('media_job_cancelled');
    const result = await finalize({
      db,
      io: job.io,
      contentId,
      expectedFilepath,
      expectedVersion,
      candidatePath: stagedPath,
      finalPath,
      finalFilepath: outputName,
      metadata: {
        mimeType: 'video/mp4',
        durationSec: outputProbe.duration_seconds,
        width: outputProbe.width,
        height: outputProbe.height,
        thumbnailPath: thumbnailName,
        thumbnailProvenance: thumbnailName ? 'video_frame' : null,
        thumbnailSourceSha256: originalSha,
        probe: outputProbe,
        originalFilepath: expectedFilepath,
        originalSha256: originalSha,
      },
      staleAbsolutePaths: stalePaths,
      discardPathsOnStale: thumbnailPath ? [thumbnailPath] : [],
      prewarmContent: job.prewarmContent,
      sha256File: job.sha256File,
    });
    stagedPath = null;
    if (result.status === 'ready') {
      releaseArtifact(path.join(contentDir, `${outputBase}.part.mp4`));
      releaseArtifact(finalPath);
      if (thumbnailPath) releaseArtifact(thumbnailPath);
      console.log(`[transcode] ${contentId} -> ${outputName} (${outputProbe.width}x${outputProbe.height}, ${outputProbe.duration_seconds}s)`);
    }
    return result;
  } catch (error) {
    safeUnlink(stagedPath);
    safeUnlink(thumbnailPath);
    const stateChanged = setProcessingState(
      db,
      contentId,
      expectedFilepath,
      expectedVersion,
      'failed',
      error.message || 'normalization_failed',
      null,
    );
    if (stateChanged) {
      const failedRow = db.prepare('SELECT * FROM content WHERE id = ?').get(contentId);
      emitContentUpdated(job.io, failedRow, expectedVersion);
    }
    console.warn(`[transcode] failed for ${contentId}: ${error.message}`);
    return { status: 'failed', content_id: contentId, error: error.message };
  }
}

// Every upload can probe immediately; only the default ffmpeg function above is
// serialized. This prevents a long 4K encode from delaying a web-safe upload's
// immediate manifest/prewarm while still bounding encoder memory to one process.
const _jobFlights = new Map();

function jobKey(job) {
  return `${String(job.contentId || '')}:${path.resolve(String(job.absPath || ''))}`;
}

function enqueueTranscode(job) {
  if (!job || !job.contentId || !job.absPath) return Promise.resolve({ status: 'ignored' });
  const key = jobKey(job);
  if (_jobFlights.has(key)) return _jobFlights.get(key);
  let resolveFlight;
  const flight = new Promise((resolve) => { resolveFlight = resolve; });
  _jobFlights.set(key, flight);
  setImmediate(async () => {
    let result;
    try {
      result = await normalizeVideoJob(job);
    } catch (error) {
      result = { status: 'failed', content_id: job.contentId, error: error.message };
    }
    _jobFlights.delete(key);
    resolveFlight(result);
  });
  return flight;
}

// Background normalize -> browser-safe MP4. Enqueued for EVERY video upload; the
// runner probes and no-ops when the file already plays. Name kept for the existing
// call sites (content.js / finalize-upload.js). Non-fatal.
function kickHevcTranscodeIfNeeded(contentId, absPath, options = {}) {
  try {
    const db = options.db || require('../db/database').db;
    const row = db.prepare('SELECT * FROM content WHERE id=?').get(contentId);
    if (!row || !absPath) return Promise.resolve({ status: 'stale', content_id: contentId });
    const { getMediaPipeline } = require('./media-pipeline');
    const pipeline = getMediaPipeline({
      db,
      io: options.io,
      contentDir: options.contentDir || config.contentDir,
    });
    const queued = pipeline.enqueueVideo({
      contentId,
      workspaceId: row.workspace_id || '__platform__',
      userId: row.user_id,
      absolutePath: absPath,
      expectedVersion: Math.max(1, Number(row.version) || 1),
      expectedFilepath: row.filepath,
      staleAbsolutePaths: options.staleAbsolutePaths || [],
      sourceType: options.sourceType || 'upload',
    });
    return pipeline.waitForDrain().then(() => {
      const completed = pipeline.store.get(queued.job.id);
      if (completed?.status === 'completed') return completed.result || { status: 'ready', content_id: contentId };
      if (completed?.status === 'failed') {
        return {
          status: 'failed',
          content_id: contentId,
          error: completed.error_code || completed.error_message || 'normalization_failed',
          job_id: completed.id,
        };
      }
      return {
        status: completed?.status || 'queued',
        content_id: contentId,
        job_id: completed?.id || queued.job.id,
      };
    });
  } catch (error) {
    return Promise.resolve({
      status: 'failed',
      content_id: contentId,
      error: error.message,
    });
  }
}

// On boot, re-queue any video row that isn't already a web-safe MP4/WebM. A
// transcode killed mid-flight by a deploy/restart leaves the row pointing at the
// original (e.g. video/x-matroska); this self-heals it. The runner re-probes and
// skips anything that is actually fine (e.g. an H.264 .mov reported as quicktime).
function enqueuePendingTranscodeRows(rows, options = {}) {
  const contentDir = options.contentDir || config.contentDir;
  const fsApi = options.fsApi || fs;
  const pipeline = options.pipeline;
  const onSkip = typeof options.onSkip === 'function' ? options.onSkip : () => {};
  if (!pipeline || typeof pipeline.enqueueVideo !== 'function') {
    throw new Error('resume_pipeline_unavailable');
  }

  let queued = 0;
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const filepath = typeof row.filepath === 'string' ? row.filepath : '';
    if (!filepath.trim()) {
      onSkip({ contentId: row.id, reason: 'empty_filepath' });
      continue;
    }

    const absolutePath = path.join(contentDir, filepath);
    let stat;
    try {
      stat = fsApi.statSync(absolutePath);
    } catch (error) {
      onSkip({
        contentId: row.id,
        reason: error?.code === 'ENOENT' ? 'missing_file' : (error?.message || 'stat_failed'),
      });
      continue;
    }
    if (!stat || typeof stat.isFile !== 'function' || !stat.isFile()) {
      onSkip({ contentId: row.id, reason: 'not_a_file' });
      continue;
    }

    try {
      pipeline.enqueueVideo({
        contentId: row.id,
        workspaceId: row.workspace_id || '__platform__',
        userId: row.user_id,
        absolutePath,
        expectedVersion: Math.max(1, Number(row.version) || 1),
        expectedFilepath: filepath,
        sourceType: 'restart_recovery',
      });
      queued++;
    } catch (error) {
      onSkip({ contentId: row.id, reason: error?.message || 'resume_enqueue_failed' });
    }
  }
  return queued;
}

function resumePendingTranscodes(options = {}) {
  try {
    const db = options.db || require('../db/database').db;
    const rows = db.prepare(
      `SELECT id, user_id, workspace_id, filepath, version FROM content
       WHERE mime_type LIKE 'video/%' AND filepath IS NOT NULL
         AND TRIM(filepath) <> ''
         AND (
           processing_status IN ('uploaded', 'probing', 'processing')
           OR processing_status IS NULL
           OR (processing_status='ready' AND mime_type NOT IN ('video/mp4', 'video/webm'))
         )`
    ).all();
    const getMediaPipeline = options.getMediaPipeline
      || require('./media-pipeline').getMediaPipeline;
    const contentDir = options.contentDir || config.contentDir;
    const pipeline = getMediaPipeline({
      db,
      io: options.io,
      contentDir,
    });
    const queued = enqueuePendingTranscodeRows(rows, {
      contentDir,
      fsApi: options.fsApi,
      pipeline,
      onSkip: options.onSkip || ((entry) => {
        if (!['empty_filepath', 'missing_file', 'not_a_file'].includes(entry.reason)) {
          console.warn(`[transcode] resume skipped content ${entry.contentId}: ${entry.reason}`);
        }
      }),
    });
    pipeline.schedule();
    if (queued) console.log(`[transcode] resume: queued ${queued} incomplete video(s) for normalization`);
  } catch (e) { console.warn(`[transcode] resume scan failed: ${e && e.message}`); }
}

module.exports = {
  isHeicMime, heicToJpeg, probeVideoCodec, needsHevcTranscode,
  enqueuePendingTranscodeRows, kickHevcTranscodeIfNeeded, normalizeVideoJob, resumePendingTranscodes,
  probeMedia, classifyMedia, buildTranscodeArgs, is10bit, isHdr,
  HEIC_MIMES,
};
