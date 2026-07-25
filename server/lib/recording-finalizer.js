'use strict';

const { spawn } = require('child_process');
const { createHash } = require('crypto');
const { createReadStream, statSync, accessSync, constants } = require('fs');
const { join, resolve, basename, dirname } = require('path');
const { EventEmitter } = require('events');

const VALID_STATES = [
  'recording',
  'finalizing',
  'validated',
  'syncing',
  'synced',
  'uploading',
  'uploaded-private',
  'awaiting-review',
  'published',
  'failed'
];

const TRANSITIONS = {
  recording:        ['finalizing', 'failed'],
  finalizing:       ['validated', 'failed'],
  validated:        ['syncing', 'failed'],
  syncing:          ['synced', 'failed'],
  synced:           ['uploading', 'failed'],
  uploading:        ['uploaded-private', 'failed'],
  'uploaded-private': ['awaiting-review', 'failed'],
  'awaiting-review': ['published', 'failed'],
  published:        [],
  failed:           ['finalizing', 'syncing', 'uploading']
};

const MAX_RETRIES = 5;
const BACKOFF_BASE_MS = 2000;
const DISK_WARN_THRESHOLD_BYTES = 5 * 1024 * 1024 * 1024;
const RSYNC_DEST = 'mbfd@192.168.1.116:/mnt/mbfd-storage/mbfd-broadcasts/';

function defaultClock() {
  return Date.now();
}

