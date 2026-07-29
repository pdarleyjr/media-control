'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const { migrateMediaPipeline } = require('../db/migrations/media-pipeline');
const {
  createPeerTubeAssetHandler,
  ensurePeerTubeAssetSchema,
  peerTubeSourceIdentity,
} = require('../lib/peertube-asset-adapter');

function makeDb() {
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
      filename TEXT NOT NULL DEFAULT '',
      filepath TEXT NOT NULL DEFAULT '',
      remote_url TEXT,
      mime_type TEXT,
      file_size INTEGER NOT NULL DEFAULT 0,
      duration_sec REAL,
      thumbnail_path TEXT,
      width INTEGER,
      height INTEGER,
      original_filepath TEXT,
      original_sha256 TEXT,
      processing_status TEXT,
      processing_error TEXT,
      media_probe_json TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER
    );
    INSERT INTO content (
      id, workspace_id, user_id, filename, filepath, remote_url, mime_type,
      processing_status, version, updated_at
    ) VALUES (
      'content-1', 'workspace-1', 'user-1', 'Selected replay', '', NULL,
      'video/mp4', 'processing', 1, 100
    );
  `);
  migrateMediaPipeline(db);
  ensurePeerTubeAssetSchema(db);
  return db;
}

function response(body, headers = {}) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({
      'content-type': 'video/mp4',
      'content-length': String(body.length),
      ...headers,
    }),
    body: (async function* stream() { yield body; }()),
  };
}

test('PeerTube source identities are canonical and reject non-UUID-like input', () => {
  assert.equal(
    peerTubeSourceIdentity(' 9c0ef6aa-f043-4a9d-bc86-bdb0ea03007c '),
    'peertube:9c0ef6aa-f043-4a9d-bc86-bdb0ea03007c',
  );
  assert.throws(() => peerTubeSourceIdentity('../secret'), /invalid_peertube_video_uuid/);
});

test('adapter schema enforces one selected PeerTube source binding per workspace', () => {
  const db = makeDb();
  try {
    ensurePeerTubeAssetSchema(db);
    db.prepare(`
      INSERT INTO content_media_metadata
        (content_id, workspace_id, source_type, source_identity, created_at, updated_at)
      VALUES ('content-1', 'workspace-1', 'peertube', 'peertube:video-1', 1, 1)
    `).run();
    db.exec(`
      INSERT INTO content (
        id, workspace_id, user_id, filename, filepath, mime_type,
        processing_status, version, updated_at
      ) VALUES (
        'content-2', 'workspace-1', 'user-1', 'Duplicate', '', 'video/mp4',
        'processing', 1, 100
      )
    `);
    assert.throws(() => db.prepare(`
      INSERT INTO content_media_metadata
        (content_id, workspace_id, source_type, source_identity, created_at, updated_at)
      VALUES ('content-2', 'workspace-1', 'peertube', 'peertube:video-1', 1, 1)
    `).run(), /UNIQUE constraint failed/);
  } finally {
    db.close();
  }
});

test('selected replay is downloaded once through the private adapter then normalized locally', async () => {
  const db = makeDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-peertube-asset-'));
  const calls = [];
  try {
    const handler = createPeerTubeAssetHandler({
      db,
      contentDir: dir,
      now: () => 200,
      fetchPlaybackResponse: async (replayId, options) => {
        calls.push({ replayId, options });
        return response(Buffer.from('classroom-safe-video'));
      },
      normalizeVideoJob: async (job) => {
        assert.equal(job.contentId, 'content-1');
        assert.equal(fs.readFileSync(job.absPath, 'utf8'), 'classroom-safe-video');
        db.prepare(`
          UPDATE content
          SET processing_status='ready', file_size=?, updated_at=?
          WHERE id=?
        `).run(fs.statSync(job.absPath).size, 200, job.contentId);
        return { status: 'ready', content_id: job.contentId, generation: 2 };
      },
    });

    const result = await handler({
      id: 'job-1',
      content_id: 'content-1',
      workspace_id: 'workspace-1',
      expected_version: 1,
      expected_filepath: '',
      attempts: 1,
      max_attempts: 5,
      payload: {
        replayId: 'replay-1',
        videoUuid: '9c0ef6aa-f043-4a9d-bc86-bdb0ea03007c',
        maxBytes: 1024,
      },
    }, {
      progress() {},
      isCancellationRequested: () => false,
    });

    assert.equal(result.status, 'ready');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].replayId, 'replay-1');
    assert.equal(calls[0].options.range, null);
    const content = db.prepare('SELECT * FROM content WHERE id=?').get('content-1');
    assert.equal(content.remote_url, null);
    assert.match(content.filepath, /^content-1\.peertube\.mp4$/);
    assert.equal(content.processing_status, 'ready');
    const metadata = db.prepare(
      'SELECT * FROM content_media_metadata WHERE content_id=?',
    ).get('content-1');
    assert.equal(metadata.source_type, 'peertube');
    assert.equal(
      metadata.source_identity,
      'peertube:9c0ef6aa-f043-4a9d-bc86-bdb0ea03007c',
    );
    assert.equal(metadata.remote_health_status, 'localized');
    assert.doesNotMatch(JSON.stringify(metadata), /bearer|authorization|token/i);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('temporary PeerTube outage remains retryable and leaves no partial classroom asset', async () => {
  const db = makeDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-peertube-outage-'));
  try {
    const handler = createPeerTubeAssetHandler({
      db,
      contentDir: dir,
      now: () => 300,
      fetchPlaybackResponse: async () => {
        throw Object.assign(new Error('PeerTube unavailable'), { status: 503 });
      },
      normalizeVideoJob: async () => assert.fail('normalization must not run'),
    });
    await assert.rejects(
      handler({
        id: 'job-2',
        content_id: 'content-1',
        workspace_id: 'workspace-1',
        expected_version: 1,
        expected_filepath: '',
        attempts: 1,
        max_attempts: 5,
        payload: {
          replayId: 'replay-1',
          videoUuid: '9c0ef6aa-f043-4a9d-bc86-bdb0ea03007c',
          maxBytes: 1024,
        },
      }, {
        progress() {},
        isCancellationRequested: () => false,
      }),
      (caught) => caught.code === 'peertube_unavailable' && caught.retryable === true,
    );
    assert.deepEqual(fs.readdirSync(dir), []);
    const content = db.prepare(
      'SELECT processing_status, processing_error, filepath FROM content WHERE id=?',
    ).get('content-1');
    assert.equal(content.processing_status, 'processing');
    assert.equal(content.processing_error, 'peertube_unavailable');
    assert.equal(content.filepath, '');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('malformed job identity cannot place a PeerTube partial outside the content directory', async () => {
  const db = makeDb();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-peertube-path-'));
  const dir = path.join(root, 'content');
  fs.mkdirSync(dir);
  try {
    const handler = createPeerTubeAssetHandler({
      db,
      contentDir: dir,
      fetchPlaybackResponse: async () => response(Buffer.from('must-not-write')),
      normalizeVideoJob: async () => assert.fail('normalization must not run'),
    });
    await assert.rejects(
      handler({
        id: '../../escaped',
        content_id: 'content-1',
        workspace_id: 'workspace-1',
        expected_version: 1,
        expected_filepath: '',
        attempts: 1,
        max_attempts: 5,
        payload: {
          replayId: 'replay-1',
          videoUuid: '9c0ef6aa-f043-4a9d-bc86-bdb0ea03007c',
          maxBytes: 1024,
        },
      }, {
        progress() {},
        isCancellationRequested: () => false,
      }),
      (caught) => caught.code === 'invalid_media_job_id' && caught.retryable === false,
    );
    assert.deepEqual(fs.readdirSync(root), ['content']);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('declared or streamed assets above the bound fail closed without normalization', async (t) => {
  for (const [name, fakeResponse] of [
    ['declared', response(Buffer.from('short'), { 'content-length': '2048' })],
    ['streamed', response(Buffer.alloc(20), { 'content-length': '' })],
  ]) {
    await t.test(name, async () => {
      const db = makeDb();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mc-peertube-${name}-`));
      try {
        const handler = createPeerTubeAssetHandler({
          db,
          contentDir: dir,
          fetchPlaybackResponse: async () => fakeResponse,
          normalizeVideoJob: async () => assert.fail('normalization must not run'),
        });
        await assert.rejects(
          handler({
            id: `job-${name}`,
            content_id: 'content-1',
            workspace_id: 'workspace-1',
            expected_version: 1,
            expected_filepath: '',
            attempts: 1,
            max_attempts: 5,
            payload: {
              replayId: 'replay-1',
              videoUuid: '9c0ef6aa-f043-4a9d-bc86-bdb0ea03007c',
              maxBytes: 10,
            },
          }, {
            progress() {},
            isCancellationRequested: () => false,
          }),
          (caught) => caught.code === 'peertube_asset_too_large'
            && caught.retryable === false,
        );
        assert.deepEqual(fs.readdirSync(dir), []);
      } finally {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
