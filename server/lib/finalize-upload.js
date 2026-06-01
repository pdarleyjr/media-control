// Shared "an uploaded file just landed on disk → make it a content row" finalizer.
// Used by the tus resumable upload route (routes/tus.js). Mirrors the metadata +
// thumbnail + INSERT logic of the multipart path in routes/content.js so both
// upload mechanisms produce identical content rows. Kept standalone (not a
// refactor of content.js) so the proven multipart path is untouched.
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const config = require('../config');
const { sanitizeString } = require('../middleware/sanitize');

// Same filename hygiene as content.js: NFC-normalize (macOS sends NFD) then
// HTML-escape & < > " ' so a hostile filename renders as text in every UI sink.
function safeFilename(name) {
  return sanitizeString((name || '').normalize('NFC'));
}

/**
 * Move an assembled upload into the content dir and create its content row.
 * @param {object} o
 * @param {string} o.absPath      absolute path to the fully-uploaded file (e.g. the tus store object)
 * @param {string} o.originalName client-supplied filename (for display + extension)
 * @param {string} o.mimeType     MIME type
 * @param {number} o.size         byte size
 * @param {string} o.userId       owner user id
 * @param {string} o.workspaceId  owning workspace (required — content is workspace-scoped)
 * @returns {Promise<object>} the inserted content row
 */
async function finalizeUpload({ absPath, originalName, mimeType, size, userId, workspaceId }) {
  if (!workspaceId) {
    try { fs.unlinkSync(absPath); } catch { /* ignore */ }
    const e = new Error('No workspace context. Switch to a workspace before uploading.');
    e.status = 403;
    throw e;
  }

  const ext = path.extname(originalName || '') || '';
  const id = uuidv4();
  const filename = `${id}${ext}`;
  const destPath = path.join(config.contentDir, filename);

  fs.mkdirSync(config.contentDir, { recursive: true });
  // Move the assembled file into the content dir. rename() is atomic on the same
  // filesystem; fall back to copy+unlink across devices (tus store and content
  // dir are both under the uploads bind-mount, so rename normally succeeds).
  try {
    fs.renameSync(absPath, destPath);
  } catch (e) {
    fs.copyFileSync(absPath, destPath);
    try { fs.unlinkSync(absPath); } catch { /* ignore */ }
  }

  let width = null, height = null, durationSec = null, thumbnailPath = null;
  const mt = mimeType || 'application/octet-stream';
  try {
    if (mt.startsWith('image/')) {
      const sharp = require('sharp');
      const sharpOpts = { limitInputPixels: false, failOn: 'none' };
      try {
        const metadata = await sharp(destPath, sharpOpts).metadata();
        width = metadata.width; height = metadata.height;
      } catch (e) { console.warn('finalizeUpload sharp metadata (non-fatal):', e.message); }
      try {
        thumbnailPath = `thumb_${filename}`;
        await sharp(destPath, sharpOpts).resize(config.thumbnailWidth).jpeg({ quality: 70 })
          .toFile(path.join(config.contentDir, thumbnailPath));
      } catch (e) { console.warn('finalizeUpload sharp thumbnail (non-fatal):', e.message); thumbnailPath = null; }
    } else if (mt.startsWith('video/')) {
      try {
        const { execFileSync } = require('child_process');
        // 30s budget — large 4K/ultra-wide masters take longer to probe than the
        // 15s used on the small multipart path.
        const probe = execFileSync('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', destPath],
          { timeout: 30000 }).toString();
        const info = JSON.parse(probe);
        if (info.format && info.format.duration) durationSec = parseFloat(info.format.duration);
        const vs = info.streams && info.streams.find(s => s.codec_type === 'video');
        if (vs) { width = vs.width; height = vs.height; }
        thumbnailPath = `thumb_${filename.replace(/\.[^.]+$/, '.jpg')}`;
        try {
          execFileSync('ffmpeg', ['-y', '-i', destPath, '-ss', '2', '-vframes', '1', '-vf', `scale=${config.thumbnailWidth}:-1`, path.join(config.contentDir, thumbnailPath)],
            { timeout: 30000 });
        } catch { thumbnailPath = null; }
      } catch (e) { console.warn('finalizeUpload ffprobe (non-fatal):', e.message); }
    }
  } catch (e) { console.warn('finalizeUpload metadata (non-fatal):', e.message); }

  db.prepare(`
    INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size, duration_sec, thumbnail_path, width, height)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, workspaceId, safeFilename(originalName), filename, mt, size || 0, durationSec, thumbnailPath, width, height);

  return db.prepare('SELECT * FROM content WHERE id = ?').get(id);
}

module.exports = { finalizeUpload };
