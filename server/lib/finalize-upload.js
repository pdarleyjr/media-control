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
const { resolveUploadMime } = require('../middleware/upload');
const { inspectMediaFile } = require('./media-integrity');
const { getMediaPipeline } = require('./media-pipeline');

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
async function finalizeUpload({
  absPath,
  originalName,
  mimeType,
  size,
  userId,
  workspaceId,
  io,
  pipeline,
  contentDir = config.contentDir,
}) {
  if (!workspaceId) {
    try { fs.unlinkSync(absPath); } catch { /* ignore */ }
    const e = new Error('No workspace context. Switch to a workspace before uploading.');
    e.status = 403;
    throw e;
  }

  const ext = path.extname(originalName || '') || '';
  let mt = resolveUploadMime({ mimetype: mimeType || '', originalname: originalName || '' });
  if (!mt) {
    try { fs.unlinkSync(absPath); } catch { /* ignore */ }
    const e = new Error('Only video, image, PDF, and Office document files are allowed');
    e.status = 415;
    throw e;
  }
  let integrity;
  try {
    integrity = inspectMediaFile({
      filePath: absPath,
      contentDir,
      claimedMime: mt,
      filename: originalName,
    });
  } catch {
    try { fs.unlinkSync(absPath); } catch { /* ignore */ }
    const error = new Error('The resumable upload could not be inspected.');
    error.status = 422;
    error.code = 'MEDIA_VALIDATION_FAILED';
    throw error;
  }
  if (!integrity.ok) {
    try { fs.unlinkSync(absPath); } catch { /* ignore */ }
    const error = new Error(
      integrity.code === 'ACTIVE_CONTENT_REJECTED'
        ? 'Executable HTML, JavaScript, and SVG uploads are not accepted as media.'
        : 'The resumable upload bytes do not match a supported media type.',
    );
    error.status = integrity.code === 'SOURCE_TOO_LARGE' ? 413 : 415;
    error.code = integrity.code;
    throw error;
  }
  mt = integrity.detectedMime;
  size = integrity.size;

  const id = uuidv4();
  let filename = `${id}${ext}`;
  let destPath = path.join(contentDir, filename);

  fs.mkdirSync(contentDir, { recursive: true });
  // Move the assembled file into the content dir. rename() is atomic on the same
  // filesystem; fall back to copy+unlink across devices (tus store and content
  // dir are both under the uploads bind-mount, so rename normally succeeds).
  try {
    await fs.promises.rename(absPath, destPath);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fs.promises.copyFile(absPath, destPath);
    try { await fs.promises.unlink(absPath); } catch { /* ignore */ }
  }

  const mediaPipeline = pipeline || getMediaPipeline({ db, io, contentDir });
  let queued;
  try {
    db.transaction(() => {
      db.prepare(`
        INSERT INTO content (
          id, user_id, workspace_id, filename, filepath, mime_type, file_size,
          processing_status, access_level
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'uploaded', 'private')
      `).run(id, userId, workspaceId, safeFilename(originalName), filename, mt, size || 0);
      queued = mt.startsWith('video/')
        ? mediaPipeline.enqueueVideo({
          contentId: id,
          workspaceId,
          userId,
          absolutePath: destPath,
          expectedVersion: 1,
          expectedFilepath: filename,
          sourceType: 'tus_upload',
        })
        : mediaPipeline.enqueueThumbnailFinalize({
          contentId: id,
          workspaceId,
          userId,
          absolutePath: destPath,
          expectedVersion: 1,
          expectedFilepath: filename,
          mimeType: mt,
          sourceType: 'tus_upload',
        });
    })();
  } catch (error) {
    try { fs.unlinkSync(destPath); } catch { /* ignore */ }
    error.status = error.status || 500;
    throw error;
  }

  return {
    ...db.prepare('SELECT * FROM content WHERE id = ?').get(id),
    media_job: {
      id: queued.job.id,
      status: queued.job.status,
      stage: queued.job.stage,
      progress_pct: queued.job.progress_pct,
    },
  };
}

module.exports = { finalizeUpload };
