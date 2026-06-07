// iPhone media transcoding.
//
//   * HEIC/HEIF stills  -> JPEG, inline at upload. The display players and sharp
//     cannot decode HEIC (sharp's bundled libheif only does AVIF), so we decode
//     with heif-convert (libheif-tools + libde265) and re-encode JPEG. The stored
//     /served file becomes a normal JPEG, so it renders + thumbnails everywhere.
//   * HEVC (H.265) video -> H.264 MP4, in the background. iPhones record HEVC in a
//     .mov; H.265 won't play on most display browsers. ffmpeg (libx264 encoder +
//     hevc decoder, both present) transcodes and the row is swapped in place,
//     mirroring transcodeYouTubeInBackground. H.264 .mov is left untouched.

const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { promisify } = require('util');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');

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

// Background HEVC -> H.264 MP4. Swaps the content row in place on success
// (filepath, file_size, dims, duration, regenerated thumbnail) and deletes the
// original. No-op for non-HEVC video. Non-fatal (the row keeps the original).
function kickHevcTranscodeIfNeeded(contentId, absPath) {
  let codec;
  try { codec = probeVideoCodec(absPath); } catch { codec = null; }
  if (codec !== 'hevc' && codec !== 'h265') return;

  const outName = `${uuidv4()}.mp4`;
  const outPath = path.join(config.contentDir, outName);
  const timeoutMs = (() => { const v = parseInt(process.env.HEVC_TIMEOUT_MS, 10); return Number.isFinite(v) && v > 0 ? v : 30 * 60 * 1000; })();
  const args = [
    '-y', '-i', absPath,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart',
    outPath,
  ];
  execFile('ffmpeg', args, { timeout: timeoutMs }, (err) => {
    if (err) {
      console.warn(`HEVC transcode failed for ${contentId}: ${err.message}`);
      try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch { /* ignore */ }
      return;
    }
    let durationSec = null, width = null, height = null, fileSize = 0, thumbName = null;
    try {
      fileSize = fs.statSync(outPath).size;
      const probe = execFileSync('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', outPath], { timeout: 15000 }).toString();
      const info = JSON.parse(probe);
      if (info.format && info.format.duration) durationSec = parseFloat(info.format.duration);
      const vs = info.streams && info.streams.find((s) => s.codec_type === 'video');
      if (vs) { width = vs.width; height = vs.height; }
    } catch (e) { console.warn(`ffprobe of transcoded HEVC file failed: ${e.message}`); }
    try {
      thumbName = `thumb_${outName.replace(/\.[^.]+$/, '.jpg')}`;
      execFileSync('ffmpeg', ['-y', '-i', outPath, '-ss', '2', '-vframes', '1', '-vf', `scale=${config.thumbnailWidth}:-1`, path.join(config.contentDir, thumbName)], { timeout: 30000 });
    } catch { thumbName = null; }
    try {
      const { db } = require('../db/database');
      const prev = db.prepare('SELECT filepath, thumbnail_path FROM content WHERE id = ?').get(contentId);
      db.prepare("UPDATE content SET filepath = ?, mime_type = 'video/mp4', file_size = ?, duration_sec = ?, width = ?, height = ?, thumbnail_path = COALESCE(?, thumbnail_path) WHERE id = ?")
        .run(outName, fileSize, durationSec, width, height, thumbName, contentId);
      // Clean up the original HEVC file + its old thumbnail now the row points at the MP4.
      if (prev && prev.filepath && prev.filepath !== outName) { try { fs.unlinkSync(path.join(config.contentDir, prev.filepath)); } catch { /* ignore */ } }
      if (prev && prev.thumbnail_path && thumbName && prev.thumbnail_path !== thumbName) { try { fs.unlinkSync(path.join(config.contentDir, prev.thumbnail_path)); } catch { /* ignore */ } }
      console.log(`HEVC->H.264 transcoded ${contentId} -> ${outName} (${width}x${height}, ${durationSec}s)`);
    } catch (e) {
      console.error(`Failed to update content row after HEVC transcode: ${e.message}`);
      try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch { /* ignore */ }
    }
  });
}

module.exports = { isHeicMime, heicToJpeg, probeVideoCodec, needsHevcTranscode, kickHevcTranscodeIfNeeded, HEIC_MIMES };
