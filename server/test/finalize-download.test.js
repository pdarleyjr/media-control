const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const {
  buildContentRowForDownload,
  mimeFromExt,
  resolveDownloadedFile,
  finalizeDownload,
} = require('../lib/finalize-download');

// ── Minimal in-memory DB mirroring the EXISTING columns finalizeDownload touches.
// Not the prod schema — just enough for a pure unit test of the lib function.
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE content (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      workspace_id TEXT,
      filename TEXT NOT NULL,
      filepath TEXT NOT NULL DEFAULT '',
      mime_type TEXT NOT NULL,
      file_size INTEGER NOT NULL DEFAULT 0,
      processing_status TEXT NOT NULL DEFAULT 'uploaded',
      version INTEGER NOT NULL DEFAULT 1,
      access_level TEXT NOT NULL DEFAULT 'private',
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE download_jobs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      user_id TEXT,
      source_url TEXT NOT NULL,
      title TEXT,
      local_path TEXT,
      content_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      progress_pct INTEGER DEFAULT 0,
      error_msg TEXT
    );
  `);
  return db;
}

function seedJob(db, over = {}) {
  const job = {
    id: 'job-1', workspace_id: 'ws-9', user_id: 'u-7',
    source_url: 'https://example.com/v', title: null, status: 'done', ...over,
  };
  db.prepare(`INSERT INTO download_jobs (id, workspace_id, user_id, source_url, title, status)
              VALUES (@id, @workspace_id, @user_id, @source_url, @title, @status)`).run(job);
  return job;
}

// Temp content dir with a fake finished download file for the job.
function makeContentDir(jobId, ext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-dl-'));
  if (jobId) {
    const header = Buffer.from('\x00\x00\x00\x18ftypisom\x00\x00\x00\x00isommp42', 'binary');
    fs.writeFileSync(
      path.join(dir, `${jobId}.${ext}`),
      Buffer.concat([header, Buffer.alloc(1234 - header.length, 7)]),
    );
  }
  return dir;
}

function makePipeline() {
  let sequence = 0;
  const queued = [];
  const enqueue = (kind, args) => {
    const job = { id: `media-job-${++sequence}`, status: 'queued', stage: 'received', progress_pct: 0 };
    queued.push({ kind, args, job });
    return { created: true, job };
  };
  return {
    queued,
    enqueueVideo: (args) => enqueue('video_normalize', args),
    enqueueThumbnailFinalize: (args) => enqueue('thumbnail_finalize', args),
  };
}

// ───────────────────────── pure row builder ─────────────────────────

test('buildContentRowForDownload: row gets the resolved file path + job workspace/user', () => {
  const job = { id: 'job-1', workspace_id: 'ws-9', user_id: 'u-7', title: null };
  const row = buildContentRowForDownload({ job, filename: 'job-1.mp4', size: 4242 });
  assert.equal(row.filepath, 'job-1.mp4');        // points at the finished file
  assert.equal(row.workspace_id, 'ws-9');         // scoped to the job's workspace
  assert.equal(row.user_id, 'u-7');               // owned by the requester
  assert.equal(row.mime_type, 'video/mp4');
  assert.equal(row.file_size, 4242);
  assert.equal(row.filename, 'job-1.mp4');         // no title → falls back to file basename
  assert.match(row.id, /[0-9a-f-]{36}/);           // fresh uuid
});

test('buildContentRowForDownload: user title becomes the display filename, filepath stays the on-disk name', () => {
  const job = { id: 'job-2', workspace_id: 'ws-1', user_id: 'u-1', title: 'Training Clip' };
  const row = buildContentRowForDownload({ job, filename: 'job-2.webm' });
  assert.equal(row.filename, 'Training Clip');
  assert.equal(row.filepath, 'job-2.webm');
  assert.equal(row.mime_type, 'video/webm');
  assert.equal(row.file_size, 0);                  // unknown size → 0
});

test('buildContentRowForDownload: rejects a job missing a workspace (content is workspace-scoped)', () => {
  assert.throws(
    () => buildContentRowForDownload({ job: { id: 'x', user_id: 'u' }, filename: 'x.mp4' }),
    /workspace_id is required/,
  );
});

test('mimeFromExt: known A/V extensions map; unknown falls back to video/mp4 (downloader is A/V only)', () => {
  assert.equal(mimeFromExt('.mkv'), 'video/x-matroska');
  assert.equal(mimeFromExt('.MP4'), 'video/mp4');
  assert.equal(mimeFromExt('.jpg'), 'image/jpeg');
  assert.equal(mimeFromExt('.bogus'), 'video/mp4');
});

test('resolveDownloadedFile: finds <jobId>.<ext>, ignores thumbs/partials', () => {
  const dir = makeContentDir('job-3', 'mkv');
  fs.writeFileSync(path.join(dir, 'job-3.part'), 'partial');
  fs.writeFileSync(path.join(dir, 'thumb_job-3.jpg'), 'thumb');
  assert.equal(resolveDownloadedFile(dir, 'job-3'), 'job-3.mkv');
  assert.equal(resolveDownloadedFile(dir, 'missing'), null);
});

// ───────────────────────── orchestrator: idempotency ─────────────────────────

test('finalizeDownload: completed job yields a content row with the right file path + workspace', () => {
  const db = makeDb();
  const job = seedJob(db);
  const contentDir = makeContentDir(job.id, 'mp4');
  const pipeline = makePipeline();

  const row = finalizeDownload({ db, contentDir, jobId: job.id, pipeline });

  assert.ok(row, 'a content row was created');
  assert.equal(row.filepath, 'job-1.mp4');         // reachable: points at the finished file
  assert.equal(row.workspace_id, 'ws-9');          // scoped to the job's workspace
  assert.equal(row.user_id, 'u-7');
  assert.equal(row.mime_type, 'video/mp4');
  assert.equal(row.file_size, 1234);               // real on-disk size
  assert.equal(row.access_level, 'private');       // downloads are private by default
  assert.equal(row.processing_status, 'uploaded');
  assert.equal(row.media_job.status, 'queued');
  assert.equal(pipeline.queued.length, 1);

  // The job is now linked back to the content row (no longer an orphan).
  const updated = db.prepare('SELECT content_id, local_path FROM download_jobs WHERE id = ?').get(job.id);
  assert.equal(updated.content_id, row.id);
  assert.equal(updated.local_path, 'job-1.mp4');
});

test('finalizeDownload: idempotent on re-poll — second call does NOT insert a second row', () => {
  const db = makeDb();
  const job = seedJob(db);
  const contentDir = makeContentDir(job.id, 'mp4');
  const pipeline = makePipeline();

  const first = finalizeDownload({ db, contentDir, jobId: job.id, pipeline });
  const second = finalizeDownload({ db, contentDir, jobId: job.id, pipeline });

  assert.equal(first.id, second.id, 'same content row returned both times');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM content').get().n, 1, 'exactly one content row exists');
  assert.equal(pipeline.queued.length, 1, 'restart/re-poll does not enqueue a duplicate');
});

test('finalizeDownload: re-poll after normalization never downgrades a ready generation', () => {
  const db = makeDb();
  const job = seedJob(db);
  const contentDir = makeContentDir(job.id, 'mp4');
  const pipeline = makePipeline();
  const first = finalizeDownload({ db, contentDir, jobId: job.id, pipeline });
  db.prepare("UPDATE content SET processing_status='ready', version=2 WHERE id=?").run(first.id);

  const repeated = finalizeDownload({ db, contentDir, jobId: job.id, pipeline });

  assert.equal(repeated.id, first.id);
  assert.equal(repeated.processing_status, 'ready');
  assert.equal(repeated.version, 2);
  assert.equal(pipeline.queued.length, 1);
});

test('finalizeDownload: missing linked content is fail-closed and is never recreated', () => {
  const db = makeDb();
  const job = seedJob(db);
  db.prepare('UPDATE download_jobs SET content_id=? WHERE id=?').run('missing-content', job.id);
  const contentDir = makeContentDir(job.id, 'mp4');
  const pipeline = makePipeline();

  assert.equal(finalizeDownload({ db, contentDir, jobId: job.id, pipeline }), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM content').get().n, 0);
  assert.equal(pipeline.queued.length, 0);
});

test('finalizeDownload: returns null when no finished file is on disk (nothing inserted)', () => {
  const db = makeDb();
  const job = seedJob(db);
  const emptyDir = makeContentDir(null);           // no file for the job

  const row = finalizeDownload({ db, contentDir: emptyDir, jobId: job.id, pipeline: makePipeline() });
  assert.equal(row, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM content').get().n, 0);
  assert.equal(db.prepare('SELECT content_id FROM download_jobs WHERE id = ?').get(job.id).content_id, null);
});

test('finalizeDownload: unknown job id is a safe no-op', () => {
  const db = makeDb();
  const contentDir = makeContentDir(null);
  assert.equal(finalizeDownload({ db, contentDir, jobId: 'nope', pipeline: makePipeline() }), null);
});

test('finalizeDownload cannot resurrect bytes from an erased download tombstone', () => {
  const db = makeDb();
  const job = seedJob(db);
  const contentDir = makeContentDir(job.id, 'mp4');
  db.prepare(`UPDATE download_jobs SET status='error',error_msg='Content permanently erased',
    content_id=NULL WHERE id=?`).run(job.id);
  const pipeline = makePipeline();

  assert.equal(finalizeDownload({ db, contentDir, jobId: job.id, pipeline }), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM content').get().n, 0);
  assert.equal(pipeline.queued.length, 0);
  assert.equal(fs.existsSync(path.join(contentDir, `${job.id}.mp4`)), true);
});

test('finalizeDownload rejects corrupt completed bytes without publishing or deleting evidence', () => {
  const db = makeDb();
  const job = seedJob(db);
  const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-dl-corrupt-'));
  const file = path.join(contentDir, `${job.id}.mp4`);
  fs.writeFileSync(file, 'not actually a video');
  const row = finalizeDownload({
    db,
    contentDir,
    jobId: job.id,
    pipeline: makePipeline(),
  });
  assert.equal(row, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM content').get().n, 0);
  assert.equal(db.prepare('SELECT status FROM download_jobs WHERE id=?').get(job.id).status, 'error');
  assert.equal(fs.existsSync(file), true, 'failed source remains available for diagnosis/repair');
});