function defaultRunner(cmd, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('error', (err) => rejectPromise(err));
    proc.on('close', (code) => {
      if (code !== 0) {
        const err = new Error(`Command failed: ${cmd} ${args.join(' ')} (exit ${code})`);
        err.exitCode = code;
        err.stderr = stderr;
        err.stdout = stdout;
        rejectPromise(err);
      } else {
        resolvePromise({ stdout, stderr, exitCode: code });
      }
    });
  });
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS live_session_recordings (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'recording',
      duration_seconds REAL DEFAULT 0,
      file_size_bytes INTEGER DEFAULT 0,
      sha256 TEXT DEFAULT '',
      camera_id TEXT DEFAULT '',
      operator_id TEXT DEFAULT '',
      started_at TEXT DEFAULT '',
      stopped_at TEXT DEFAULT '',
      finalized_at TEXT DEFAULT '',
      synced_at TEXT DEFAULT '',
      uploaded_at TEXT DEFAULT '',
      peertube_video_id TEXT DEFAULT '',
      peertube_video_uuid TEXT DEFAULT '',
      peertube_watch_url TEXT DEFAULT '',
      peertube_privacy TEXT DEFAULT 'private',
      published_at TEXT DEFAULT '',
      error_message TEXT DEFAULT '',
      retry_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_lsr_session ON live_session_recordings(session_id);
    CREATE INDEX IF NOT EXISTS idx_lsr_status ON live_session_recordings(status);

    CREATE TABLE IF NOT EXISTS recording_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recording_id TEXT NOT NULL,
      from_state TEXT NOT NULL,
      to_state TEXT NOT NULL,
      reason TEXT DEFAULT '',
      metadata TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY (recording_id) REFERENCES live_session_recordings(id)
    );

    CREATE INDEX IF NOT EXISTS idx_audit_recording ON recording_audit_log(recording_id);
  `);
}

function computeSha256(filePath) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolvePromise(hash.digest('hex')));
    stream.on('error', (err) => rejectPromise(err));
  });
}

function isTransientError(err) {
  if (!err) return false;
  const msg = (err.message || '').toLowerCase();
  const transientPatterns = [
    'econnrefused', 'econnreset', 'etimedout', 'enetwork',
    'connection reset', 'broken pipe', 'timeout', 'temporary failure',
    'rsync error', 'exit 10', 'exit 11', 'exit 12', 'exit 23', 'exit 24',
    'exit 25', 'exit 30', 'exit 35'
  ];
  return transientPatterns.some((p) => msg.includes(p));
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function backoffDelay(retryCount) {
  return BACKOFF_BASE_MS * Math.pow(2, retryCount);
}

function validatePath(filePath, approvedRoot) {
  const resolved = resolve(filePath);
  const resolvedRoot = resolve(approvedRoot);
  if (!resolved.startsWith(resolvedRoot)) {
    throw new Error(`Path ${filePath} is outside approved root ${approvedRoot}`);
  }
  return resolved;
}

function createFinalizer({ db, approvedRoot, runner, clock }) {
  if (!db) throw new Error('db is required');
  if (!approvedRoot) throw new Error('approvedRoot is required');
  if (!runner) runner = defaultRunner;
  if (!clock) clock = defaultClock;

  ensureSchema(db);

  const emitter = new EventEmitter();
  const queue = [];
  let processing = false;
  let shutdownRequested = false;

  const stmts = {
    insertRecording: db.prepare(`
      INSERT OR IGNORE INTO live_session_recordings
        (id, session_id, file_path, status, camera_id, operator_id, started_at, stopped_at, created_at, updated_at)
      VALUES
        (@id, @sessionId, @filePath, 'recording', @cameraId, @operatorId, @startedAt, @stoppedAt, @createdAt, @updatedAt)
    `),
    getRecording: db.prepare('SELECT * FROM live_session_recordings WHERE id = ?'),
    updateStatus: db.prepare('UPDATE live_session_recordings SET status = ?, updated_at = ?, error_message = ?, retry_count = ? WHERE id = ?'),
    updateFinalized: db.prepare(`
      UPDATE live_session_recordings
      SET duration_seconds = ?, file_size_bytes = ?, sha256 = ?, finalized_at = ?, updated_at = ?
      WHERE id = ?
    `),
    updateSynced: db.prepare('UPDATE live_session_recordings SET synced_at = ?, updated_at = ? WHERE id = ?'),
    updateUploaded: db.prepare(`
      UPDATE live_session_recordings
      SET uploaded_at = ?, peertube_video_id = ?, peertube_video_uuid = ?, peertube_watch_url = ?, peertube_privacy = ?, updated_at = ?
      WHERE id = ?
    `),
    updatePublished: db.prepare('UPDATE live_session_recordings SET published_at = ?, updated_at = ? WHERE id = ?'),
    insertAudit: db.prepare(`
      INSERT INTO recording_audit_log (recording_id, from_state, to_state, reason, metadata, created_at)
      VALUES (@recordingId, @fromState, @toState, @reason, @metadata, @createdAt)
    `),
    getStuckRecordings: db.prepare(`
      SELECT * FROM live_session_recordings
      WHERE status IN ('finalizing', 'syncing', 'uploading')
      ORDER BY updated_at ASC
    `),
    getPendingBySession: db.prepare(`
      SELECT * FROM live_session_recordings
      WHERE session_id = ? AND status NOT IN ('published', 'failed')
      ORDER BY created_at ASC
    `)
  };

  function transitionState(recordingId, fromState, toState, reason, metadata) {
    if (!TRANSITIONS[fromState] || !TRANSITIONS[fromState].includes(toState)) {
      throw new Error(`Invalid transition: ${fromState} -> ${toState} for recording ${recordingId}`);
    }
    const now = new Date(clock()).toISOString();
    const update = db.transaction(() => {
      stmts.updateStatus.run(toState, now, reason || '', 0, recordingId);
      stmts.insertAudit.run({
        recordingId,
        fromState,
        toState,
        reason: reason || '',
        metadata: JSON.stringify(metadata || {}),
        createdAt: now
      });
    });
    update();
    emitter.emit('state-change', { recordingId, fromState, toState, reason, timestamp: now });
    return now;
  }

  function incrementRetry(recordingId, errorMsg) {
    const rec = stmts.getRecording.get(recordingId);
    if (!rec) return null;
    const newCount = rec.retry_count + 1;
    const now = new Date(clock()).toISOString();
    stmts.updateStatus.run(rec.status, now, errorMsg, newCount, recordingId);
    return newCount;
  }

  function emitProgress(recordingId, stage, percent, detail) {
    emitter.emit('progress', { recordingId, stage, percent, detail, timestamp: new Date(clock()).toISOString() });
  }

  async function runFfprobe(filePath) {
    const result = await runner('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath
    ]);
    return JSON.parse(result.stdout);
  }

  function validateProbeData(probeData, filePath) {
    const streams = probeData.streams || [];
    const videoStream = streams.find((s) => s.codec_type === 'video');
    const audioStream = streams.find((s) => s.codec_type === 'audio');

    if (!videoStream) {
      throw new Error(`No video stream found in ${filePath}`);
    }
    if (!audioStream) {
      throw new Error(`No audio stream found in ${filePath}`);
    }

    const duration = parseFloat(probeData.format && probeData.format.duration) || 0;
    if (duration <= 0) {
      throw new Error(`Invalid duration (${duration}) for ${filePath}`);
    }

    const width = parseInt(videoStream.width, 10) || 0;
    const height = parseInt(videoStream.height, 10) || 0;
    if (width <= 0 || height <= 0) {
      throw new Error(`Invalid resolution (${width}x${height}) for ${filePath}`);
    }

    return {
      duration,
      width,
      height,
      videoCodec: videoStream.codec_name || 'unknown',
      audioCodec: audioStream.codec_name || 'unknown',
      bitrate: parseInt(probeData.format && probeData.format.bit_rate, 10) || 0
    };
  }

  async function finalizeMedia(recordingId) {
    const rec = stmts.getRecording.get(recordingId);
    if (!rec) throw new Error(`Recording ${recordingId} not found`);

    const filePath = validatePath(rec.file_path, approvedRoot);

    emitProgress(recordingId, 'finalizing', 10, 'Running ffprobe validation');

    const probeData = await runFfprobe(filePath);
    const mediaInfo = validateProbeData(probeData, filePath);

    emitProgress(recordingId, 'finalizing', 40, 'Computing SHA-256 checksum');

    const checksum = await computeSha256(filePath);
    const fileStat = statSync(filePath);

    emitProgress(recordingId, 'finalizing', 70, 'Storing metadata');

    const now = new Date(clock()).toISOString();
    const updateTx = db.transaction(() => {
      stmts.updateFinalized.run(
        mediaInfo.duration,
        fileStat.size,
        checksum,
        now,
        now,
        recordingId
      );
      stmts.insertAudit.run({
        recordingId,
        fromState: 'finalizing',
        toState: 'validated',
        reason: 'Media validated and checksummed',
        metadata: JSON.stringify({
          duration: mediaInfo.duration,
          fileSize: fileStat.size,
          checksum,
          videoCodec: mediaInfo.videoCodec,
          audioCodec: mediaInfo.audioCodec,
          resolution: `${mediaInfo.width}x${mediaInfo.height}`
        }),
        createdAt: now
      });
      stmts.updateStatus.run('validated', now, '', 0, recordingId);
    });
    updateTx();

    emitter.emit('state-change', { recordingId, fromState: 'finalizing', toState: 'validated', timestamp: now });
    emitProgress(recordingId, 'finalizing', 100, 'Validation complete');

    return { ...mediaInfo, checksum, fileSize: fileStat.size };
  }

  async function syncRecording(recordingId) {
    const rec = stmts.getRecording.get(recordingId);
    if (!rec) throw new Error(`Recording ${recordingId} not found`);
    if (rec.status === 'synced' || rec.status === 'uploading' || rec.status === 'uploaded-private' || rec.status === 'awaiting-review' || rec.status === 'published') {
      emitProgress(recordingId, 'syncing', 100, 'Already synced or beyond sync stage');
      return { skipped: true };
    }

    const filePath = validatePath(rec.file_path, approvedRoot);
    const fileName = basename(filePath);

    emitProgress(recordingId, 'syncing', 10, 'Starting rsync transfer');

    await runner('rsync', [
      '-avz',
      '--partial',
      '--progress',
      '--checksum',
      filePath,
      RSYNC_DEST + fileName
    ]);

    emitProgress(recordingId, 'syncing', 70, 'Verifying remote checksum');

    const remoteResult = await runner('ssh', [
      'mbfd@192.168.1.116',
      `sha256sum /mnt/mbfd-storage/mbfd-broadcasts/${fileName}`
    ]);

    const remoteChecksum = remoteResult.stdout.trim().split(/\s+/)[0];
    if (remoteChecksum !== rec.sha256) {
      throw new Error(`Checksum mismatch: local=${rec.sha256} remote=${remoteChecksum}`);
    }

    const now = new Date(clock()).toISOString();
    const syncTx = db.transaction(() => {
      stmts.updateSynced.run(now, now, recordingId);
      stmts.insertAudit.run({
        recordingId,
        fromState: 'syncing',
        toState: 'synced',
        reason: 'Rsync complete and checksum verified',
        metadata: JSON.stringify({ remoteChecksum, destination: RSYNC_DEST + fileName }),
        createdAt: now
      });
      stmts.updateStatus.run('synced', now, '', 0, recordingId);
    });
    syncTx();

    emitter.emit('state-change', { recordingId, fromState: 'syncing', toState: 'synced', timestamp: now });
    emitProgress(recordingId, 'syncing', 100, 'Sync complete and verified');

    return { remoteChecksum, destination: RSYNC_DEST + fileName };
  }

  async function processRecording(recordingId) {
    const rec = stmts.getRecording.get(recordingId);
    if (!rec) return;

    try {
      if (rec.status === 'recording' || rec.status === 'failed') {
        const fromState = rec.status;
        transitionState(recordingId, fromState, 'finalizing', 'Starting finalization pipeline');
        await finalizeMedia(recordingId);
      }

      const recAfterFinalize = stmts.getRecording.get(recordingId);
      if (recAfterFinalize.status === 'validated' || recAfterFinalize.status === 'failed') {
        if (recAfterFinalize.status === 'failed') {
          transitionState(recordingId, 'failed', 'syncing', 'Retry: resuming at sync stage');
        } else {
          transitionState(recordingId, 'validated', 'syncing', 'Starting sync to GMKtec');
        }
        await syncRecording(recordingId);
      }

      emitProgress(recordingId, 'complete', 100, 'Pipeline stages complete, awaiting upload/review');
    } catch (err) {
      const errorMsg = err.message || String(err);
      const retryCount = incrementRetry(recordingId, errorMsg);

      if (retryCount !== null && retryCount <= MAX_RETRIES && isTransientError(err)) {
        const delay = backoffDelay(retryCount - 1);
        emitProgress(recordingId, 'retry', 0, `Retry ${retryCount}/${MAX_RETRIES} in ${delay}ms: ${errorMsg}`);

        const now = new Date(clock()).toISOString();
        stmts.insertAudit.run({
          recordingId,
          fromState: rec.status,
          toState: 'failed',
          reason: `Transient error, will retry (${retryCount}/${MAX_RETRIES}): ${errorMsg}`,
          metadata: JSON.stringify({ retryCount, delay, error: errorMsg }),
          createdAt: now
        });
        stmts.updateStatus.run('failed', now, errorMsg, retryCount, recordingId);

        await sleep(delay);
        return processRecording(recordingId);
      } else {
        const now = new Date(clock()).toISOString();
        const currentRec = stmts.getRecording.get(recordingId);
        const currentState = currentRec ? currentRec.status : rec.status;
        stmts.updateStatus.run('failed', now, errorMsg, retryCount || 0, recordingId);
        stmts.insertAudit.run({
          recordingId,
          fromState: currentState,
          toState: 'failed',
          reason: retryCount > MAX_RETRIES ? `Max retries exceeded: ${errorMsg}` : `Permanent failure: ${errorMsg}`,
          metadata: JSON.stringify({ retryCount, error: errorMsg }),
          createdAt: now
        });
        emitter.emit('state-change', { recordingId, fromState: currentState, toState: 'failed', reason: errorMsg, timestamp: now });
        emitter.emit('error', { recordingId, error: err });
      }
    }
  }

  async function drainQueue() {
    if (processing || shutdownRequested) return;
    processing = true;

    while (queue.length > 0 && !shutdownRequested) {
      const recordingId = queue.shift();
      try {
        await processRecording(recordingId);
      } catch (err) {
        emitter.emit('error', { recordingId, error: err });
      }
    }

    processing = false;
  }

  function enqueue(recordingId, opts) {
    opts = opts || {};
    const { outputPath, sessionId, metadata } = opts;

    const existing = stmts.getRecording.get(recordingId);
    if (existing) {
      if (existing.status === 'published') {
        emitProgress(recordingId, 'skip', 100, 'Already published, idempotent no-op');
        return { idempotent: true, status: existing.status };
      }
      if (existing.status === 'synced' || existing.status === 'uploading' || existing.status === 'uploaded-private' || existing.status === 'awaiting-review') {
        emitProgress(recordingId, 'skip', 100, `Already at ${existing.status}, skipping duplicate`);
        return { idempotent: true, status: existing.status };
      }
      if (queue.includes(recordingId)) {
        return { idempotent: true, status: existing.status, queued: true };
      }
    } else {
      if (!outputPath || !sessionId) {
        throw new Error('outputPath and sessionId are required for new recordings');
      }
      validatePath(outputPath, approvedRoot);

      const meta = metadata || {};
      const now = new Date(clock()).toISOString();
      stmts.insertRecording.run({
        id: recordingId,
        sessionId,
        filePath: outputPath,
        cameraId: meta.cameraId || meta.camera_id || '',
        operatorId: meta.operatorId || meta.operator_id || '',
        startedAt: meta.startedAt || meta.started_at || '',
        stoppedAt: meta.stoppedAt || meta.stopped_at || '',
        createdAt: now,
        updatedAt: now
      });

      stmts.insertAudit.run({
        recordingId,
        fromState: '',
        toState: 'recording',
        reason: 'Recording registered for finalization',
        metadata: JSON.stringify({ outputPath, sessionId, metadata: meta }),
        createdAt: now
      });
    }

    queue.push(recordingId);
    setImmediate(drainQueue);

    return { idempotent: false, queued: true };
  }

  function recoverStuck() {
    const stuck = stmts.getStuckRecordings.all();
    if (stuck.length === 0) return [];

    const recovered = [];
    for (const rec of stuck) {
      const now = new Date(clock()).toISOString();
      stmts.insertAudit.run({
        recordingId: rec.id,
        fromState: rec.status,
        toState: 'failed',
        reason: 'Process restart recovery: stuck in intermediate state',
        metadata: JSON.stringify({ previousStatus: rec.status, recoveredAt: now }),
        createdAt: now
      });
      stmts.updateStatus.run('failed', now, 'Recovered from stuck state on restart', rec.retry_count, rec.id);
      recovered.push(rec.id);
    }

    emitter.emit('recovery', { count: recovered.length, recordingIds: recovered });
    return recovered;
  }

  function checkDiskSpace(path) {
    try {
      const { execSync } = require('child_process');
      const output = execSync(`df -B1 "${path}" | tail -1`, { encoding: 'utf8' });
      const parts = output.trim().split(/\s+/);
      const available = parseInt(parts[3], 10);
      if (available < DISK_WARN_THRESHOLD_BYTES) {
        const warning = {
          path,
          availableBytes: available,
          thresholdBytes: DISK_WARN_THRESHOLD_BYTES,
          timestamp: new Date(clock()).toISOString()
        };
        emitter.emit('disk-warning', warning);
        return warning;
      }
      return null;
    } catch (err) {
      return null;
    }
  }

  function getStatus(recordingId) {
    return stmts.getRecording.get(recordingId) || null;
  }

  function getAuditLog(recordingId) {
    return db.prepare(
      'SELECT * FROM recording_audit_log WHERE recording_id = ? ORDER BY created_at ASC'
    ).all(recordingId);
  }

  function getQueueDepth() {
    return queue.length;
  }

  function shutdown() {
    shutdownRequested = true;
    queue.length = 0;
    emitter.emit('shutdown', { timestamp: new Date(clock()).toISOString() });
  }

  recoverStuck();
  checkDiskSpace(approvedRoot);

  return {
    enqueue,
    getStatus,
    getAuditLog,
    getQueueDepth,
    recoverStuck,
    checkDiskSpace,
    shutdown,
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    off: emitter.removeListener.bind(emitter),
    emit: emitter.emit.bind(emitter),
    RSYNC_DEST,
    VALID_STATES,
    TRANSITIONS
  };
}

module.exports = { createFinalizer, defaultRunner, defaultClock };
