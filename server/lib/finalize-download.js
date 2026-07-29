// REPAIR 3: a completed yt-dlp download must become a reachable content row.
// The download worker (routes/downloads.js) writes the file to
// config.contentDir/<jobId>.<ext> and marks the job 'done', but historically
// never inserted a `content` row — so the file was an ORPHAN (invisible to the
// Media Library, playlists, and broadcast). This finalizer closes that gap.
//
// The download file already lives IN config.contentDir (unlike an upload, which
// gets MOVED there by finalizeUpload). So we can't reuse finalizeUpload's
// rename step — instead we MIRROR its INSERT against the SAME existing `content`
// columns (id, user_id, workspace_id, filename, filepath, mime_type, file_size,
// duration_sec, thumbnail_path, width, height) so a downloaded item looks exactly
// like an uploaded one to every consumer. No schema change.
//
// The pure row-builder (buildContentRowForDownload) is unit-tested; finalizeDownload
// is the DB-touching orchestrator that is idempotent on re-poll.
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { inspectMediaFile } = require('./media-integrity');
const { getMediaPipeline } = require('./media-pipeline');

// yt-dlp emits whatever container it muxed to (mp4 by default here, but
// 'mp4/best' can fall back to webm/mkv). Map the on-disk extension to a sane
// mime so the player picks the right renderer. Unknown → generic video (the
// downloader only pulls A/V), never application/octet-stream which the player
// can't render.
const EXT_MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function mimeFromExt(ext) {
  return EXT_MIME[String(ext || '').toLowerCase()] || 'video/mp4';
}

/**
 * PURE: build the field values for the content row a completed download yields.
 * No DB, no filesystem — given a job + the resolved on-disk file, return exactly
 * what gets INSERTed. Keeps the row's workspace/user scoping identical to the
 * job's, so the downloaded item is owned by (and visible to) the requester.
 *
 * @param {object} o
 * @param {object} o.job        the download_jobs row ({ id, workspace_id, user_id, title, source_url })
 * @param {string} o.filename   resolved on-disk basename in contentDir (e.g. '<jobId>.mp4')
 * @param {string} [o.mimeType] override mime; defaults to mimeFromExt(extname(filename))
 * @param {number} [o.size]     byte size (0 when unknown)
 * @param {string} [o.contentId] explicit content id (defaults to a fresh uuid)
 * @returns {{ id, user_id, workspace_id, filename, filepath, mime_type, file_size }}
 */
function buildContentRowForDownload({ job, filename, mimeType, size, contentId }) {
  if (!job || !job.id) throw new Error('buildContentRowForDownload: job with id is required');
  if (!job.workspace_id) throw new Error('buildContentRowForDownload: job.workspace_id is required (content is workspace-scoped)');
  if (!filename) throw new Error('buildContentRowForDownload: resolved filename is required');

  const ext = path.extname(filename);
  // Display name: prefer the user-supplied title, else the source filename.
  const displayName = (job.title && String(job.title).trim()) || filename;

  return {
    id: contentId || uuidv4(),
    user_id: job.user_id,
    workspace_id: job.workspace_id,
    // filename is the human-facing display name; filepath is the on-disk
    // basename relative to contentDir (matches uploads + the YouTube transcode).
    filename: displayName,
    filepath: filename,
    mime_type: mimeType || mimeFromExt(ext),
    file_size: Number.isFinite(size) && size > 0 ? size : 0,
  };
}

/**
 * Resolve the file yt-dlp actually wrote for a job. The worker uses an output
 * template of `<jobId>.%(ext)s`, so the finished basename is `<jobId>.<ext>`
 * with an unpredictable extension — find it by listing contentDir. Returns the
 * basename (relative to contentDir) or null if nothing matched.
 */
function resolveDownloadedFile(contentDir, jobId) {
  let names;
  try { names = fs.readdirSync(contentDir); } catch { return null; }
  const prefix = jobId + '.';
  // Ignore any thumb_/partial artifacts; pick the first real media file for the job.
  const match = names.find((n) => n.startsWith(prefix) && !n.endsWith('.part') && !n.startsWith('thumb_'));
  return match || null;
}

