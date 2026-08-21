'use strict';

const { randomUUID } = require('crypto');

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const VALID_STAGES = new Set([
  'received', 'validating', 'downloading', 'probing', 'transcoding',
  'optimizing', 'thumbnail', 'checksum', 'finalizing', 'publishing',
  'preparing', 'ready', 'failed', 'cancelled',
]);

function json(value) {
  return value == null ? null : JSON.stringify(value);
}

function boundedText(value, max = 2000) {
  return value == null ? null : String(value).slice(0, max);
}

function parseJson(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function shapeJob(row) {
  if (!row) return null;
  return {
    ...row,
    payload: parseJson(row.payload_json),
    result: parseJson(row.result_json),
  };
}

class MediaJobStore {
  constructor(db, options = {}) {
    if (!db || typeof db.prepare !== 'function') throw new Error('media job store requires SQLite');
    this.db = db;
    this.now = options.now || (() => Math.floor(Date.now() / 1000));
    this.uuid = options.uuid || randomUUID;
  }

  _event(jobId, detail = null) {
    const job = this.db.prepare(
      'SELECT status, stage, progress_pct FROM media_jobs WHERE id=?',
    ).get(jobId);
    if (!job) return;
    this.db.prepare(`
      INSERT INTO media_job_events
        (job_id, status, stage, progress_pct, detail_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(jobId, job.status, job.stage, job.progress_pct, json(detail), this.now());
  }

  get(jobId) {
    return shapeJob(this.db.prepare('SELECT * FROM media_jobs WHERE id=?').get(jobId));
  }

  latestEvent(jobId) {
    const row = this.db.prepare(`SELECT status,stage,progress_pct,detail_json,created_at
      FROM media_job_events WHERE job_id=? ORDER BY id DESC LIMIT 1`).get(jobId);
    if (!row) return null;
    return { ...row, detail: parseJson(row.detail_json) };
  }

  list({ workspaceId, contentId, limit = 100 } = {}) {
    const clauses = [];
    const params = [];
    if (workspaceId) { clauses.push('workspace_id=?'); params.push(workspaceId); }
    if (contentId) { clauses.push('content_id=?'); params.push(contentId); }
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
    const sql = `SELECT * FROM media_jobs${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY created_at DESC, id DESC LIMIT ?`;
    return this.db.prepare(sql).all(...params, safeLimit).map(shapeJob);
  }

  enqueue(input = {}) {
    const now = this.now();
    const id = String(input.id || this.uuid());
    const workspaceId = String(input.workspaceId || '');
    const jobType = String(input.jobType || '');
    if (!workspaceId || !jobType) throw new Error('workspace_id_and_job_type_required');
    const idempotencyKey = input.idempotencyKey == null
      ? null
      : String(input.idempotencyKey).slice(0, 500);
    const maxAttempts = Math.max(1, Math.min(Number(input.maxAttempts) || 3, 20));
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO media_jobs (
        id, content_id, workspace_id, user_id, job_type, source_type,
        source_identity, idempotency_key, expected_version, expected_filepath,
        expected_sha256, status, stage, progress_pct, attempts, max_attempts,
        reserved_bytes, available_at, cancel_requested, retryable,
        payload_json, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        'queued', 'received', 0, 0, ?, ?, ?, 0, 0, ?, ?, ?
      )
    `).run(
      id,
      input.contentId || null,
      workspaceId,
      input.userId || null,
      jobType,
      input.sourceType || null,
      input.sourceIdentity || null,
      idempotencyKey,
      input.expectedVersion == null ? null : Number(input.expectedVersion),
      input.expectedFilepath == null ? null : String(input.expectedFilepath),
      input.expectedSha256 || null,
      maxAttempts,
      Math.max(0, Math.floor(Number(input.reservedBytes) || 0)),
      Number(input.availableAt) || now,
      json(input.payload),
      now,
      now,
    );
    const row = result.changes
      ? this.db.prepare('SELECT * FROM media_jobs WHERE id=?').get(id)
      : this.db.prepare(
        'SELECT * FROM media_jobs WHERE workspace_id=? AND idempotency_key=?',
      ).get(workspaceId, idempotencyKey);
    if (!row) throw new Error('media_job_enqueue_conflict');
    if (result.changes) this._event(row.id, { enqueued: true });
    return { job: shapeJob(row), created: result.changes > 0 };
  }

  claimNext({ workerId, jobTypes, leaseSeconds = 300 } = {}) {
    const owner = String(workerId || '');
    if (!owner) throw new Error('worker_id_required');
    const now = this.now();
    const lease = Math.max(5, Math.min(Number(leaseSeconds) || 300, 3600));
    const types = Array.isArray(jobTypes) ? jobTypes.filter(Boolean).map(String) : [];
    const claim = this.db.transaction(() => {
      const typeSql = types.length ? ` AND job_type IN (${types.map(() => '?').join(',')})` : '';
      const row = this.db.prepare(`
        SELECT id FROM media_jobs
        WHERE cancel_requested=0
          AND attempts < max_attempts
          AND (
            (status IN ('queued','retry_wait') AND available_at <= ?)
            OR (status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
          )
          ${typeSql}
        ORDER BY
          CASE status WHEN 'running' THEN 0 ELSE 1 END,
          available_at ASC, created_at ASC, id ASC
        LIMIT 1
      `).get(now, now, ...types);
      if (!row) return null;
      const updated = this.db.prepare(`
        UPDATE media_jobs
        SET status='running',
            stage=CASE WHEN status='running' THEN stage ELSE 'validating' END,
            progress_pct=CASE WHEN progress_pct >= 100 THEN 0 ELSE progress_pct END,
            attempts=attempts + 1,
            lease_owner=?,
            lease_expires_at=?,
            error_code=NULL,
            error_message=NULL,
            started_at=COALESCE(started_at, ?),
            updated_at=?
        WHERE id=?
          AND cancel_requested=0
          AND attempts < max_attempts
          AND (
            (status IN ('queued','retry_wait') AND available_at <= ?)
            OR (status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
          )
      `).run(owner, now + lease, now, now, row.id, now, now);
      return updated.changes ? this.db.prepare('SELECT * FROM media_jobs WHERE id=?').get(row.id) : null;
    });
    const row = claim();
    if (row) this._event(row.id, { claimed_by: owner });
    return shapeJob(row);
  }

  updateProgress(jobId, workerId, { stage, progressPct, detail } = {}) {
    const normalizedStage = VALID_STAGES.has(stage) ? stage : 'optimizing';
    // Only a terminal completion may report 100%. This keeps upload/process
    // clients truthful while server-side work is still running.
    const progress = Math.max(0, Math.min(Number(progressPct) || 0, 99));
    const now = this.now();
    const result = this.db.prepare(`
      UPDATE media_jobs SET stage=?, progress_pct=?, updated_at=?
      WHERE id=? AND status='running' AND lease_owner=? AND cancel_requested=0
    `).run(normalizedStage, progress, now, jobId, workerId);
    if (!result.changes) return null;
    this._event(jobId, detail);
    return this.get(jobId);
  }

  heartbeat(jobId, workerId, leaseSeconds = 300) {
    const now = this.now();
    const result = this.db.prepare(`
      UPDATE media_jobs SET lease_expires_at=?, updated_at=?
      WHERE id=? AND status='running' AND lease_owner=?
    `).run(now + Math.max(5, Number(leaseSeconds) || 300), now, jobId, workerId);
    return result.changes > 0;
  }

  complete(jobId, workerId, resultValue = null) {
    const now = this.now();
    const mediaPreparing = resultValue?.media_preparing === true;
    const result = this.db.prepare(`
      UPDATE media_jobs
      SET status='completed', stage=?, progress_pct=?,
          result_json=?, error_code=NULL, error_message=NULL, retryable=0,
          lease_owner=NULL, lease_expires_at=NULL, completed_at=?, updated_at=?
      WHERE id=? AND status='running' AND lease_owner=? AND cancel_requested=0
    `).run(mediaPreparing ? 'preparing' : 'ready', mediaPreparing ? 99 : 100,
      json(resultValue), now, now, jobId, workerId);
    if (!result.changes) return null;
    this._event(jobId, { completed: true });
    return this.get(jobId);
  }

  fail(jobId, workerId, error = {}) {
    const now = this.now();
    const current = this.db.prepare(
      "SELECT * FROM media_jobs WHERE id=? AND status='running' AND lease_owner=?",
    ).get(jobId, workerId);
    if (!current) return null;
    const canRetry = error.retryable === true && current.attempts < current.max_attempts;
    const backoff = Math.max(
      1,
      Math.min(Number(error.retryDelaySeconds) || 2 ** Math.max(0, current.attempts - 1) * 15, 3600),
    );
    this.db.prepare(`
      UPDATE media_jobs
      SET status=?, stage='failed', progress_pct=CASE WHEN ? THEN progress_pct ELSE 0 END,
          error_code=?, error_message=?, retryable=?,
          available_at=?, lease_owner=NULL, lease_expires_at=NULL,
          completed_at=?, updated_at=?
      WHERE id=? AND status='running' AND lease_owner=?
    `).run(
      canRetry ? 'retry_wait' : 'failed',
      canRetry ? 1 : 0,
      boundedText(error.code || 'media_job_failed', 200),
      boundedText(error.message || error.code || 'Media processing failed'),
      error.retryable === true ? 1 : 0,
      canRetry ? now + backoff : now,
      canRetry ? null : now,
      now,
      jobId,
      workerId,
    );
    this._event(jobId, { retry_scheduled: canRetry });
    return this.get(jobId);
  }

  requestCancel(jobId) {
    const now = this.now();
    const transaction = this.db.transaction(() => {
      const current = this.db.prepare('SELECT * FROM media_jobs WHERE id=?').get(jobId);
      if (!current || TERMINAL.has(current.status)) return current || null;
      if (current.status === 'running') {
        this.db.prepare(
          'UPDATE media_jobs SET cancel_requested=1, updated_at=? WHERE id=?',
        ).run(now, jobId);
      } else {
        this.db.prepare(`
          UPDATE media_jobs SET status='cancelled', stage='cancelled',
            cancel_requested=1, lease_owner=NULL, lease_expires_at=NULL,
            completed_at=?, updated_at=?
          WHERE id=?
        `).run(now, now, jobId);
      }
      return this.db.prepare('SELECT * FROM media_jobs WHERE id=?').get(jobId);
    });
    const row = transaction();
    if (row) this._event(jobId, { cancel_requested: true });
    return shapeJob(row);
  }

  markCancelled(jobId, workerId) {
    const now = this.now();
    const result = this.db.prepare(`
      UPDATE media_jobs
      SET status='cancelled', stage='cancelled', cancel_requested=1,
          retryable=0, error_code='media_job_cancelled',
          error_message='Media job cancelled',
          lease_owner=NULL, lease_expires_at=NULL,
          completed_at=?, updated_at=?
      WHERE id=? AND status='running' AND lease_owner=? AND cancel_requested=1
    `).run(now, now, jobId, workerId);
    if (!result.changes) return null;
    this._event(jobId, { cancelled: true });
    return this.get(jobId);
  }

  settleExpiredCancellations() {
    const now = this.now();
    const rows = this.db.prepare(`
      SELECT id FROM media_jobs
      WHERE status='running' AND cancel_requested=1
        AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
    `).all(now);
    if (!rows.length) return 0;
    const settle = this.db.transaction(() => {
      let changed = 0;
      const update = this.db.prepare(`
        UPDATE media_jobs
        SET status='cancelled', stage='cancelled', retryable=0,
            error_code='media_job_cancelled',
            error_message='Media job cancelled',
            lease_owner=NULL, lease_expires_at=NULL,
            completed_at=?, updated_at=?
        WHERE id=? AND status='running' AND cancel_requested=1
          AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
      `);
      for (const row of rows) changed += update.run(now, now, row.id, now).changes;
      return changed;
    });
    const changed = settle();
    for (const row of rows) {
      if (this.get(row.id)?.status === 'cancelled') {
        this._event(row.id, { cancelled_after_expired_lease: true });
      }
    }
    return changed;
  }

  retry(jobId, { resetAttempts = false } = {}) {
    const now = this.now();
    const result = this.db.prepare(`
      UPDATE media_jobs
      SET status='queued', stage='received', progress_pct=0,
          attempts=CASE WHEN ? THEN 0 ELSE attempts END,
          available_at=?, cancel_requested=0, lease_owner=NULL, lease_expires_at=NULL,
          error_code=NULL, error_message=NULL, completed_at=NULL, updated_at=?
      WHERE id=? AND status='failed'
    `).run(resetAttempts ? 1 : 0, now, now, jobId);
    if (!result.changes) return null;
    this._event(jobId, { manual_retry: true });
    return this.get(jobId);
  }
}

class MediaJobWorker {
  constructor(options = {}) {
    if (!options.store) throw new Error('media job worker requires a store');
    this.store = options.store;
    this.workerId = String(options.workerId || `media-worker:${process.pid}`);
    this.concurrency = Math.max(1, Math.min(Number(options.concurrency) || 1, 8));
    this.handlers = options.handlers || {};
    this.leaseSeconds = Math.max(30, Number(options.leaseSeconds) || 300);
    this.artifactStore = options.artifactStore || null;
  }

  async _run(job) {
    const handler = this.handlers[job.job_type];
    if (typeof handler !== 'function') {
      this.store.fail(job.id, this.workerId, {
        code: 'unsupported_media_job',
        message: `No handler for ${job.job_type}`,
        retryable: false,
      });
      return;
    }
    const heartbeatEveryMs = Math.max(1000, Math.floor(this.leaseSeconds * 1000 / 3));
    const heartbeatTimer = setInterval(
      () => this.store.heartbeat(job.id, this.workerId, this.leaseSeconds),
      heartbeatEveryMs,
    );
    if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
    try {
      const result = await handler(job, {
        progress: (stage, progressPct, detail) => this.store.updateProgress(
          job.id,
          this.workerId,
          { stage, progressPct, detail },
        ),
        heartbeat: () => this.store.heartbeat(job.id, this.workerId, this.leaseSeconds),
        isCancellationRequested: () => this.store.get(job.id)?.cancel_requested === 1,
        registerArtifact: (filePath) => this.artifactStore?.register(job, filePath),
        releaseArtifact: (filePath) => this.artifactStore?.release(job.id, filePath),
      });
      if (this.store.get(job.id)?.cancel_requested === 1) {
        this.store.markCancelled(job.id, this.workerId);
        return;
      }
      this.store.complete(job.id, this.workerId, result);
    } catch (error) {
      if (this.store.get(job.id)?.cancel_requested === 1) {
        this.store.markCancelled(job.id, this.workerId);
        return;
      }
      this.store.fail(job.id, this.workerId, {
        code: error.code || 'media_job_failed',
        message: error.message,
        retryable: error.retryable !== false,
        retryDelaySeconds: error.retryDelaySeconds,
      });
    } finally {
      clearInterval(heartbeatTimer);
      if (this.artifactStore) await this.artifactStore.cleanupJob(job.id);
    }
  }

  async drain({ jobTypes } = {}) {
    let processed = 0;
    for (;;) {
      this.store.settleExpiredCancellations();
      const batch = [];
      while (batch.length < this.concurrency) {
        const job = this.store.claimNext({
          workerId: this.workerId,
          jobTypes,
          leaseSeconds: this.leaseSeconds,
        });
        if (!job) break;
        batch.push(job);
      }
      if (!batch.length) return processed;
      await Promise.all(batch.map((job) => this._run(job)));
      processed += batch.length;
    }
  }
}

module.exports = {
  MediaJobStore,
  MediaJobWorker,
  shapeJob,
};
