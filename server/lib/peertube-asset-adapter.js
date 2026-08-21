'use strict';

const fs = require('fs');
const path = require('path');

const { migrateMediaPipeline } = require('../db/migrations/media-pipeline');
const { mediaLimits } = require('./media-integrity');

const PEERTUBE_UUID = /^[A-Za-z0-9][A-Za-z0-9_-]{5,127}$/;

function peerTubeSourceIdentity(videoUuid) {
  const value = String(videoUuid || '').trim();
  if (!PEERTUBE_UUID.test(value)) throw new Error('invalid_peertube_video_uuid');
  return `peertube:${value}`;
}

function ensurePeerTubeAssetSchema(db) {
  migrateMediaPipeline(db);
  const migrate = db.transaction(() => {
    db.exec(`
      UPDATE content_media_metadata
      SET source_identity=NULL
      WHERE source_type='peertube'
        AND source_identity IS NOT NULL
        AND rowid NOT IN (
          SELECT MIN(rowid)
          FROM content_media_metadata
          WHERE source_type='peertube' AND source_identity IS NOT NULL
          GROUP BY workspace_id, source_type, source_identity
        );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_content_media_peertube_identity
      ON content_media_metadata(workspace_id, source_type, source_identity)
      WHERE source_identity IS NOT NULL AND source_type='peertube';
    `);
  });
  migrate();
  return true;
}

function adapterError(code, message, retryable) {
  const error = new Error(message || code);
  error.code = code;
  error.retryable = retryable === true;
  return error;
}

function safeFilename(contentId) {
  const value = String(contentId || '');
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(value)) throw adapterError(
    'invalid_content_id',
    'Content identity is invalid.',
    false,
  );
  return `${value}.peertube.mp4`;
}

function safeMediaJobId(jobId) {
  const value = String(jobId || '');
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(value)) throw adapterError(
    'invalid_media_job_id',
    'Media job identity is invalid.',
    false,
  );
  return value;
}

function boundedMaxBytes(value) {
  return Math.max(
    1,
    Math.min(Number(value) || mediaLimits().maxSourceBytes, mediaLimits().maxSourceBytes),
  );
}

function markFailure(db, contentId, code, retryable, now) {
  try {
    db.prepare(`
      UPDATE content
      SET processing_status=?, processing_error=?, updated_at=?
      WHERE id=?
    `).run(retryable ? 'processing' : 'failed', code, now, contentId);
  } catch {
    // Preserve the primary adapter failure.
  }
}

function upsertSourceMetadata(db, {
  contentId,
  workspaceId,
  sourceIdentity,
  sourceUrl,
  health,
  now,
}) {
  db.prepare(`
    INSERT INTO content_media_metadata (
      content_id, workspace_id, source_type, source_identity, source_url,
      detected_mime_type, remote_health_status, remote_source_kind,
      remote_last_validated_at, created_at, updated_at
    ) VALUES (?, ?, 'peertube', ?, ?, 'video/mp4', ?, 'classroom_local_derivative', ?, ?, ?)
    ON CONFLICT(content_id) DO UPDATE SET
      workspace_id=excluded.workspace_id,
      source_type='peertube',
      source_identity=excluded.source_identity,
      source_url=excluded.source_url,
      detected_mime_type='video/mp4',
      remote_health_status=excluded.remote_health_status,
      remote_source_kind='classroom_local_derivative',
      remote_last_validated_at=excluded.remote_last_validated_at,
      updated_at=excluded.updated_at
  `).run(
    contentId,
    workspaceId,
    sourceIdentity,
    sourceUrl || null,
    health,
    now,
    now,
    now,
  );
}

