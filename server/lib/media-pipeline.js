'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { randomUUID } = require('crypto');
const config = require('../config');
const { migrateMediaPipeline } = require('../db/migrations/media-pipeline');
const { MediaJobStore, MediaJobWorker } = require('./media-jobs');
const { sha256File } = require('./asset-manifest');
const { emitContentUpdated, finalizeContentAsset } = require('./content-finalization');
const { generateDocThumbnail, isDocThumbnailMime } = require('./doc-thumbnail');
const { mediaLimits } = require('./media-integrity');
const {
  commitThumbnail,
  createThumbnailCandidate,
  normalizePosterRequest,
} = require('./thumbnail-studio');
const { validateRemoteMedia } = require('./remote-media');
const { assertRemoteUrlSafe } = require('./ssrf-policy');
const {
  createPeerTubeAssetHandler,
  peerTubeSourceIdentity,
} = require('./peertube-asset-adapter');

const pexecFile = promisify(execFile);
const PIPELINES = new WeakMap();
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const DEFAULT_DISK_HEADROOM_BYTES = 1024 * 1024 * 1024;
const DEFAULT_YOUTUBE_RESERVATION_BYTES = 2 * 1024 * 1024 * 1024;

function normalizeYoutubeId(input) {
  const raw = String(input || '').trim();
  if (YOUTUBE_ID.test(raw)) return raw;
  let parsed;
  try { parsed = new URL(raw); } catch { return null; }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  let id = null;
  if (host === 'youtu.be') id = parsed.pathname.split('/').filter(Boolean)[0] || null;
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    if (parsed.pathname === '/watch') id = parsed.searchParams.get('v');
    else {
      const match = parsed.pathname.match(/^\/(?:embed|v|shorts)\/([A-Za-z0-9_-]{11})(?:\/|$)/);
      id = match && match[1];
    }
  }
  return YOUTUBE_ID.test(String(id || '')) ? id : null;
}

function youtubeSourceIdentity(videoId) {
  const normalized = normalizeYoutubeId(videoId);
  if (!normalized) throw new Error('invalid_youtube_id');
  return `youtube:${normalized}`;
}

function buildYoutubeDownloadArgs({
  videoId,
  outputPath,
  maxHeight = 1080,
  maxBytes = mediaLimits().maxSourceBytes,
} = {}) {
  const normalized = normalizeYoutubeId(videoId);
  if (!normalized || !outputPath) throw new Error('invalid_youtube_download');
  const height = Math.max(360, Math.min(Number(maxHeight) || 1080, 1080));
  const format = [
    `bv*[height<=${height}][vcodec^=avc1]+ba[acodec^=mp4a]`,
    `b[height<=${height}][vcodec^=avc1]`,
    `bv*[height<=${height}]+ba`,
    `b[height<=${height}]`,
  ].join('/');
  return [
    '-f', format,
    '-S', `res:${height},vcodec:h264,acodec:aac,ext:mp4`,
    '--merge-output-format', 'mp4',
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '--concurrent-fragments', '1',
    '--socket-timeout', '30',
    '--retries', '3',
    '--fragment-retries', '3',
    '--max-filesize', String(Math.max(1, Number(maxBytes) || mediaLimits().maxSourceBytes)),
    '-o', outputPath,
    `https://www.youtube.com/watch?v=${normalized}`,
  ];
}

