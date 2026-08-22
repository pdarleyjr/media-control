'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const config = require('../config');
const { sha256File } = require('./asset-manifest');
const { emitContentUpdated } = require('./content-finalization');
const { mediaLimits } = require('./media-integrity');

const pexecFile = promisify(execFile);
const POSTER_POSITIONS = new Set([
  'center', 'top', 'bottom', 'left', 'right', 'entropy', 'attention',
]);

function safeUnlink(filePath) {
  try { if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { /* best effort */ }
}

function safeContentPath(contentDir, candidate) {
  const root = path.resolve(contentDir);
  const resolved = path.resolve(candidate);
  if (path.dirname(resolved) !== root) throw new Error('thumbnail_path_outside_content_root');
  return resolved;
}

function normalizePosterRequest(input = {}, { isVideo = false, durationSeconds = null } = {}) {
  const position = String(input.position || 'center').toLowerCase();
  if (!POSTER_POSITIONS.has(position)) throw new Error('invalid_poster_position');
  let timestampSeconds = Number(input.timestamp_seconds ?? input.timestampSeconds ?? 0);
  if (!Number.isFinite(timestampSeconds) || timestampSeconds < 0) {
    throw new Error('timestamp_out_of_range');
  }
  if (!isVideo) timestampSeconds = 0;
  if (isVideo && Number.isFinite(Number(durationSeconds)) && Number(durationSeconds) > 0
      && timestampSeconds > Number(durationSeconds)) {
    throw new Error('timestamp_out_of_range');
  }
  return {
    timestampSeconds: Math.round(timestampSeconds * 1000) / 1000,
    position,
  };
}

function buildVideoPosterArgs({ inputPath, outputPath, timestampSeconds = 0 } = {}) {
  if (!inputPath || !outputPath) throw new Error('invalid_video_poster_paths');
  const timestamp = Math.max(0, Number(timestampSeconds) || 0);
  return [
    '-y',
    '-ss', timestamp.toFixed(3),
    '-i', inputPath,
    '-frames:v', '1',
    '-an',
    '-sn',
    '-dn',
    outputPath,
  ];
}

async function createThumbnailCandidate(options = {}) {
  const contentDir = options.contentDir || config.contentDir;
  const contentId = String(options.contentId || '');
  const sourcePath = safeContentPath(contentDir, options.sourcePath);
  const customPosterPath = options.customPosterPath
    ? safeContentPath(contentDir, options.customPosterPath)
    : null;
  const request = normalizePosterRequest(options, {
    isVideo: options.isVideo === true,
    durationSeconds: options.durationSeconds,
  });
  const makeUuid = options.uuid || randomUUID;
  const run = options.execFile || pexecFile;
  const sharp = options.sharp || require('sharp');
  const token = String(makeUuid()).replace(/[^a-zA-Z0-9_-]/g, '');
  const framePath = path.join(contentDir, `poster_frame_${contentId}_${token}.png`);
  const partPath = path.join(contentDir, `thumb_${contentId}_${token}.part.jpg`);
  const thumbnailFilename = `thumb_${contentId}_${token}.jpg`;
  const thumbnailPath = path.join(contentDir, thumbnailFilename);
  for (const artifact of [framePath, partPath, thumbnailPath]) {
    if (typeof options.registerArtifact === 'function') options.registerArtifact(artifact);
  }
  let imageSource = customPosterPath || sourcePath;
  try {
    if (!customPosterPath && options.isVideo === true) {
      await run(
        'ffmpeg',
        buildVideoPosterArgs({
          inputPath: sourcePath,
          outputPath: framePath,
          timestampSeconds: request.timestampSeconds,
        }),
        {
          timeout: 30000,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        },
      );
      imageSource = framePath;
    }
    const width = Math.max(320, Math.min(Number(config.thumbnailWidth) || 640, 1920));
    const height = Math.round(width * 9 / 16);
    await sharp(imageSource, {
      limitInputPixels: mediaLimits().maxImagePixels,
      failOn: 'error',
    })
      .rotate()
      .resize({
        width,
        height,
        fit: 'cover',
        position: request.position,
        withoutEnlargement: false,
      })
      .jpeg({ quality: 82, progressive: true })
      .toFile(partPath);
    const stat = fs.statSync(partPath);
    if (!stat.isFile() || stat.size <= 0) throw new Error('thumbnail_candidate_empty');
    fs.renameSync(partPath, thumbnailPath);
    return {
      thumbnailPath,
      thumbnailFilename,
      position: request.position,
      timestampSeconds: request.timestampSeconds,
      provenance: customPosterPath
        ? `custom_upload:${request.position}`
        : options.isVideo
          ? `video_timestamp:${request.timestampSeconds}:${request.position}`
          : `image_crop:${request.position}`,
    };
  } catch (error) {
    safeUnlink(partPath);
    safeUnlink(thumbnailPath);
    throw error;
  } finally {
    safeUnlink(framePath);
  }
}

async function commitThumbnail(options = {}) {
  const {
    db,
    io,
    contentId,
    expectedFilepath,
    expectedVersion,
    expectedSourceSha256,
    thumbnailPath,
    thumbnailFilename,
    provenance,
  } = options;
  const contentDir = options.contentDir || config.contentDir;
  const hashFile = options.sha256File || sha256File;
  const now = (options.now || (() => Math.floor(Date.now() / 1000)))();
  if (!db || !contentId || !thumbnailPath || !thumbnailFilename || !expectedFilepath) {
    safeUnlink(thumbnailPath);
    throw new Error('invalid_thumbnail_commit');
  }
  const candidate = safeContentPath(contentDir, thumbnailPath);
  const sourcePath = safeContentPath(contentDir, path.join(contentDir, path.basename(expectedFilepath)));
  if (!fs.existsSync(candidate)) {
    throw new Error('invalid_thumbnail_commit');
  }
  const sourceHash = await hashFile(sourcePath);
  if (sourceHash !== expectedSourceSha256) {
    safeUnlink(candidate);
    return { status: 'stale', reason: 'source_hash_changed', content_id: contentId };
  }
  const before = db.prepare('SELECT * FROM content WHERE id=?').get(contentId);
  if (!before
      || String(before.filepath) !== String(expectedFilepath)
      || Number(before.version || 1) !== Number(expectedVersion || 1)) {
    safeUnlink(candidate);
    return { status: 'stale', reason: 'content_changed', content_id: contentId };
  }
  let generation = 1;
  let rejectedReason = 'content_changed';
  const committed = db.transaction(() => {
    try {
      const erasing = db.prepare(`SELECT 1 FROM content_erase_operations
        WHERE content_id=? AND state IN ('prepared','staged','catalog_committed','cleanup_pending','recovery_failed')
        LIMIT 1`).get(contentId);
      if (erasing) {
        rejectedReason = 'erase_in_progress';
        return false;
      }
    } catch (error) {
      if (!/no such table/i.test(error.message)) throw error;
    }
    const currentMetadata = db.prepare(
      'SELECT thumbnail_generation FROM content_media_metadata WHERE content_id=?',
    ).get(contentId);
    generation = Math.max(0, Number(currentMetadata?.thumbnail_generation) || 0) + 1;
    const updated = db.prepare(`
      UPDATE content SET thumbnail_path=?, updated_at=?
      WHERE id=? AND filepath=? AND COALESCE(version, 1)=?
    `).run(
      thumbnailFilename,
      now,
      contentId,
      expectedFilepath,
      Math.max(1, Number(expectedVersion) || 1),
    );
    if (!updated.changes) return false;
    db.prepare(`
      INSERT INTO content_media_metadata (
        content_id, workspace_id, thumbnail_generation,
        thumbnail_source_sha256, thumbnail_source_filepath,
        thumbnail_provenance, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(content_id) DO UPDATE SET
        thumbnail_generation=excluded.thumbnail_generation,
        thumbnail_source_sha256=excluded.thumbnail_source_sha256,
        thumbnail_source_filepath=excluded.thumbnail_source_filepath,
        thumbnail_provenance=excluded.thumbnail_provenance,
        updated_at=excluded.updated_at
    `).run(
      contentId,
      before.workspace_id || null,
      generation,
      sourceHash,
      expectedFilepath,
      String(provenance || 'manual'),
      now,
      now,
    );
    try {
      db.prepare('UPDATE asset_checksums SET poster_path=? WHERE content_id=?')
        .run(thumbnailFilename, contentId);
    } catch (error) {
      if (!/no such table/i.test(error.message)) throw error;
    }
    return true;
  })();
  if (!committed) {
    safeUnlink(candidate);
    return { status: 'stale', reason: rejectedReason, content_id: contentId };
  }
  if (before.thumbnail_path && before.thumbnail_path !== thumbnailFilename) {
    safeUnlink(safeContentPath(
      contentDir,
      path.join(contentDir, path.basename(before.thumbnail_path)),
    ));
  }
  const row = db.prepare('SELECT * FROM content WHERE id=?').get(contentId);
  emitContentUpdated(io, row, Number(row.version) || 1);
  return {
    status: 'ready',
    content_id: contentId,
    thumbnail_path: thumbnailFilename,
    thumbnail_generation: generation,
    thumbnail_provenance: String(provenance || 'manual'),
  };
}

module.exports = {
  POSTER_POSITIONS,
  buildVideoPosterArgs,
  commitThumbnail,
  createThumbnailCandidate,
  normalizePosterRequest,
};