function createPeerTubeAssetHandler(options = {}) {
  const db = options.db;
  const contentDir = path.resolve(options.contentDir || '');
  const nowFn = options.now || (() => Math.floor(Date.now() / 1000));
  const fetchPlaybackResponse = options.fetchPlaybackResponse
    || ((replayId, fetchOptions) => require('../services/peertube-replay')
      .fetchPlaybackResponse(replayId, fetchOptions));
  const normalizeVideoJob = options.normalizeVideoJob
    || (job => require('./media-transcode').normalizeVideoJob(job));
  const getIo = options.getIo || (() => options.io || null);
  if (!db || !contentDir) throw new Error('peertube_asset_adapter_configuration_required');
  ensurePeerTubeAssetSchema(db);

  return async function handlePeerTubeAsset(job, context = {}) {
    const now = nowFn();
    const contentId = String(job.content_id || '');
    const replayId = String(job.payload?.replayId || '');
    const sourceIdentity = peerTubeSourceIdentity(job.payload?.videoUuid);
    const maxBytes = boundedMaxBytes(job.payload?.maxBytes);
    const filename = safeFilename(contentId);
    const mediaJobId = safeMediaJobId(job.id);
    const finalPath = path.join(contentDir, filename);
    const partialPath = path.join(contentDir, `.${filename}.${mediaJobId}.partial`);
    let downloaded = false;

    try {
      const row = db.prepare('SELECT * FROM content WHERE id=?').get(contentId);
      if (!row) return { status: 'stale', reason: 'content_missing' };
      if (Number(row.version) !== Number(job.expected_version)) {
        return { status: 'stale', reason: 'content_changed' };
      }
      const resumeExisting = String(row.filepath || '') === filename && fs.existsSync(finalPath);
      if (!resumeExisting && String(row.filepath || '') !== String(job.expected_filepath || '')) {
        return { status: 'stale', reason: 'content_changed' };
      }

      if (!resumeExisting) {
        context.registerArtifact?.(partialPath);
        context.registerArtifact?.(finalPath);
        context.progress?.('validating', 5, { source_type: 'peertube' });
        let response;
        try {
          response = await fetchPlaybackResponse(replayId, { range: null });
        } catch (caught) {
          const status = Number(caught?.status || caught?.code) || 0;
          throw adapterError(
            'peertube_unavailable',
            'PeerTube replay is temporarily unavailable.',
            status === 0 || status === 408 || status === 429 || status >= 500,
          );
        }
        if (!response?.ok || !response.body) {
          const status = Number(response?.status) || 502;
          throw adapterError(
            'peertube_unavailable',
            `PeerTube replay request failed (${status}).`,
            status === 408 || status === 429 || status >= 500,
          );
        }
        const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
        if (contentType && !contentType.startsWith('video/') && contentType !== 'application/octet-stream') {
          throw adapterError(
            'peertube_asset_invalid_type',
            `PeerTube returned ${contentType} instead of video media.`,
            false,
          );
        }
        const declaredRaw = String(response.headers?.get?.('content-length') || '').trim();
        const declared = declaredRaw ? Number(declaredRaw) : null;
        if (Number.isFinite(declared) && declared > maxBytes) {
          throw adapterError(
            'peertube_asset_too_large',
            'PeerTube replay exceeds the configured classroom import limit.',
            false,
          );
        }

        await fs.promises.mkdir(contentDir, { recursive: true });
        const file = await fs.promises.open(partialPath, 'wx');
        let bytes = 0;
        try {
          for await (const rawChunk of response.body) {
            if (context.isCancellationRequested?.()) {
              throw adapterError('media_job_cancelled', 'PeerTube import cancelled.', false);
            }
            const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
            bytes += chunk.length;
            if (bytes > maxBytes) {
              throw adapterError(
                'peertube_asset_too_large',
                'PeerTube replay exceeded the configured classroom import limit.',
                false,
              );
            }
            await file.write(chunk);
            context.progress?.(
              'validating',
              declared ? Math.min(35, 5 + Math.round((bytes / declared) * 30)) : 20,
              { bytes_downloaded: bytes, source_type: 'peertube' },
            );
          }
          await file.sync();
        } finally {
          await file.close();
        }
        if (bytes <= 0) {
          throw adapterError('peertube_asset_empty', 'PeerTube replay is empty.', true);
        }
        if (context.isCancellationRequested?.()) {
          throw adapterError('media_job_cancelled', 'PeerTube import cancelled.', false);
        }
        try {
          await fs.promises.unlink(finalPath);
        } catch (caught) {
          if (caught.code !== 'ENOENT') throw caught;
        }
        await fs.promises.rename(partialPath, finalPath);
        downloaded = true;

        const changed = db.prepare(`
          UPDATE content
          SET filepath=?, remote_url=NULL, mime_type='video/mp4',
              processing_status='processing', processing_error=NULL, updated_at=?
          WHERE id=? AND COALESCE(version,1)=? AND COALESCE(filepath,'')=?
        `).run(filename, now, contentId, job.expected_version, job.expected_filepath || '');
        if (changed.changes !== 1) {
          await fs.promises.unlink(finalPath).catch(() => {});
          return { status: 'stale', reason: 'content_changed' };
        }
        context.releaseArtifact?.(partialPath);
        context.releaseArtifact?.(finalPath);
        upsertSourceMetadata(db, {
          contentId,
          workspaceId: job.workspace_id,
          sourceIdentity,
          sourceUrl: `/api/peertube-replays/${encodeURIComponent(replayId)}/playback`,
          health: 'downloaded',
          now,
        });
      }

      context.progress?.('optimizing', 40, { source_type: 'peertube' });
      const result = await normalizeVideoJob({
        db,
        io: getIo(),
        contentId,
        absPath: finalPath,
        expectedFilepath: filename,
        contentDir,
        staleAbsolutePaths: [],
        registerArtifact: context.registerArtifact,
        releaseArtifact: context.releaseArtifact,
        isCancellationRequested: context.isCancellationRequested,
      });
      if (result?.status === 'failed') {
        throw adapterError(
          result.error || 'peertube_normalization_failed',
          result.error || 'PeerTube classroom normalization failed.',
          true,
        );
      }
      upsertSourceMetadata(db, {
        contentId,
        workspaceId: job.workspace_id,
        sourceIdentity,
        sourceUrl: `/api/peertube-replays/${encodeURIComponent(replayId)}/playback`,
        health: 'localized',
        now: nowFn(),
      });
      return {
        ...result,
        status: result?.status || 'ready',
        source_type: 'peertube',
        source_identity: sourceIdentity,
        classroom_local: true,
        downloaded,
      };
    } catch (caught) {
      try { await fs.promises.unlink(partialPath); } catch { /* no partial */ }
      const failure = caught?.code
        ? caught
        : adapterError('peertube_import_failed', caught?.message || 'PeerTube import failed.', true);
      markFailure(db, contentId, failure.code, failure.retryable, nowFn());
      throw failure;
    }
  };
}

module.exports = {
  createPeerTubeAssetHandler,
  ensurePeerTubeAssetSchema,
  peerTubeSourceIdentity,
};
