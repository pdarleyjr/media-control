'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { refreshPresentationConversionReadiness } = require('../services/presentation-conversion-readiness');

test('a completed conversion stays at 99 percent until every embedded video generation is ready', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE content (
      id TEXT PRIMARY KEY, filepath TEXT, mime_type TEXT, processing_status TEXT,
      processing_error TEXT, version INTEGER
    );
    CREATE TABLE presentation_assets (presentation_id TEXT, content_id TEXT);
    CREATE TABLE asset_checksums (
      content_id TEXT PRIMARY KEY, generation INTEGER, sha256 TEXT, size_bytes INTEGER, canonical_path TEXT
    );
    CREATE TABLE media_jobs (
      id TEXT PRIMARY KEY, status TEXT, stage TEXT, progress_pct INTEGER,
      result_json TEXT, updated_at INTEGER
    );
    INSERT INTO content VALUES ('video','video.mp4','video/mp4','processing',NULL,1);
    INSERT INTO presentation_assets VALUES ('deck','video');
    INSERT INTO media_jobs VALUES ('job','completed','preparing',99,'{}',1);
  `);
  let job = {
    id: 'job', status: 'completed', stage: 'preparing', progress_pct: 99,
    result: { presentation_id: 'deck', media_preparing: true, broadcast_ready: false },
  };

  job = refreshPresentationConversionReadiness(db, job);
  assert.equal(job.result.embedded_media_status, 'preparing');
  assert.equal(job.result.broadcast_ready, false);
  assert.equal(job.progress_pct, 99);

  db.prepare("UPDATE content SET processing_status='ready' WHERE id='video'").run();
  db.prepare(`INSERT INTO asset_checksums VALUES ('video',1,?,9,'video.mp4')`).run('a'.repeat(64));
  job = refreshPresentationConversionReadiness(db, job);
  assert.equal(job.result.embedded_media_status, 'ready');
  assert.equal(job.result.broadcast_ready, true);
  assert.equal(job.stage, 'ready');
  assert.equal(job.progress_pct, 100);
  assert.equal(db.prepare("SELECT stage FROM media_jobs WHERE id='job'").get().stage, 'ready');
});

test('embedded video normalization failure remains visible instead of claiming ready', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE content (
      id TEXT PRIMARY KEY, filepath TEXT, mime_type TEXT, processing_status TEXT,
      processing_error TEXT, version INTEGER
    );
    CREATE TABLE presentation_assets (presentation_id TEXT, content_id TEXT);
    CREATE TABLE asset_checksums (content_id TEXT PRIMARY KEY, generation INTEGER, sha256 TEXT, size_bytes INTEGER, canonical_path TEXT);
    CREATE TABLE media_jobs (id TEXT PRIMARY KEY, status TEXT, stage TEXT, progress_pct INTEGER, result_json TEXT, updated_at INTEGER);
    INSERT INTO content VALUES ('video','video.mp4','video/mp4','failed','ffmpeg failed',1);
    INSERT INTO presentation_assets VALUES ('deck','video');
    INSERT INTO media_jobs VALUES ('job','completed','preparing',99,'{}',1);
  `);
  const job = refreshPresentationConversionReadiness(db, {
    id: 'job', status: 'completed', stage: 'preparing', progress_pct: 99,
    result: { presentation_id: 'deck' },
  });
  assert.equal(job.result.embedded_media_status, 'failed');
  assert.equal(job.result.broadcast_ready, false);
  assert.equal(job.result.embedded_media_errors[0].code, 'CONTENT_PROCESSING_FAILED');
});
