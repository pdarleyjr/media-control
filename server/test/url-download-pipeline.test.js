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
      content_type TEXT,
      remote_url TEXT,
      processing_status TEXT,
      processing_error TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER
    );
    CREATE TABLE download_jobs (
      id TEXT PRIMARY KEY,
      content_id TEXT,
      title TEXT,
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
        return { stdout: '__MBFD_TITLE__Pump Operations: Drafting & Supply\n' };
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
    const content = db.prepare("SELECT filename, filepath, file_size, processing_status, remote_url, content_type FROM content WHERE id='content-1'").get();
    assert.equal(content.filename, 'Pump Operations: Drafting & Supply');
    assert.equal(content.remote_url, null);
    assert.equal(content.processing_status, 'ready');
    assert.equal(content.content_type, 'video');
    assert.ok(content.file_size > 0);
    assert.ok(content.filepath);
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

test('YouTube HTTP 403 retries once with the token-free Safari client and removes format fragments', async () => {
  const db = createDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-youtube-fallback-'));
  db.prepare(`
    UPDATE content SET remote_url='https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    WHERE id='content-1'
  `).run();
  const youtubeJob = {
    ...job(),
    payload: {
      ...job().payload,
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    },
  };
  const calls = [];
  try {
    const pipeline = new MediaPipeline({
      db,
      contentDir: dir,
      urlSafetyCheck: safeUrl,
      normalizeVideoJob: readyNormalizer(db),
      execFile: async (command, args) => {
        calls.push({ command, args });
        const outputPath = args[args.indexOf('-o') + 1];
        if (calls.length === 1) {
          fs.writeFileSync(path.join(dir, 'content-1.download.part.f299.mp4.part'), 'partial-video');
          fs.writeFileSync(path.join(dir, 'content-1.download.part.f140.m4a.part'), 'partial-audio');
          const error = new Error('unable to download video data: HTTP Error 403: Forbidden');
          error.code = 1;
          throw error;
        }
        assert.equal(
          fs.existsSync(path.join(dir, 'content-1.download.part.f299.mp4.part')),
          false,
        );
        assert.equal(
          fs.existsSync(path.join(dir, 'content-1.download.part.f140.m4a.part')),
          false,
        );
        fs.writeFileSync(outputPath, 'downloaded-with-fallback');
      },
    });

    const result = await pipeline._handleUrlDownload(youtubeJob, context);
    assert.equal(result.status, 'ready');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].args.includes('--extractor-args'), false);
    const extractorIndex = calls[1].args.indexOf('--extractor-args');
    assert.notEqual(extractorIndex, -1);
    assert.equal(calls[1].args[extractorIndex + 1], 'youtube:player_client=web_safari');
    assert.equal(
      db.prepare("SELECT status FROM download_jobs WHERE id='download-1'").get().status,
      'done',
    );
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('YouTube Safari format loss falls through to the embedded client and cleans both attempts', async () => {
  const db = createDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-youtube-client-chain-'));
  db.prepare(`
    UPDATE content SET remote_url='https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    WHERE id='content-1'
  `).run();
  const youtubeJob = {
    ...job(),
    payload: {
      ...job().payload,
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    },
  };
  const calls = [];
  try {
    const pipeline = new MediaPipeline({
      db,
      contentDir: dir,
      urlSafetyCheck: safeUrl,
      normalizeVideoJob: readyNormalizer(db),
      execFile: async (command, args) => {
        calls.push({ command, args });
        const outputPath = args[args.indexOf('-o') + 1];
        if (calls.length === 1) {
          fs.writeFileSync(path.join(dir, 'content-1.download.part.f299.mp4.part'), 'primary');
          throw new Error('unable to download video data: HTTP Error 403: Forbidden');
        }
        if (calls.length === 2) {
          assert.equal(
            fs.existsSync(path.join(dir, 'content-1.download.part.f299.mp4.part')),
            false,
          );
          fs.writeFileSync(path.join(dir, 'content-1.download.part.f140.m4a.part'), 'safari');
          throw new Error('Requested format is not available. Use --list-formats');
        }
        assert.equal(
          fs.existsSync(path.join(dir, 'content-1.download.part.f140.m4a.part')),
          false,
        );
        fs.writeFileSync(outputPath, 'downloaded-with-embedded-client');
      },
    });

    const result = await pipeline._handleUrlDownload(youtubeJob, context);
    assert.equal(result.status, 'ready');
    assert.equal(calls.length, 3);
    assert.equal(calls[0].args.includes('--extractor-args'), false);
    const clients = calls.slice(1).map(({ args }) => {
      const extractorIndex = args.indexOf('--extractor-args');
      assert.notEqual(extractorIndex, -1);
      return args[extractorIndex + 1];
    });
    assert.deepEqual(clients, [
      'youtube:player_client=web_safari',
      'youtube:player_client=web_embedded',
    ]);
    assert.equal(
      db.prepare("SELECT status FROM download_jobs WHERE id='download-1'").get().status,
      'done',
    );
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('non-YouTube HTTP 403 is not retried with a YouTube extractor client', async () => {
  const db = createDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-url-no-fallback-'));
  let calls = 0;
  try {
    const pipeline = new MediaPipeline({
      db,
      contentDir: dir,
      urlSafetyCheck: safeUrl,
      normalizeVideoJob: readyNormalizer(db),
      execFile: async () => {
        calls += 1;
        const error = new Error('HTTP Error 403: Forbidden');
        error.code = 1;
        throw error;
      },
    });
    await assert.rejects(
      pipeline._handleUrlDownload(job(), context),
      /HTTP Error 403/,
    );
    assert.equal(calls, 1);
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

test('an in-flight download cannot resurrect catalog rows or bytes after permanent erase wins the race', async () => {
  const db = createDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-url-erased-race-'));
  try {
    const pipeline = new MediaPipeline({
      db,
      contentDir: dir,
      urlSafetyCheck: safeUrl,
      normalizeVideoJob: async () => assert.fail('normalization must not run after erase'),
      execFile: async (_command, args) => {
        db.prepare("UPDATE download_jobs SET status='error', error_msg='Content permanently erased' WHERE id='download-1'").run();
        db.prepare("DELETE FROM content WHERE id='content-1'").run();
        fs.writeFileSync(args[args.indexOf('-o') + 1], 'completed-after-erase');
      },
    });

    const result = await pipeline._handleUrlDownload(job(), context);
    assert.deepEqual(result, { status: 'stale', reason: 'content_changed' });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM content WHERE id='content-1'").get().count, 0);
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.equal(db.prepare("SELECT status FROM download_jobs WHERE id='download-1'").get().status, 'error');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
