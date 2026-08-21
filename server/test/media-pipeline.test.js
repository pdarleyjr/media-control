'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const {
  MEDIA_PIPELINE_MIGRATION_ID,
  migrateMediaPipeline,
} = require('../db/migrations/media-pipeline');
const { MediaJobStore, MediaJobWorker } = require('../lib/media-jobs');
const { MediaPipeline } = require('../lib/media-pipeline');

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE schema_migrations (
      id TEXT PRIMARY KEY,
      ran_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE content (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      user_id TEXT,
      filepath TEXT NOT NULL DEFAULT '',
      remote_url TEXT,
      mime_type TEXT,
      processing_status TEXT,
      processing_error TEXT,
      updated_at INTEGER,
      version INTEGER NOT NULL DEFAULT 1
    );
    INSERT INTO content (id, workspace_id, user_id, filepath, version)
    VALUES ('content-1', 'workspace-1', 'user-1', 'source.mp4', 7);
  `);
  return db;
}

test('media pipeline migration is additive, constrained, indexed, and idempotent', () => {
  const db = createDb();
  try {
    migrateMediaPipeline(db);
    migrateMediaPipeline(db);
    assert.ok(db.prepare('SELECT 1 FROM schema_migrations WHERE id=?').get(MEDIA_PIPELINE_MIGRATION_ID));
    assert.deepEqual(
      db.prepare('PRAGMA table_info(media_jobs)').all().map((column) => column.name),
      [
        'id', 'content_id', 'workspace_id', 'user_id', 'job_type', 'source_type',
        'source_identity', 'idempotency_key', 'expected_version', 'expected_filepath',
        'expected_sha256', 'status', 'stage', 'progress_pct', 'attempts', 'max_attempts',
        'reserved_bytes', 'available_at', 'lease_owner', 'lease_expires_at', 'cancel_requested',
        'error_code', 'error_message', 'retryable', 'payload_json', 'result_json',
        'created_at', 'updated_at', 'started_at', 'completed_at',
      ],
    );
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_media_jobs_claim'").get());
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='content_media_metadata'").get());
    assert.throws(
      () => db.prepare(`
        INSERT INTO media_jobs
          (id, workspace_id, job_type, status, stage, progress_pct, attempts, max_attempts,
           available_at, cancel_requested, retryable, created_at, updated_at)
        VALUES ('bad', 'workspace-1', 'video_normalize', 'nonsense', 'received', 0, 0, 3, 1, 0, 0, 1, 1)
      `).run(),
      /CHECK constraint failed/,
    );
  } finally {
    db.close();
  }
});

test('enqueue is idempotent per workspace and source generation', () => {
  const db = createDb();
  let sequence = 0;
  try {
    migrateMediaPipeline(db);
    const store = new MediaJobStore(db, {
      now: () => 100,
      uuid: () => `job-${++sequence}`,
    });
    const input = {
      contentId: 'content-1',
      workspaceId: 'workspace-1',
      userId: 'user-1',
      jobType: 'video_normalize',
      sourceType: 'upload',
      idempotencyKey: 'video_normalize:content-1:v7:source.mp4',
      expectedVersion: 7,
      expectedFilepath: 'source.mp4',
    };
    const first = store.enqueue(input);
    const second = store.enqueue(input);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.job.id, first.job.id);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM media_jobs').get().count, 1);
  } finally {
    db.close();
  }
});

test('claim recovers an expired lease, progress never reports false 100, and retry is bounded', () => {
  const db = createDb();
  let now = 100;
  try {
    migrateMediaPipeline(db);
    const store = new MediaJobStore(db, { now: () => now, uuid: () => 'job-1' });
    const { job } = store.enqueue({
      contentId: 'content-1',
      workspaceId: 'workspace-1',
      userId: 'user-1',
      jobType: 'video_normalize',
      idempotencyKey: 'normalize-1',
      maxAttempts: 2,
    });
    const claimed = store.claimNext({ workerId: 'worker-a', leaseSeconds: 10 });
    assert.equal(claimed.id, job.id);
    assert.equal(claimed.status, 'running');
    assert.equal(claimed.attempts, 1);
    assert.equal(store.updateProgress(job.id, 'worker-a', {
      stage: 'optimizing', progressPct: 100,
      detail: { step: 'qwen-semantic-design', slide_current: 7, slide_total: 23, ai_active: true },
    }).progress_pct, 99);
    assert.deepEqual(store.latestEvent(job.id).detail, {
      step: 'qwen-semantic-design', slide_current: 7, slide_total: 23, ai_active: true,
    });

    now = 111;
    const recovered = store.claimNext({ workerId: 'worker-b', leaseSeconds: 10 });
    assert.equal(recovered.id, job.id);
    assert.equal(recovered.lease_owner, 'worker-b');
    assert.equal(recovered.attempts, 2);
    const failed = store.fail(job.id, 'worker-b', {
      code: 'ffmpeg_timeout',
      message: 'timed out',
      retryable: true,
    });
    assert.equal(failed.status, 'failed', 'max attempts prevents an infinite retry loop');
    assert.equal(failed.retryable, 1);
    assert.equal(store.claimNext({ workerId: 'worker-c' }), null);
  } finally {
    db.close();
  }
});

test('worker enforces configured concurrency and marks successful jobs complete', async () => {
  const db = createDb();
  let nextId = 0;
  let active = 0;
  let maxActive = 0;
  try {
    migrateMediaPipeline(db);
    const store = new MediaJobStore(db, {
      now: () => Math.floor(Date.now() / 1000),
      uuid: () => `job-${++nextId}`,
    });
    for (let index = 0; index < 4; index += 1) {
      store.enqueue({
        contentId: 'content-1',
        workspaceId: 'workspace-1',
        jobType: 'thumbnail',
        idempotencyKey: `thumb-${index}`,
      });
    }
    const worker = new MediaJobWorker({
      store,
      workerId: 'bounded-worker',
      concurrency: 2,
      handlers: {
        thumbnail: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 10));
          active -= 1;
          return { poster: true };
        },
      },
    });
    await worker.drain();
    assert.equal(maxActive, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM media_jobs WHERE status='completed'").get().count, 4);
    assert.equal(db.prepare("SELECT MIN(progress_pct) AS progress FROM media_jobs").get().progress, 100);
  } finally {
    db.close();
  }
});

test('thumbnail studio completes through only database-supported progress stages', async () => {
  const db = createDb();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-media-pipeline-poster-'));
  const sourcePath = path.join(tmp, 'source.mp4');
  fs.writeFileSync(sourcePath, 'canonical-video-bytes');
  try {
    db.exec(`
      ALTER TABLE content ADD COLUMN duration_sec REAL;
      ALTER TABLE content ADD COLUMN thumbnail_path TEXT;
      UPDATE content
      SET mime_type='video/mp4', processing_status='ready', duration_sec=10
      WHERE id='content-1';
    `);
    const pipeline = new MediaPipeline({
      db,
      contentDir: tmp,
      now: () => 200,
      createThumbnailStudioCandidate: async () => {
        const thumbnailPath = path.join(tmp, 'thumb_content-1.jpg');
        fs.writeFileSync(thumbnailPath, 'jpeg-poster-bytes');
        return {
          thumbnailPath,
          thumbnailFilename: path.basename(thumbnailPath),
          provenance: 'video_timestamp:center',
        };
      },
    });
    pipeline.store.enqueue({
      contentId: 'content-1',
      workspaceId: 'workspace-1',
      userId: 'user-1',
      jobType: 'thumbnail_studio',
      sourceType: 'thumbnail_regenerate',
      idempotencyKey: 'poster:content-1:v7:test',
      expectedVersion: 7,
      expectedFilepath: 'source.mp4',
      payload: { timestampSeconds: 0, position: 'center' },
      maxAttempts: 1,
    });

    await pipeline.worker.drain();

    const job = pipeline.store.list({ workspaceId: 'workspace-1' })[0];
    assert.equal(job.status, 'completed');
    assert.equal(job.stage, 'ready');
    assert.equal(
      db.prepare("SELECT thumbnail_path FROM content WHERE id='content-1'").get().thumbnail_path,
      'thumb_content-1.jpg',
    );
  } finally {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a cooperative running cancellation reaches the cancelled terminal state', async () => {
  const db = createDb();
  try {
    migrateMediaPipeline(db);
    const store = new MediaJobStore(db, { uuid: () => 'job-cancel' });
    store.enqueue({
      contentId: 'content-1',
      workspaceId: 'workspace-1',
      jobType: 'thumbnail',
    });
    const worker = new MediaJobWorker({
      store,
      workerId: 'cancel-worker',
      handlers: {
        thumbnail: async (job, context) => {
          store.requestCancel(job.id);
          assert.equal(context.isCancellationRequested(), true);
          return { discarded: true };
        },
      },
    });
    await worker.drain();
    const cancelled = store.get('job-cancel');
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.stage, 'cancelled');
    assert.equal(cancelled.completed_at > 0, true);
  } finally {
    db.close();
  }
});

test('worker heartbeats keep a long-running lease owned until completion', async () => {
  const db = createDb();
  let now = 100;
  try {
    migrateMediaPipeline(db);
    const store = new MediaJobStore(db, { now: () => now, uuid: () => 'job-heartbeat' });
    store.enqueue({
      contentId: 'content-1',
      workspaceId: 'workspace-1',
      jobType: 'thumbnail',
    });
    const worker = new MediaJobWorker({
      store,
      workerId: 'heartbeat-worker',
      leaseSeconds: 30,
      handlers: {
        thumbnail: async (_job, context) => {
          now = 120;
          assert.equal(context.heartbeat(), true);
          assert.equal(store.get('job-heartbeat').lease_expires_at, 150);
          return { ok: true };
        },
      },
    });
    await worker.drain();
    assert.equal(store.get('job-heartbeat').status, 'completed');
  } finally {
    db.close();
  }
});

test('a cancellation-requested worker keeps heartbeating until its handler exits', () => {
  const db = createDb();
  let now = 100;
  try {
    migrateMediaPipeline(db);
    const store = new MediaJobStore(db, { now: () => now, uuid: () => 'job-cancel-heartbeat' });
    store.enqueue({ contentId: 'content-1', workspaceId: 'workspace-1', jobType: 'thumbnail' });
    store.claimNext({ workerId: 'worker-a', leaseSeconds: 30 });
    store.requestCancel('job-cancel-heartbeat');
    now = 120;
    assert.equal(store.heartbeat('job-cancel-heartbeat', 'worker-a', 30), true);
    assert.equal(store.get('job-cancel-heartbeat').lease_expires_at, 150);
  } finally {
    db.close();
  }
});

test('remote validation failure persists a repairable health record without fetching private targets', async () => {
  const db = createDb();
  try {
    db.prepare(`
      UPDATE content
      SET remote_url='http://127.0.0.1/private.mp4',
          mime_type='application/octet-stream',
          processing_status='processing'
      WHERE id='content-1'
    `).run();
    const pipeline = new MediaPipeline({ db, contentDir: process.cwd() });
    await assert.rejects(
      pipeline._handleRemote({
        id: 'remote-job',
        content_id: 'content-1',
        expected_version: 7,
        payload: { url: 'http://127.0.0.1/private.mp4' },
      }, {
        progress: () => {},
      }),
      (error) => error.code === 'private_target' && error.retryable === false,
    );
    const metadata = db.prepare(
      "SELECT * FROM content_media_metadata WHERE content_id='content-1'",
    ).get();
    assert.equal(metadata.remote_health_status, 'unhealthy');
    assert.equal(metadata.remote_error_code, 'private_target');
    assert.equal(metadata.remote_source_kind, null);
    assert.equal(
      db.prepare("SELECT processing_status FROM content WHERE id='content-1'").get().processing_status,
      'failed',
    );
  } finally {
    db.close();
  }
});

test('an expired cancelled lease is terminally reconciled after worker restart', () => {
  const db = createDb();
  let now = 100;
  try {
    migrateMediaPipeline(db);
    const store = new MediaJobStore(db, { now: () => now, uuid: () => 'job-expired-cancel' });
    store.enqueue({
      contentId: 'content-1',
      workspaceId: 'workspace-1',
      jobType: 'thumbnail',
    });
    store.claimNext({ workerId: 'dead-worker', leaseSeconds: 10 });
    store.requestCancel('job-expired-cancel');
    now = 111;
    assert.equal(store.settleExpiredCancellations(), 1);
    assert.equal(store.get('job-expired-cancel').status, 'cancelled');
  } finally {
    db.close();
  }
});