/**
 * Idempotently turn a completed download job into a reachable content row.
 * Safe to call more than once (e.g. a re-poll): if the job already has a
 * content_id it is a no-op and returns the existing row.
 *
 * @param {object} deps
 * @param {import('better-sqlite3').Database} deps.db
 * @param {string} deps.contentDir  config.contentDir
 * @param {string} deps.jobId
 * @returns {object|null} the content row, or null if the file couldn't be resolved
 */
function finalizeDownload({ db, contentDir, jobId, pipeline }) {
  const job = db.prepare('SELECT * FROM download_jobs WHERE id = ?').get(jobId);
  if (!job) return null;

  // Idempotency: already finalized → return the existing content row, don't re-insert.
  if (job.content_id) {
    return db.prepare('SELECT * FROM content WHERE id = ?').get(job.content_id) || null;
  }

  const filename = resolveDownloadedFile(contentDir, jobId);
  if (!filename) return null;

  let size = 0;
  try { size = fs.statSync(path.join(contentDir, filename)).size; } catch { /* keep 0 */ }

  const absolutePath = path.join(contentDir, filename);
  const integrity = inspectMediaFile({
    filePath: absolutePath,
    contentDir,
    claimedMime: mimeFromExt(path.extname(filename)),
    filename,
  });
  if (!integrity.ok) {
    db.prepare(`
      UPDATE download_jobs
      SET status='error', error_msg=?
      WHERE id=? AND content_id IS NULL
    `).run(`Downloaded bytes failed media validation: ${integrity.code}`, jobId);
    return null;
  }
  const row = buildContentRowForDownload({
    job,
    filename,
    size,
    mimeType: integrity.detectedMime,
  });
  const mediaPipeline = pipeline || getMediaPipeline({ db, contentDir });
  let queued;

  // Single synchronous transaction: insert the content row + link it back onto
  // the job. The job-side guard (content_id IS NULL) keeps a concurrent/replayed
  // call from double-inserting; if it didn't take, roll back the content insert.
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size, access_level)
      VALUES (@id, @user_id, @workspace_id, @filename, @filepath, @mime_type, @file_size, 'private')
    `).run(row);
    const res = db.prepare('UPDATE download_jobs SET content_id = ?, local_path = ? WHERE id = ? AND content_id IS NULL')
      .run(row.id, filename, jobId);
    if (res.changes === 0) {
      // Lost the race — another finalize already linked a row. Undo ours.
      db.prepare('DELETE FROM content WHERE id = ?').run(row.id);
      return null;
    }
    try {
      db.prepare(`
        UPDATE content SET processing_status='uploaded' WHERE id=?
      `).run(row.id);
      db.prepare(`
        INSERT INTO content_media_metadata (
          content_id, workspace_id, source_type, source_identity, source_url,
          detected_mime_type, remote_health_status, remote_source_kind,
          created_at, updated_at
        ) VALUES (?, ?, 'legacy_url_download', ?, ?, ?, 'localized',
          'imported_local', strftime('%s','now'), strftime('%s','now'))
      `).run(row.id, row.workspace_id, job.source_url, job.source_url, row.mime_type);
    } catch (error) {
      if (!/no such table|no such column/i.test(error.message)) throw error;
    }
    queued = row.mime_type.startsWith('video/')
      ? mediaPipeline.enqueueVideo({
        contentId: row.id,
        workspaceId: row.workspace_id,
        userId: row.user_id,
        absolutePath,
        expectedVersion: 1,
        expectedFilepath: row.filepath,
        sourceType: 'legacy_url_download',
      })
      : mediaPipeline.enqueueThumbnailFinalize({
        contentId: row.id,
        workspaceId: row.workspace_id,
        userId: row.user_id,
        absolutePath,
        expectedVersion: 1,
        expectedFilepath: row.filepath,
        mimeType: row.mime_type,
        sourceType: 'legacy_url_download',
      });
    return row.id;
  });

  const insertedId = tx();
  const finalId = insertedId || db.prepare('SELECT content_id FROM download_jobs WHERE id = ?').get(jobId)?.content_id;
  if (!finalId) return null;
  const content = db.prepare('SELECT * FROM content WHERE id = ?').get(finalId);
  return queued ? {
    ...content,
    media_job: {
      id: queued.job.id,
      status: queued.job.status,
      stage: queued.job.stage,
      progress_pct: queued.job.progress_pct,
    },
  } : content;
}

module.exports = { buildContentRowForDownload, mimeFromExt, resolveDownloadedFile, finalizeDownload };
