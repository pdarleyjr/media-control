'use strict';

const fs = require('fs');
const path = require('path');
const { sha256File, upsertAssetManifest } = require('./asset-manifest');

const finalizationFlights = new Map();

function safeUnlink(filePath, fileSystem = fs) {
  if (!filePath) return;
  try {
    if (fileSystem.existsSync(filePath)) fileSystem.unlinkSync(filePath);
  } catch (_) {
    // Cleanup is best effort. The authoritative row and immutable manifest have
    // already been committed before stale source cleanup is attempted.
  }
}

function emitContentUpdated(io, row, generation) {
  if (!io || typeof io.of !== 'function' || !row || !row.workspace_id) return false;
  try {
    io.of('/dashboard')
      .to(`workspace:${row.workspace_id}`)
      .emit('content-updated', {
        content_id: row.id,
        processing_status: 'ready',
        version: generation,
        generation,
      });
    return true;
  } catch (_) {
    return false;
  }
}

async function defaultPrewarm(io, db, item) {
  const { emitContentPrewarm } = require('./node-registry');
  return emitContentPrewarm(io, db, { item, allowWorkspaceOwned: true });
}

async function runFinalization(options) {
  const db = options.db;
  const contentId = String(options.contentId || '');
  const expectedFilepath = String(options.expectedFilepath || '');
  const candidatePath = options.candidatePath;
  const finalPath = options.finalPath || candidatePath;
  const finalFilepath = String(options.finalFilepath || path.basename(finalPath || ''));
  const fileSystem = options.fs || fs;
  const hashFile = options.sha256File || sha256File;
  const metadata = options.metadata || {};
  const now = Number(options.now) || Math.floor(Date.now() / 1000);

  if (!db || !contentId || !expectedFilepath || !candidatePath || !finalPath || !finalFilepath) {
    throw new Error('invalid_content_finalization');
  }
  let row = db.prepare('SELECT * FROM content WHERE id = ?').get(contentId);
  if (!row || row.filepath !== expectedFilepath
    || (options.expectedVersion != null && Number(row.version) !== Number(options.expectedVersion))) {
    if (candidatePath !== finalPath) safeUnlink(candidatePath, fileSystem);
    for (const discardPath of options.discardPathsOnStale || []) safeUnlink(discardPath, fileSystem);
    return { status: 'stale', content_id: contentId };
  }

  const stat = fileSystem.statSync(candidatePath);
  if (!stat.isFile() || stat.size <= 0) throw new Error('final_asset_empty');
  const sha256 = await hashFile(candidatePath);
  if (!/^[0-9a-f]{64}$/i.test(String(sha256 || ''))) throw new Error('final_asset_checksum_invalid');
  const generation = Math.max(1, Number(row.version) || 1) + 1;
  const candidateMoved = path.resolve(candidatePath) !== path.resolve(finalPath);

  if (candidateMoved) {
    fileSystem.renameSync(candidatePath, finalPath);
  }

  let item;
  try {
    const commit = db.transaction(() => {
      const result = db.prepare(`
        UPDATE content
        SET filepath=?, mime_type=?, file_size=?, duration_sec=?, width=?, height=?,
            thumbnail_path=COALESCE(?, thumbnail_path),
            original_filepath=COALESCE(original_filepath, ?),
            original_sha256=COALESCE(?, original_sha256),
            processing_status='ready', processing_error=NULL, media_probe_json=?,
            version=?, updated_at=?
        WHERE id=? AND filepath=? AND COALESCE(version, 1)=?
      `).run(
        finalFilepath,
        metadata.mimeType || row.mime_type || 'application/octet-stream',
        stat.size,
        metadata.durationSec ?? row.duration_sec ?? null,
        metadata.width ?? row.width ?? null,
        metadata.height ?? row.height ?? null,
        metadata.thumbnailPath || null,
        metadata.originalFilepath || expectedFilepath,
        metadata.originalSha256 || null,
        metadata.probe ? JSON.stringify(metadata.probe) : row.media_probe_json || null,
        generation,
        now,
        contentId,
        expectedFilepath,
        Math.max(1, Number(row.version) || 1),
      );
      if (!result.changes) return null;

      try {
        db.prepare(`
          UPDATE content_publication_requests
          SET status='cancelled', decided_by=NULL,
              decision_reason='Normalized asset changed after review was requested',
              decided_at=?, updated_at=?
          WHERE content_id=? AND status='pending'
        `).run(now, now, contentId);
      } catch (_) {
        // Some lightweight test/upgrade databases do not have publication
        // requests yet; asset publication must not depend on that optional table.
      }

      return upsertAssetManifest(db, contentId, {
        generation,
        sha256,
        size_bytes: stat.size,
        canonical_path: finalFilepath,
        poster_path: metadata.thumbnailPath || row.thumbnail_path || null,
        duration_sec: metadata.durationSec ?? row.duration_sec ?? null,
        width: metadata.width ?? row.width ?? null,
        height: metadata.height ?? row.height ?? null,
        computed_at: now,
      });
    });
    item = commit();
  } catch (error) {
    if (candidateMoved) safeUnlink(finalPath, fileSystem);
    throw error;
  }

  if (!item) {
    if (candidateMoved) safeUnlink(finalPath, fileSystem);
    for (const discardPath of options.discardPathsOnStale || []) safeUnlink(discardPath, fileSystem);
    return { status: 'stale', content_id: contentId };
  }

  row = db.prepare('SELECT * FROM content WHERE id = ?').get(contentId);
  emitContentUpdated(options.io, row, generation);

  let prewarm = { requested: false, reason: 'prewarm_unavailable' };
  try {
    const prewarmContent = options.prewarmContent || defaultPrewarm;
    prewarm = await prewarmContent(options.io, db, item) || prewarm;
  } catch (error) {
    prewarm = { requested: false, reason: 'prewarm_error', error: error.message };
  }

  const protectedPaths = new Set([path.resolve(finalPath)]);
  for (const stalePath of options.staleAbsolutePaths || []) {
    if (stalePath && !protectedPaths.has(path.resolve(stalePath))) safeUnlink(stalePath, fileSystem);
  }

  return {
    status: 'ready',
    content_id: contentId,
    generation,
    item,
    prewarm,
  };
}

function finalizeContentAsset(options = {}) {
  const contentId = String(options.contentId || '');
  if (!contentId) return Promise.reject(new Error('content_id_required'));
  const key = [
    contentId,
    String(options.expectedVersion ?? ''),
    String(options.expectedFilepath || ''),
  ].join(':');
  if (finalizationFlights.has(key)) return finalizationFlights.get(key);
  const flight = runFinalization(options)
    .finally(() => {
      if (finalizationFlights.get(key) === flight) finalizationFlights.delete(key);
    });
  finalizationFlights.set(key, flight);
  return flight;
}

module.exports = {
  emitContentUpdated,
  finalizeContentAsset,
};
