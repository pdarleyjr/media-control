'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { migrateMediaPipeline } = require('../db/migrations/media-pipeline');
const { MediaPipeline } = require('../lib/media-pipeline');

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE schema_migrations (id TEXT PRIMARY KEY);
    CREATE TABLE content (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      workspace_id TEXT,
      filename TEXT,
      filepath TEXT NOT NULL DEFAULT '',
      mime_type TEXT,
      file_size INTEGER DEFAULT 0,
      remote_url TEXT,
      processing_status TEXT,
      processing_error TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER
    );
    CREATE TABLE download_jobs (
      id TEXT PRIMARY KEY,
      content_id TEXT,
      status TEXT,
      progress_pct INTEGER,
      local_path TEXT,
      error_msg TEXT,
      started_at INTEGER,
      completed_at INTEGER
    );
    INSERT INTO content (
      id, user_id, workspace_id, filename, remote_url, processing_status
    ) VALUES (
      'content-1', 'user-1', 'workspace-1', 'Training clip',
      'https://media.example.test/training', 'processing'
    );
    INSERT INTO download_jobs (id, content_id, status, progress_pct)
    VALUES ('download-1', 'content-1', 'pending', 0);
  `);
  migrateMediaPipeline(db);
  return db;
}

function readyNormalizer(db) {
  return async ({ contentId, expectedFilepath }) => {
    db.prepare(`
      UPDATE content
      SET processing_status='ready', processing_error=NULL,
          filepath=?, mime_type='video/mp4', version=version + 1
      WHERE id=?
    `).run(expectedFilepath, contentId);
    return { status: 'ready', content_id: contentId };
  };
}

function job() {
  return {
    id: 'media-job-1',
    content_id: 'content-1',
    expected_version: 1,
    expected_filepath: '',
    reserved_bytes: 1,
    payload: {
      url: 'https://media.example.test/training',
      downloadJobId: 'download-1',
      maxBytes: 1024 * 1024,
    },
  };
}

const context = { progress: () => {} };
const safeUrl = async (value) => ({ ok: true, parsed: new URL(value) });

test('URL download uses bounded args, canonical normalization, and removes partial state', async () => {
  const db = createDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-url-download-'));
  const calls = [];
  try {
    const pipeline = new MediaPipeline({
      db,
      contentDir: dir,
      urlSafetyCheck: safeUrl,
      normalizeVideoJob: readyNormalizer(db),
      execFile: async (command, args) => {
        calls.push({ command, args });
        fs.writeFileSync(args[args.indexOf('-o') + 1], 'downloaded-master');
      },
    });
    const result = await pipeline._handleUrlDownload(job(), context);
    assert.equal(result.status, 'ready');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'yt-dlp');
    assert.equal(calls[0].args[calls[0].args.indexOf('--concurrent-fragments') + 1], '1');
    assert.equal(fs.existsSync(path.join(dir, 'content-1.download.part.mp4')), false);
    assert.equal(fs.existsSync(path.join(dir, 'content-1.download.mp4')), true);
    const download = db.prepare("SELECT * FROM download_jobs WHERE id='download-1'").get();
    assert.equal(download.status, 'done');
    assert.equal(download.progress_pct, 100);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('restart adopts a deterministic completed download without downloading twice', async () => {
  const db = createDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-url-restart-'));
  fs.writeFileSync(path.join(dir, 'content-1.download.mp4'), 'completed-before-restart');
  let execCalls = 0;
  try {
    const pipeline = new MediaPipeline({
      db,
      contentDir: dir,
      urlSafetyCheck: safeUrl,
      normalizeVideoJob: readyNormalizer(db),
      execFile: async () => { execCalls += 1; },
    });
    const result = await pipeline._handleUrlDownload(job(), context);
    assert.equal(result.status, 'ready');
    assert.equal(execCalls, 0);
    assert.equal(
      db.prepare("SELECT filepath FROM content WHERE id='content-1'").get().filepath,
      'content-1.download.mp4',
    );
    assert.equal(
      db.prepare("SELECT status FROM download_jobs WHERE id='download-1'").get().status,
      'done',
    );
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('failed URL download cleans partial/final files and retains repairable job state', async () => {
  const db = createDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-url-failed-'));
  try {
    const pipeline = new MediaPipeline({
      db,
      contentDir: dir,
      urlSafetyCheck: safeUrl,
      normalizeVideoJob: readyNormalizer(db),
      execFile: async (_command, args) => {
        fs.writeFileSync(args[args.indexOf('-o') + 1], 'partial');
        const error = new Error('network interrupted');
        error.code = 'download_interrupted';
        throw error;
      },
    });
    await assert.rejects(
      pipeline._handleUrlDownload(job(), context),
      (error) => error.code === 'download_interrupted',
    );
    assert.equal(fs.existsSync(path.join(dir, 'content-1.download.part.mp4')), false);
    assert.equal(fs.existsSync(path.join(dir, 'content-1.download.mp4')), false);
    assert.equal(
      db.prepare("SELECT status FROM download_jobs WHERE id='download-1'").get().status,
      'error',
    );
    assert.equal(
      db.prepare("SELECT processing_status FROM content WHERE id='content-1'").get().processing_status,
      'failed',
    );
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('malformed content identity cannot place URL download output outside the content directory', async () => {
  const db = createDb();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-url-path-'));
  const dir = path.join(root, 'content');
  fs.mkdirSync(dir);
  try {
    db.prepare("UPDATE content SET id='../escaped' WHERE id='content-1'").run();
    const pipeline = new MediaPipeline({
      db,
      contentDir: dir,
      urlSafetyCheck: safeUrl,
      normalizeVideoJob: async () => assert.fail('normalization must not run'),
      execFile: async (_command, args) => {
        fs.writeFileSync(args[args.indexOf('-o') + 1], 'must-not-write');
      },
    });
    await assert.rejects(
      pipeline._handleUrlDownload({
        ...job(),
        content_id: '../escaped',
      }, context),
      (error) => error.code === 'path_outside_content_directory',
    );
    assert.deepEqual(fs.readdirSync(root), ['content']);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