function buildUrlDownloadArgs({
  url,
  outputPath,
  maxHeight = 1080,
  maxBytes = mediaLimits().maxSourceBytes,
} = {}) {
  let parsed;
  try { parsed = new URL(String(url || '')); } catch { throw new Error('invalid_download_url'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || !outputPath) {
    throw new Error('invalid_download_url');
  }
  const height = Math.max(360, Math.min(Number(maxHeight) || 1080, 1080));
  const format = [
    `bv*[height<=${height}][vcodec^=avc1]+ba[acodec^=mp4a]`,
    `b[height<=${height}][vcodec^=avc1]`,
    `bv*[height<=${height}]+ba`,
    `b[height<=${height}]`,
  ].join('/');
  return [
    '--no-config',
    '-f', format,
    '-S', `res:${height},vcodec:h264,acodec:aac,ext:mp4`,
    '--merge-output-format', 'mp4',
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '--concurrent-fragments', '1',
    '--socket-timeout', '30',
    '--retries', '3',
    '--fragment-retries', '3',
    '--max-filesize', String(Math.max(1, Number(maxBytes) || mediaLimits().maxSourceBytes)),
    '-o', outputPath,
    parsed.toString(),
  ];
}

function safeUnlink(filePath) {
  try { if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { /* best effort */ }
}

function availableDiskBytes(directory, statfs = fs.statfsSync) {
  try {
    const stat = statfs(directory);
    const available = BigInt(stat.bavail) * BigInt(stat.bsize);
    return available > BigInt(Number.MAX_SAFE_INTEGER)
      ? Number.MAX_SAFE_INTEGER
      : Number(available);
  } catch {
    return null;
  }
}

function sourceSize(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? stat.size : 0;
  } catch {
    return 0;
  }
}

function boundedReservation(value, fallback) {
  return Math.max(0, Math.min(
    Number(value) || fallback,
    mediaLimits().maxSourceBytes,
  ));
}

function safeContentPath(contentDir, candidate) {
  const root = path.resolve(contentDir);
  const resolved = path.resolve(candidate);
  if (path.dirname(resolved) !== root) {
    const error = new Error('media_path_outside_content_root');
    error.code = 'path_outside_content_directory';
    error.retryable = false;
    throw error;
  }
  return resolved;
}

function errorWith(code, message, retryable = true) {
  const error = new Error(message || code);
  error.code = code;
  error.retryable = retryable;
  return error;
}

class MediaPipeline {
  constructor(options = {}) {
    this.db = options.db;
    this.io = options.io || null;
    this.contentDir = options.contentDir || config.contentDir;
    this.execFile = options.execFile || pexecFile;
    this.normalizeVideoJob = options.normalizeVideoJob || null;
    this.createThumbnailStudioCandidate = options.createThumbnailStudioCandidate
      || createThumbnailCandidate;
    this.urlSafetyCheck = options.urlSafetyCheck || assertRemoteUrlSafe;
    this.now = options.now || (() => Math.floor(Date.now() / 1000));
    this.uuid = options.uuid || randomUUID;
    migrateMediaPipeline(this.db);
    this.store = options.store || new MediaJobStore(this.db, {
      now: this.now,
      uuid: this.uuid,
    });
    this.peerTubeAssetHandler = options.peerTubeAssetHandler || createPeerTubeAssetHandler({
      db: this.db,
      contentDir: this.contentDir,
      normalizeVideoJob: this.normalizeVideoJob,
      getIo: () => this.io,
    });
    this.worker = new MediaJobWorker({
      store: this.store,
      workerId: options.workerId || `media-pipeline:${process.pid}`,
      concurrency: Math.max(1, Math.min(Number(process.env.MEDIA_JOB_CONCURRENCY) || 1, 4)),
      leaseSeconds: Math.max(60, Number(process.env.MEDIA_JOB_LEASE_SECONDS) || 600),
      handlers: {
        video_normalize: (job, context) => this._handleVideo(job, context),
        thumbnail_finalize: (job, context) => this._handleThumbnailFinalize(job, context),
        thumbnail_studio: (job, context) => this._handleThumbnailStudio(job, context),
        youtube_ingest: (job, context) => this._handleYoutube(job, context),
        url_download: (job, context) => this._handleUrlDownload(job, context),
        remote_validate: (job, context) => this._handleRemote(job, context),
        peertube_localize: (job, context) => this._handlePeerTube(job, context),
      },
    });
    this._drainFlight = null;
    this._retryTimer = null;
  }

  setIo(io) {
    if (io) this.io = io;
  }

  enqueue(input) {
    const result = this.store.enqueue(input);
    this.schedule();
    return result;
  }

  enqueueVideo({
    contentId,
    workspaceId,
    userId,
    absolutePath,
    expectedVersion,
    expectedFilepath,
    staleAbsolutePaths,
    sourceType = 'upload',
    idempotencyKey,
  }) {
    const reservation = boundedReservation(
      Math.ceil(sourceSize(absolutePath) * 1.25),
      64 * 1024 * 1024,
    );
    return this.enqueue({
      contentId,
      workspaceId,
      userId,
      jobType: 'video_normalize',
      sourceType,
      idempotencyKey: idempotencyKey || `video:${contentId}:v${expectedVersion}:${expectedFilepath}`,
      expectedVersion,
      expectedFilepath,
      reservedBytes: reservation,
      payload: {
        absolutePath,
        staleAbsolutePaths: staleAbsolutePaths || [],
      },
    });
  }

  enqueueThumbnailFinalize({
    contentId,
    workspaceId,
    userId,
    absolutePath,
    expectedVersion,
    expectedFilepath,
    mimeType,
    sourceType = 'upload',
    staleAbsolutePaths,
    idempotencyKey,
  }) {
    const reservation = boundedReservation(
      Math.ceil(sourceSize(absolutePath) * 0.5),
      32 * 1024 * 1024,
    );
    return this.enqueue({
      contentId,
      workspaceId,
      userId,
      jobType: 'thumbnail_finalize',
      sourceType,
      idempotencyKey: idempotencyKey || `finalize:${contentId}:v${expectedVersion}:${expectedFilepath}`,
      expectedVersion,
      expectedFilepath,
      reservedBytes: reservation,
      payload: {
        absolutePath,
        mimeType,
        staleAbsolutePaths: staleAbsolutePaths || [],
      },
    });
  }

  enqueueThumbnailStudio({
    contentId,
    workspaceId,
    userId,
    expectedVersion,
    expectedFilepath,
    timestampSeconds = 0,
    position = 'center',
    customPosterPath = null,
    sourceType = 'thumbnail_studio',
    idempotencyKey,
  }) {
    return this.enqueue({
      contentId,
      workspaceId,
      userId,
      jobType: 'thumbnail_studio',
      sourceType,
      idempotencyKey: idempotencyKey
        || `thumbnail-studio:${contentId}:v${expectedVersion}:${this.uuid()}`,
      expectedVersion,
      expectedFilepath,
      reservedBytes: 32 * 1024 * 1024,
      payload: {
        timestampSeconds,
        position,
        customPosterPath,
      },
      maxAttempts: 3,
    });
  }

  enqueueYoutube({
    contentId,
    workspaceId,
    userId,
    videoId,
    expectedVersion,
    expectedFilepath = '',
  }) {
    const identity = youtubeSourceIdentity(videoId);
    const maxBytes = boundedReservation(
      Number(process.env.MEDIA_YOUTUBE_MAX_BYTES),
      Math.min(mediaLimits().maxSourceBytes, DEFAULT_YOUTUBE_RESERVATION_BYTES),
    );
    return this.enqueue({
      contentId,
      workspaceId,
      userId,
      jobType: 'youtube_ingest',
      sourceType: 'youtube',
      sourceIdentity: identity,
      idempotencyKey: `${identity}:content:${contentId}:v${expectedVersion}`,
      expectedVersion,
      expectedFilepath,
      reservedBytes: maxBytes,
      payload: { videoId: normalizeYoutubeId(videoId), maxBytes },
      maxAttempts: 3,
    });
  }

  enqueueRemoteValidation({
    contentId,
    workspaceId,
    userId,
    url,
    expectedVersion,
    idempotencyKey,
  }) {
    return this.enqueue({
      contentId,
      workspaceId,
      userId,
      jobType: 'remote_validate',
      sourceType: 'remote_url',
      sourceIdentity: String(url),
      idempotencyKey: idempotencyKey || `remote:${contentId}:v${expectedVersion}:${url}`,
      expectedVersion,
      expectedFilepath: '',
      payload: { url: String(url) },
      maxAttempts: 3,
    });
  }

  enqueueUrlDownload({
    contentId,
    workspaceId,
    userId,
    url,
    downloadJobId,
    expectedVersion,
    expectedFilepath = '',
  }) {
    const maxBytes = boundedReservation(
      Number(process.env.MEDIA_DOWNLOAD_MAX_BYTES),
      Math.min(mediaLimits().maxSourceBytes, DEFAULT_YOUTUBE_RESERVATION_BYTES),
    );
    return this.enqueue({
      contentId,
      workspaceId,
      userId,
      jobType: 'url_download',
      sourceType: 'url_download',
      sourceIdentity: String(url),
      idempotencyKey: `url-download:${downloadJobId || contentId}:v${expectedVersion}`,
      expectedVersion,
      expectedFilepath,
      reservedBytes: maxBytes,
      payload: {
        url: String(url),
        downloadJobId: downloadJobId || null,
        maxBytes,
      },
      maxAttempts: 3,
    });
  }

  enqueuePeerTube({
    contentId,
    workspaceId,
    userId,
    replayId,
    videoUuid,
    expectedVersion,
    expectedFilepath = '',
  }) {
    const identity = peerTubeSourceIdentity(videoUuid);
    const maxBytes = boundedReservation(
      Number(process.env.MEDIA_PEERTUBE_MAX_BYTES),
      Math.min(mediaLimits().maxSourceBytes, DEFAULT_YOUTUBE_RESERVATION_BYTES),
    );
    return this.enqueue({
      contentId,
      workspaceId,
      userId,
      jobType: 'peertube_localize',
      sourceType: 'peertube',
      sourceIdentity: identity,
      idempotencyKey: `${identity}:content:${contentId}:v${expectedVersion}`,
      expectedVersion,
      expectedFilepath,
      reservedBytes: maxBytes,
      payload: {
        replayId: String(replayId || ''),
        videoUuid: String(videoUuid || ''),
        maxBytes,
      },
      maxAttempts: 5,
    });
  }

  schedule() {
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    if (!this._drainFlight) {
      this._drainFlight = new Promise((resolve) => setImmediate(resolve))
        .then(() => this.worker.drain())
        .finally(() => {
          this._drainFlight = null;
          this._scheduleNextRetry();
        });
    }
    return this._drainFlight;
  }

  _scheduleNextRetry() {
    const now = this.now();
    const next = this.db.prepare(`
      SELECT MIN(
        CASE WHEN status='running' THEN lease_expires_at ELSE available_at END
      ) AS wake_at
      FROM media_jobs
      WHERE (
        ((status='retry_wait' OR status='queued' OR status='running')
          AND cancel_requested=0 AND attempts < max_attempts)
        OR (status='running' AND cancel_requested=1)
      )
    `).get();
    if (!next || next.wake_at == null) return;
    const delay = Math.max(25, Math.min((Number(next.wake_at) - now) * 1000, 60 * 1000));
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this.schedule();
    }, delay);
    if (typeof this._retryTimer.unref === 'function') this._retryTimer.unref();
  }

  async waitForDrain() {
    await this.schedule();
  }

  _ensureDiskReservation(job) {
    const available = availableDiskBytes(this.contentDir);
    if (available == null) return;
    const headroom = Math.max(
      64 * 1024 * 1024,
      Number(process.env.MEDIA_DISK_HEADROOM_BYTES) || DEFAULT_DISK_HEADROOM_BYTES,
    );
    const other = this.db.prepare(`
      SELECT COALESCE(SUM(reserved_bytes), 0) AS bytes
      FROM media_jobs
      WHERE status='running' AND id<>?
    `).get(job.id);
    const required = headroom + Number(job.reserved_bytes || 0) + Number(other?.bytes || 0);
    if (available < required) {
      throw errorWith(
        'media_disk_space_low',
        `Media processing requires ${required} free bytes but only ${available} are available`,
        false,
      );
    }
  }

  async _handleVideo(job, context) {
    const row = this.db.prepare('SELECT * FROM content WHERE id=?').get(job.content_id);
    if (!row) return { status: 'stale', reason: 'content_missing' };
    if (Number(row.version) !== Number(job.expected_version)
        || String(row.filepath) !== String(job.expected_filepath)) {
      return { status: 'stale', reason: 'content_changed' };
    }
    const absolutePath = safeContentPath(
      this.contentDir,
      job.payload?.absolutePath || path.join(this.contentDir, row.filepath),
    );
    const size = sourceSize(absolutePath);
    if (size <= 0) throw errorWith('source_missing', 'Source file is missing', false);
    if (size > mediaLimits().maxSourceBytes) {
      throw errorWith('source_too_large', 'Source exceeds the configured media size limit', false);
    }
    this._ensureDiskReservation(job);
    context.progress('probing', 10);
    const normalizeVideoJob = this.normalizeVideoJob
      || require('./media-transcode').normalizeVideoJob;
    const result = await normalizeVideoJob({
      db: this.db,
      io: this.io,
      contentId: row.id,
      absPath: absolutePath,
      expectedFilepath: row.filepath,
      contentDir: this.contentDir,
      staleAbsolutePaths: job.payload?.staleAbsolutePaths || [],
    });
    if (result.status === 'failed') {
      throw errorWith(
        result.error || 'video_normalization_failed',
        result.error || 'Video normalization failed',
        !['media_probe_failed', 'media_duration_limit_exceeded', 'media_pixel_limit_exceeded'].includes(result.error),
      );
    }
    return result;
  }

  async _handlePeerTube(job, context) {
    this._ensureDiskReservation(job);
    return this.peerTubeAssetHandler(job, context);
  }

  async _handleThumbnailStudio(job, context) {
    const row = this.db.prepare('SELECT * FROM content WHERE id=?').get(job.content_id);
    const customPosterPath = job.payload?.customPosterPath || null;
    const cleanupCustom = () => safeUnlink(customPosterPath);
    if (!row || Number(row.version || 1) !== Number(job.expected_version || 1)
        || String(row.filepath) !== String(job.expected_filepath)) {
      cleanupCustom();
      return { status: 'stale', reason: 'content_changed' };
    }
    const sourcePath = safeContentPath(
      this.contentDir,
      path.join(this.contentDir, path.basename(row.filepath)),
    );
    if (sourceSize(sourcePath) <= 0) {
      cleanupCustom();
      throw errorWith('source_missing', 'Source file is missing', false);
    }
    this._ensureDiskReservation(job);
    const isVideo = String(row.mime_type || '').startsWith('video/');
    const isImage = String(row.mime_type || '').startsWith('image/');
    if (!isVideo && !isImage && !customPosterPath) {
      cleanupCustom();
      throw errorWith('poster_media_unsupported', 'Poster Studio supports video and image media', false);
    }
    let request;
    try {
      request = normalizePosterRequest({
        timestampSeconds: job.payload?.timestampSeconds,
        position: job.payload?.position,
      }, {
        isVideo,
        durationSeconds: row.duration_sec,
      });
    } catch (error) {
      cleanupCustom();
      throw errorWith(error.message, 'Poster settings are invalid', false);
    }
    const expectedSourceSha256 = await sha256File(sourcePath);
    context.progress('thumbnail', 25);
    let candidate;
    try {
      candidate = await this.createThumbnailStudioCandidate({
        contentDir: this.contentDir,
        contentId: row.id,
        sourcePath,
        customPosterPath,
        isVideo,
        durationSeconds: row.duration_sec,
        timestampSeconds: request.timestampSeconds,
        position: request.position,
      });
      context.progress('finalizing', 80);
      const result = await commitThumbnail({
        db: this.db,
        io: this.io,
        contentDir: this.contentDir,
        contentId: row.id,
        expectedFilepath: row.filepath,
        expectedVersion: job.expected_version,
        expectedSourceSha256,
        thumbnailPath: candidate.thumbnailPath,
        thumbnailFilename: candidate.thumbnailFilename,
        provenance: candidate.provenance,
        now: this.now,
      });
      cleanupCustom();
      return result;
    } catch (error) {
      if (candidate?.thumbnailPath) safeUnlink(candidate.thumbnailPath);
      if (error.retryable === false || [
        'poster_media_unsupported',
        'timestamp_out_of_range',
        'invalid_poster_position',
      ].includes(error.code || error.message)) cleanupCustom();
      throw error;
    }
  }

  async _handleThumbnailFinalize(job, context) {
    const row = this.db.prepare('SELECT * FROM content WHERE id=?').get(job.content_id);
    if (!row || Number(row.version) !== Number(job.expected_version)
        || String(row.filepath) !== String(job.expected_filepath)) {
      return { status: 'stale', reason: 'content_changed' };
    }
    const absolutePath = safeContentPath(
      this.contentDir,
      job.payload?.absolutePath || path.join(this.contentDir, row.filepath),
    );
    if (!fs.existsSync(absolutePath)) throw errorWith('source_missing', 'Source file is missing', false);
    if (sourceSize(absolutePath) > mediaLimits().maxSourceBytes) {
      throw errorWith('source_too_large', 'Source exceeds the configured media size limit', false);
    }
    this._ensureDiskReservation(job);
    const sourceHash = await sha256File(absolutePath);
    const mimeType = String(job.payload?.mimeType || row.mime_type || 'application/octet-stream');
    let candidatePath = absolutePath;
    let candidateFilepath = row.filepath;
    let candidateMimeType = mimeType;
    let convertedPath = null;
    if (['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence'].includes(mimeType.toLowerCase())) {
      context.progress('optimizing', 20);
      const { heicToJpeg } = require('./media-transcode');
      const converted = await heicToJpeg(absolutePath, this.contentDir);
      if (!converted) throw errorWith('heic_conversion_failed', 'HEIC conversion failed', true);
      candidatePath = converted.absPath;
      candidateFilepath = converted.filename;
      candidateMimeType = 'image/jpeg';
      convertedPath = converted.absPath;
    }
    let thumbnailName = null;
    let width = null;
    let height = null;
    let provenance = null;
    context.progress('thumbnail', 35);
    if (isDocThumbnailMime(candidateMimeType)) {
      thumbnailName = await generateDocThumbnail({
        srcPath: candidatePath,
        mimeType: candidateMimeType,
        contentDir: this.contentDir,
      });
      provenance = thumbnailName
        ? (candidateMimeType === 'application/pdf' ? 'pdf_page_1' : 'document_page_1')
        : null;
    } else if (candidateMimeType.startsWith('image/')) {
      const sharp = require('sharp');
      const image = sharp(candidatePath, {
        limitInputPixels: mediaLimits().maxImagePixels,
        failOn: 'error',
      });
      const metadata = await image.metadata();
      width = metadata.width || null;
      height = metadata.height || null;
      thumbnailName = `thumb_${path.basename(candidateFilepath).replace(/\.[^.]+$/, '')}.jpg`;
      await image.resize(config.thumbnailWidth).jpeg({ quality: 70 })
        .toFile(path.join(this.contentDir, thumbnailName));
      provenance = 'image_scaled';
    }
    const currentHash = await sha256File(absolutePath);
    if (currentHash !== sourceHash) {
      safeUnlink(thumbnailName && path.join(this.contentDir, thumbnailName));
      safeUnlink(convertedPath);
      return { status: 'stale', reason: 'source_hash_changed' };
    }
    const candidateHash = candidatePath === absolutePath
      ? sourceHash
      : await sha256File(candidatePath);
    context.progress('checksum', 75);
    try {
      return await finalizeContentAsset({
        db: this.db,
        io: this.io,
        contentId: row.id,
        expectedFilepath: row.filepath,
        expectedVersion: job.expected_version,
        candidatePath,
        finalPath: candidatePath,
        finalFilepath: candidateFilepath,
        metadata: {
          mimeType: candidateMimeType,
          width,
          height,
          thumbnailPath: thumbnailName,
          thumbnailProvenance: provenance,
          thumbnailSourceSha256: candidateHash,
          thumbnailSourceFilepath: candidateFilepath,
          originalFilepath: row.filepath,
          originalSha256: sourceHash,
        },
        discardPathsOnStale: [
          ...(thumbnailName ? [path.join(this.contentDir, thumbnailName)] : []),
          ...(convertedPath ? [convertedPath] : []),
        ],
        staleAbsolutePaths: job.payload?.staleAbsolutePaths || [],
      });
    } catch (error) {
      safeUnlink(thumbnailName && path.join(this.contentDir, thumbnailName));
      safeUnlink(convertedPath);
      throw error;
    }
  }

  async _handleYoutube(job, context) {
    let row = this.db.prepare('SELECT * FROM content WHERE id=?').get(job.content_id);
    if (!row) {
      return { status: 'stale', reason: 'content_changed' };
    }
    if (Number(row.version) !== Number(job.expected_version)) {
      if (row.processing_status === 'ready' && row.filepath) {
        this.db.prepare(`
          UPDATE content_media_metadata
          SET detected_mime_type='video/mp4',
              remote_health_status='localized',
              updated_at=?
          WHERE content_id=? AND source_type='youtube'
        `).run(this.now(), row.id);
        return { status: 'ready', recovered: true, content_id: row.id };
      }
      return { status: 'stale', reason: 'content_changed' };
    }
    let localName = String(row.filepath || '');
    let localPath = localName
      ? safeContentPath(this.contentDir, path.join(this.contentDir, localName))
      : safeContentPath(this.contentDir, path.join(this.contentDir, `${row.id}.youtube.mp4`));
    const partPath = safeContentPath(
      this.contentDir,
      path.join(this.contentDir, `${row.id}.youtube.part.mp4`),
    );
    if (!localName && fs.existsSync(localPath) && sourceSize(localPath) > 0) {
      localName = path.basename(localPath);
    }
    if (!localName || !fs.existsSync(localPath)) {
      this._ensureDiskReservation(job);
      safeUnlink(partPath);
      context.progress('optimizing', 15);
      try {
        await this.execFile('yt-dlp', buildYoutubeDownloadArgs({
          videoId: job.payload?.videoId,
          outputPath: partPath,
          maxBytes: job.payload?.maxBytes,
        }), {
          timeout: Math.max(60_000, Number(process.env.YDLP_TIMEOUT_MS) || 30 * 60_000),
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        });
        if (!fs.existsSync(partPath) || fs.statSync(partPath).size <= 0) {
          throw errorWith('youtube_output_missing', 'YouTube download produced no media');
        }
        if (fs.statSync(partPath).size > Number(job.payload?.maxBytes || mediaLimits().maxSourceBytes)) {
          throw errorWith('youtube_output_too_large', 'YouTube output exceeded the classroom import limit', false);
        }
        fs.renameSync(partPath, localPath);
      } catch (error) {
        safeUnlink(partPath);
        safeUnlink(localPath);
        const code = error.code || 'youtube_download_failed';
        this.db.prepare(`
          UPDATE content
          SET processing_status='failed', processing_error=?, updated_at=?
          WHERE id=? AND COALESCE(version, 1)=? AND filepath=?
        `).run(
          String(code).slice(0, 2000),
          this.now(),
          row.id,
          job.expected_version,
          job.expected_filepath || '',
        );
        emitContentUpdated(
          this.io,
          this.db.prepare('SELECT * FROM content WHERE id=?').get(row.id),
          job.expected_version,
        );
        throw errorWith(
          code,
          error.message || 'YouTube download failed',
          true,
        );
      }
      localName = path.basename(localPath);
      const changed = this.db.prepare(`
        UPDATE content
        SET filepath=?, mime_type='video/mp4', processing_status='uploaded',
            processing_error=NULL, updated_at=?
        WHERE id=? AND COALESCE(version, 1)=? AND filepath=?
      `).run(
        localName,
        this.now(),
        row.id,
        job.expected_version,
        job.expected_filepath || '',
      );
      if (!changed.changes) {
        safeUnlink(localPath);
        return { status: 'stale', reason: 'content_changed' };
      }
    }
    row = this.db.prepare('SELECT * FROM content WHERE id=?').get(job.content_id);
    if (String(row.filepath || '') !== localName) {
      const adopted = this.db.prepare(`
        UPDATE content
        SET filepath=?, mime_type='video/mp4', processing_status='uploaded',
            processing_error=NULL, updated_at=?
        WHERE id=? AND COALESCE(version, 1)=? AND filepath=?
      `).run(
        localName,
        this.now(),
        row.id,
        job.expected_version,
        job.expected_filepath || '',
      );
      if (!adopted.changes) {
        safeUnlink(localPath);
        return { status: 'stale', reason: 'content_changed' };
      }
      row = this.db.prepare('SELECT * FROM content WHERE id=?').get(job.content_id);
    }
    context.progress('probing', 55);
    const normalizeVideoJob = this.normalizeVideoJob
      || require('./media-transcode').normalizeVideoJob;
    const result = await normalizeVideoJob({
      db: this.db,
      io: this.io,
      contentId: row.id,
      absPath: localPath,
      expectedFilepath: localName,
      contentDir: this.contentDir,
    });
    if (result.status === 'failed') {
      throw errorWith(
        result.error || 'youtube_normalization_failed',
        result.error || 'YouTube normalization failed',
        false,
      );
    }
    if (result.status === 'ready') {
      this.db.prepare(`
        UPDATE content_media_metadata
        SET detected_mime_type='video/mp4',
            remote_health_status='localized',
            updated_at=?
        WHERE content_id=? AND source_type='youtube'
      `).run(this.now(), row.id);
    }
    return result;
  }

  async _handleUrlDownload(job, context) {
    let row = this.db.prepare('SELECT * FROM content WHERE id=?').get(job.content_id);
    const downloadJobId = job.payload?.downloadJobId || null;
    if (!row) return { status: 'stale', reason: 'content_missing' };
    if (Number(row.version) !== Number(job.expected_version)) {
      if (downloadJobId && row.processing_status === 'ready' && row.filepath) {
        this.db.prepare(`
          UPDATE download_jobs
          SET status='done', progress_pct=100, local_path=?,
              error_msg=NULL, completed_at=COALESCE(completed_at, ?)
          WHERE id=?
        `).run(row.filepath, this.now(), downloadJobId);
        return { status: 'ready', recovered: true, content_id: row.id };
      }
      return { status: 'stale', reason: 'content_changed' };
    }
    const base = `${row.id}.download`;
    let localName = String(row.filepath || '');
    let localPath = localName
      ? safeContentPath(this.contentDir, path.join(this.contentDir, localName))
      : safeContentPath(this.contentDir, path.join(this.contentDir, `${base}.mp4`));
    const partPath = safeContentPath(
      this.contentDir,
      path.join(this.contentDir, `${base}.part.mp4`),
    );
    if (!localName && fs.existsSync(localPath) && sourceSize(localPath) > 0) {
      localName = path.basename(localPath);
    }
    if (!localName || !fs.existsSync(localPath)) {
      this._ensureDiskReservation(job);
      const safe = await this.urlSafetyCheck(job.payload?.url);
      if (!safe?.ok) {
        throw errorWith(safe?.reason || 'download_url_unsafe', safe?.error || 'Download URL is unsafe', false);
      }
      safeUnlink(partPath);
      context.progress('optimizing', 15);
      if (downloadJobId) {
        this.db.prepare(`
          UPDATE download_jobs
          SET status='downloading', progress_pct=10, error_msg=NULL,
              started_at=COALESCE(started_at, ?)
          WHERE id=?
        `).run(this.now(), downloadJobId);
      }
      try {
        await this.execFile('yt-dlp', buildUrlDownloadArgs({
          url: safe.parsed.toString(),
          outputPath: partPath,
          maxBytes: job.payload?.maxBytes,
        }), {
          timeout: Math.max(60_000, Number(process.env.YDLP_TIMEOUT_MS) || 30 * 60_000),
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        });
        const size = sourceSize(partPath);
        if (size <= 0) throw errorWith('download_output_missing', 'Download produced no media');
        if (size > Number(job.payload?.maxBytes || mediaLimits().maxSourceBytes)) {
          throw errorWith('download_output_too_large', 'Downloaded media exceeded the import limit', false);
        }
        fs.renameSync(partPath, localPath);
      } catch (error) {
        safeUnlink(partPath);
        safeUnlink(localPath);
        const code = error.code || 'url_download_failed';
        if (downloadJobId) {
          this.db.prepare(`
            UPDATE download_jobs
            SET status='error', error_msg=?, completed_at=?
            WHERE id=?
          `).run(String(error.message || code).slice(0, 500), this.now(), downloadJobId);
        }
        this.db.prepare(`
          UPDATE content SET processing_status='failed', processing_error=?, updated_at=?
          WHERE id=? AND COALESCE(version,1)=?
        `).run(String(code).slice(0, 2000), this.now(), row.id, job.expected_version);
        emitContentUpdated(
          this.io,
          this.db.prepare('SELECT * FROM content WHERE id=?').get(row.id),
          job.expected_version,
        );
        throw errorWith(code, error.message || 'URL download failed', error.retryable !== false);
      }
      localName = path.basename(localPath);
      const changed = this.db.prepare(`
        UPDATE content
        SET filepath=?, mime_type='video/mp4', processing_status='uploaded',
            processing_error=NULL, updated_at=?
        WHERE id=? AND COALESCE(version,1)=? AND filepath=?
      `).run(localName, this.now(), row.id, job.expected_version, job.expected_filepath || '');
      if (!changed.changes) {
        safeUnlink(localPath);
        return { status: 'stale', reason: 'content_changed' };
      }
      if (downloadJobId) {
        this.db.prepare(`
          UPDATE download_jobs SET local_path=?, progress_pct=85 WHERE id=?
        `).run(localName, downloadJobId);
      }
    }
    row = this.db.prepare('SELECT * FROM content WHERE id=?').get(job.content_id);
    if (String(row.filepath || '') !== localName) {
      const adopted = this.db.prepare(`
        UPDATE content
        SET filepath=?, mime_type='video/mp4', processing_status='uploaded',
            processing_error=NULL, updated_at=?
        WHERE id=? AND COALESCE(version,1)=? AND filepath=?
      `).run(
        localName,
        this.now(),
        row.id,
        job.expected_version,
        job.expected_filepath || '',
      );
      if (!adopted.changes) {
        safeUnlink(localPath);
        return { status: 'stale', reason: 'content_changed' };
      }
      row = this.db.prepare('SELECT * FROM content WHERE id=?').get(job.content_id);
    }
    context.progress('probing', 55);
    const normalizeVideoJob = this.normalizeVideoJob
      || require('./media-transcode').normalizeVideoJob;
    const result = await normalizeVideoJob({
      db: this.db,
      io: this.io,
      contentId: row.id,
      absPath: localPath,
      expectedFilepath: localName,
      contentDir: this.contentDir,
    });
    if (result.status === 'failed') {
      if (downloadJobId) {
        this.db.prepare(`
          UPDATE download_jobs SET status='error', error_msg=?, completed_at=? WHERE id=?
        `).run(result.error || 'normalization_failed', this.now(), downloadJobId);
      }
      throw errorWith(result.error || 'download_normalization_failed', result.error, false);
    }
    if (result.status === 'ready' && downloadJobId) {
      const ready = this.db.prepare('SELECT filepath FROM content WHERE id=?').get(row.id);
      this.db.prepare(`
        UPDATE download_jobs
        SET status='done', progress_pct=100, local_path=?,
            error_msg=NULL, completed_at=?
        WHERE id=?
      `).run(ready?.filepath || localName, this.now(), downloadJobId);
    }
    return result;
  }

  async _handleRemote(job, context) {
    const row = this.db.prepare('SELECT * FROM content WHERE id=?').get(job.content_id);
    if (!row || Number(row.version) !== Number(job.expected_version)
        || String(row.remote_url || '') !== String(job.payload?.url || '')) {
      return { status: 'stale', reason: 'content_changed' };
    }
    context.progress('validating', 20);
    const validation = await validateRemoteMedia(job.payload.url, {
      maxBytes: mediaLimits().maxSourceBytes,
    });
    const now = this.now();
    this.db.prepare(`
      INSERT INTO content_media_metadata (
        content_id, workspace_id, source_type, source_identity, source_url,
        detected_mime_type, remote_health_status, remote_last_validated_at,
        remote_error_code, remote_final_url, remote_content_length,
        remote_range_supported, remote_cors_allowed, remote_source_kind,
        remote_etag, remote_last_modified, created_at, updated_at
      ) VALUES (
        @content_id, @workspace_id, 'remote_url', @source_identity, @source_url,
        @detected_mime_type, @remote_health_status, @remote_last_validated_at,
        @remote_error_code, @remote_final_url, @remote_content_length,
        @remote_range_supported, @remote_cors_allowed, @remote_source_kind,
        @remote_etag, @remote_last_modified, @created_at, @updated_at
      )
      ON CONFLICT(content_id) DO UPDATE SET
        workspace_id=excluded.workspace_id,
        source_type=excluded.source_type,
        source_identity=excluded.source_identity,
        source_url=excluded.source_url,
        detected_mime_type=excluded.detected_mime_type,
        remote_health_status=excluded.remote_health_status,
        remote_last_validated_at=excluded.remote_last_validated_at,
        remote_error_code=excluded.remote_error_code,
        remote_final_url=excluded.remote_final_url,
        remote_content_length=excluded.remote_content_length,
        remote_range_supported=excluded.remote_range_supported,
        remote_cors_allowed=excluded.remote_cors_allowed,
        remote_source_kind=excluded.remote_source_kind,
        remote_etag=excluded.remote_etag,
        remote_last_modified=excluded.remote_last_modified,
        updated_at=excluded.updated_at
    `).run({
      content_id: row.id,
      workspace_id: row.workspace_id,
      source_identity: String(job.payload.url),
      source_url: String(job.payload.url),
      detected_mime_type: validation.detectedMime || null,
      remote_health_status: validation.status,
      remote_last_validated_at: validation.lastValidatedAt || now,
      remote_error_code: validation.errorCode || null,
      remote_final_url: validation.finalUrl || null,
      remote_content_length: validation.contentLength ?? null,
      remote_range_supported: validation.rangeSupported ? 1 : 0,
      remote_cors_allowed: validation.corsAllowed ? 1 : 0,
      remote_source_kind: validation.sourceKind || null,
      remote_etag: validation.etag || null,
      remote_last_modified: validation.lastModified || null,
      created_at: now,
      updated_at: now,
    });
    if (!validation.ok) {
      this.db.prepare(`
        UPDATE content SET processing_status='failed', processing_error=?, updated_at=?
        WHERE id=? AND COALESCE(version,1)=?
      `).run(validation.errorCode, now, row.id, job.expected_version);
      throw errorWith(
        validation.errorCode || 'remote_validation_failed',
        validation.error || 'Remote validation failed',
        !['private_target', 'remote_too_large'].includes(validation.errorCode),
      );
    }
    this.db.prepare(`
      UPDATE content SET mime_type=COALESCE(?, mime_type),
        processing_status='ready', processing_error=NULL, updated_at=?
      WHERE id=? AND COALESCE(version,1)=? AND remote_url=?
    `).run(validation.detectedMime, now, row.id, job.expected_version, job.payload.url);
    return validation;
  }
}

function getMediaPipeline(options = {}) {
  const db = options.db || require('../db/database').db;
  let pipeline = PIPELINES.get(db);
  if (!pipeline) {
    pipeline = new MediaPipeline({ ...options, db });
    PIPELINES.set(db, pipeline);
  } else {
    pipeline.setIo(options.io);
  }
  return pipeline;
}

module.exports = {
  MediaPipeline,
  availableDiskBytes,
  buildUrlDownloadArgs,
  buildYoutubeDownloadArgs,
  getMediaPipeline,
  normalizeYoutubeId,
  youtubeSourceIdentity,
};
