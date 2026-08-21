'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const {
  ensureMediaOperationsSchema,
} = require('../db/migrations/media-operations');
const {
  normalizeCaption,
  attachCaptionsToItems,
} = require('../lib/content-captions');
const {
  mediaObservabilitySnapshot,
} = require('../lib/media-observability');

function fixtureDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE schema_migrations (
      id TEXT PRIMARY KEY,
      ran_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE content (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      filename TEXT,
      filepath TEXT,
      file_size INTEGER,
      processing_status TEXT,
      thumbnail_path TEXT,
      library_scope TEXT,
      archived_at INTEGER
    );
    CREATE TABLE media_jobs (
      id TEXT PRIMARY KEY,
      content_id TEXT,
      workspace_id TEXT,
      job_type TEXT,
      source_type TEXT,
      status TEXT,
      stage TEXT,
      progress_pct INTEGER,
      reserved_bytes INTEGER,
      created_at INTEGER,
      updated_at INTEGER,
      started_at INTEGER,
      completed_at INTEGER
    );
    CREATE TABLE asset_checksums (
      asset_id TEXT PRIMARY KEY,
      content_id TEXT UNIQUE,
      generation INTEGER,
      sha256 TEXT,
      size_bytes INTEGER
    );
    CREATE TABLE managed_nodes (
      node_id TEXT PRIMARY KEY,
      workspace_id TEXT,
      telemetry_json TEXT
    );
  `);
  ensureMediaOperationsSchema(db);
  return db;
}

test('caption normalization accepts WebVTT and converts bounded SRT to canonical WebVTT', () => {
  const vtt = normalizeCaption(Buffer.from(
    'WEBVTT\r\n\r\n00:00:01.000 --> 00:00:03.000\r\nWelcome to class.\r\n',
  ), { filename: 'welcome.vtt' });
  assert.equal(vtt.format, 'vtt');
  assert.equal(vtt.cue_count, 1);
  assert.match(vtt.body, /^WEBVTT\n\n00:00:01\.000 --> 00:00:03\.000/m);

  const srt = normalizeCaption(Buffer.from(
    '1\n00:00:04,500 --> 00:00:06,250\nEvacuate through the nearest exit.\n',
  ), { filename: 'evacuation.srt' });
  assert.equal(srt.format, 'vtt');
  assert.equal(srt.source_format, 'srt');
  assert.equal(srt.cue_count, 1);
  assert.match(srt.body, /00:00:04\.500 --> 00:00:06\.250/);
});

test('caption normalization rejects malformed, binary, empty, and oversized payloads', () => {
  assert.throws(
    () => normalizeCaption(Buffer.from('not a caption'), { filename: 'bad.vtt' }),
    /caption_invalid/,
  );
  assert.throws(
    () => normalizeCaption(Buffer.from('WEBVTT\n\n\u0000'), { filename: 'bad.vtt' }),
    /caption_binary/,
  );
  assert.throws(
    () => normalizeCaption(Buffer.alloc((2 * 1024 * 1024) + 1, 0x41), { filename: 'huge.vtt' }),
    /caption_too_large/,
  );
});

test('caption schema and player hydration preserve language, default choice, and public sidecar URL', () => {
  const db = fixtureDb();
  db.prepare(
    `INSERT INTO content
      (id, workspace_id, filename, filepath, file_size, processing_status, thumbnail_path, archived_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('content-1', 'workspace-1', 'video.mp4', 'video.mp4', 100, 'ready', null, null);
  db.prepare(
    `INSERT INTO content_captions
      (id, content_id, workspace_id, language_code, label, kind, is_default,
       source_type, source_format, body_vtt, cue_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'cap-1', 'content-1', 'workspace-1', 'en-US', 'English', 'captions', 1,
    'upload', 'vtt', 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n', 1, 10, 10,
  );
  const hydrated = attachCaptionsToItems(db, [{ content_id: 'content-1' }]);
  assert.deepEqual(hydrated[0].captions, [{
    id: 'cap-1',
    language_code: 'en-US',
    label: 'English',
    kind: 'captions',
    is_default: true,
    source_type: 'upload',
    source_format: 'vtt',
    cue_count: 1,
    url: '/api/captions/cap-1/file',
  }]);
  assert.ok(db.prepare(
    "SELECT 1 FROM schema_migrations WHERE id='media_operations_v1'",
  ).get());
  db.close();
});

test('workspace media observability reports queues, manifest coverage, cache ratio, rates, and alerts truthfully', () => {
  const db = fixtureDb();
  const now = 10_000;
  db.exec(`
    INSERT INTO content VALUES
      ('c1','ws','ready.mp4','ready.mp4',1000,'ready','ready.jpg',NULL,NULL),
      ('c2','ws','missing.mp4','missing.mp4',2000,'ready',NULL,NULL,NULL),
      ('c3','other','other.mp4','other.mp4',3000,'ready',NULL,NULL,NULL);
    INSERT INTO asset_checksums VALUES ('a1','c1',1,'${'a'.repeat(64)}',1000);
    INSERT INTO media_jobs VALUES
      ('j1','c1','ws','video_normalize','upload','completed','ready',100,1000,9000,9010,9001,9010),
      ('j2','c2','ws','thumbnail_finalize','upload','failed','failed',0,2000,9700,9705,9701,9705),
      ('j3','c2','ws','video_normalize','youtube','running','optimizing',40,2000,7000,7000,7000,NULL),
      ('j4','c3','other','video_normalize','upload','failed','failed',0,3000,9500,9510,9500,9510);
  `);
  db.prepare(
    'INSERT INTO managed_nodes (node_id, workspace_id, telemetry_json) VALUES (?, ?, ?)',
  ).run('p3', 'ws', JSON.stringify({
    cache: { cache_hits: 30, cache_misses: 10, manifest_count: 2 },
  }));

  const snapshot = mediaObservabilitySnapshot(db, {
    workspaceId: 'ws',
    now,
    stuckSeconds: 900,
  });
  assert.equal(snapshot.queue.depth.running, 1);
  assert.equal(snapshot.queue.oldest_active_age_sec, 3000);
  assert.equal(snapshot.manifest.covered, 1);
  assert.equal(snapshot.manifest.eligible, 2);
  assert.equal(snapshot.manifest.coverage_pct, 50);
  assert.equal(snapshot.thumbnails.failures, 1);
  assert.equal(snapshot.cache.hits, 30);
  assert.equal(snapshot.cache.misses, 10);
  assert.equal(snapshot.cache.hit_ratio, 0.75);
  assert.equal(snapshot.sources.youtube.failed, 0);
  assert.equal(snapshot.sources.upload.failed, 1);
  assert.equal(snapshot.processing.completed_samples, 1);
  assert.ok(snapshot.alerts.some((alert) => alert.code === 'MEDIA_JOB_STUCK'));
  assert.equal(snapshot.library_scopes.library, 2);
  assert.equal(snapshot.library_scopes.internal, 0);
  assert.equal(snapshot.library_scopes.total, 2);
  db.close();
});

test('media observability breaks content down by library scope', () => {
  const db = fixtureDb();
  db.exec(`
    INSERT INTO content (id, workspace_id, filename, filepath, file_size, processing_status, library_scope, archived_at)
      VALUES
        ('lib-1','ws','a.mp4','a.mp4',1000,'ready','library',NULL),
        ('lib-2','ws','b.mp4','b.mp4',1000,'ready','library',NULL),
        ('int-1','ws','c.png','c.png',1000,'ready','internal',NULL),
        ('int-2','ws','d.png','d.png',1000,'ready','internal',NULL),
        ('int-3','ws','e.png','e.png',1000,'ready',NULL,NULL),
        ('arch-1','ws','f.mp4','f.mp4',1000,'ready','internal',1000);
  `);
  const snapshot = mediaObservabilitySnapshot(db, { workspaceId: 'ws', now: 10_000 });
  assert.equal(snapshot.library_scopes.library, 3);
  assert.equal(snapshot.library_scopes.internal, 2);
  assert.equal(snapshot.library_scopes.total, 5);
  db.close();
});

test('caption UI, player tracks, protected API, and observability route are wired', () => {
  const root = path.join(__dirname, '../..');
  const source = relative => fs.readFileSync(path.join(root, relative), 'utf8');
  const api = source('frontend/js/api.js');
  const library = source('frontend/js/views/content-library.js');
  const player = source('server/player/index.html');
  const server = source('server/server.js');
  assert.match(api, /uploadContentCaption:/);
  assert.match(api, /listContentCaptions:/);
  assert.match(library, /data-caption-upload/);
  assert.match(library, /caption_file/);
  assert.match(player, /item\.captions/);
  assert.match(player, /document\.createElement\('track'\)/);
  assert.match(server, /\/api\/captions/);
  assert.match(server, /\/api\/media-observability/);
});
