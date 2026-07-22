'use strict';

const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const test = require('node:test');

const {
  MIGRATION_ID,
  migratePeerTubeReplay,
  rollbackPeerTubeReplay,
  validatePeerTubeReplaySchema,
} = require('../db/migrations/peertube-replays');

function baseDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE schema_migrations (
      id TEXT PRIMARY KEY,
      ran_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE organizations (id TEXT PRIMARY KEY);
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id)
    );
    CREATE TABLE content (id TEXT PRIMARY KEY);
  `);
  return db;
}

test('fresh migration is atomic, constrained, validated, and stamped last', () => {
  const db = baseDb();
  migratePeerTubeReplay(db);

  assert.equal(validatePeerTubeReplaySchema(db), true);
  assert.ok(db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(MIGRATION_ID));

  const replaySql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='peertube_replays'").get().sql;
  assert.match(replaySql, /FOREIGN KEY\s*\(recording_session_id, workspace_id\)/i);
  assert.match(replaySql, /CHECK\s*\(processing_state IN/i);
  assert.match(replaySql, /CHECK\s*\(library_visibility IN/i);
  assert.throws(() => db.prepare(`
    INSERT INTO peertube_replays
      (id, recording_session_id, workspace_id, peertube_video_uuid, processing_state, library_visibility)
    VALUES ('r1', 'missing', 'ws1', 'v1', 'bogus', 'PRIVATE')
  `).run(), /constraint/i);
  db.close();
});

test('prototype/current-schema row is preserved in quarantine instead of trusted as a classroom replay', () => {
  const db = baseDb();
  db.exec(`
    CREATE TABLE peertube_replays (
      id TEXT PRIMARY KEY,
      recording_session_id TEXT NOT NULL,
      workspace_id TEXT,
      peertube_video_uuid TEXT,
      title TEXT,
      processing_state TEXT NOT NULL DEFAULT 'discovering',
      privacy INTEGER NOT NULL DEFAULT 1,
      content_id TEXT
    );
    CREATE UNIQUE INDEX idx_peertube_replays_session_uuid
      ON peertube_replays(recording_session_id, peertube_video_uuid);
    CREATE INDEX idx_peertube_replays_state ON peertube_replays(processing_state);
    CREATE INDEX idx_peertube_replays_content ON peertube_replays(content_id);
    INSERT INTO peertube_replays
      (id, recording_session_id, workspace_id, peertube_video_uuid, title, processing_state)
    VALUES ('legacy-1', 'video-fallback-is-not-a-session', NULL, 'untrusted-video', 'Old prototype row', 'ready');
  `);

  migratePeerTubeReplay(db);

  assert.equal(validatePeerTubeReplaySchema(db), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM peertube_replays').get().n, 0);
  const quarantined = db.prepare('SELECT * FROM peertube_replay_quarantine WHERE peertube_video_uuid = ?').get('untrusted-video');
  assert.equal(quarantined.reason_code, 'legacy_uncorrelated');
  assert.equal(quarantined.title, 'Old prototype row');
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_peertube_replays_legacy_content'").get());
  db.close();
});

test('partial migration rolls back completely and never stamps success', () => {
  const db = baseDb();
  db.exec(`
    CREATE TABLE peertube_recording_sessions (
      id TEXT PRIMARY KEY,
      sentinel TEXT NOT NULL
    );
    INSERT INTO peertube_recording_sessions (id, sentinel) VALUES ('partial-data', 'must-not-drop');
  `);

  assert.throws(() => migratePeerTubeReplay(db), /partial.*manual recovery/i);
  assert.equal(db.prepare('SELECT sentinel FROM peertube_recording_sessions WHERE id = ?').get('partial-data').sentinel, 'must-not-drop');
  assert.equal(db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(MIGRATION_ID), undefined);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='peertube_replays'").get(), undefined);
  db.close();
});

test('failed migration never stamps even when a conflicting object fails inside the transaction', () => {
  const db = baseDb();
  db.exec('CREATE VIEW peertube_replay_revisions AS SELECT 1 AS revision');

  assert.throws(() => migratePeerTubeReplay(db));
  assert.equal(db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(MIGRATION_ID), undefined);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='peertube_replays'").get(), undefined);
  db.close();
});

test('rollback copy restores the prototype table and removes the v2 stamp', () => {
  const db = baseDb();
  db.exec(`
    CREATE TABLE peertube_replays (
      id TEXT PRIMARY KEY,
      recording_session_id TEXT NOT NULL,
      workspace_id TEXT,
      peertube_video_uuid TEXT,
      processing_state TEXT NOT NULL DEFAULT 'discovering',
      privacy INTEGER NOT NULL DEFAULT 1
    );
    INSERT INTO peertube_replays
      (id, recording_session_id, peertube_video_uuid, processing_state)
    VALUES ('legacy-restore', 'unsafe-fallback', 'legacy-video', 'ready');
  `);

  migratePeerTubeReplay(db);
  rollbackPeerTubeReplay(db);

  assert.equal(db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(MIGRATION_ID), undefined);
  const restored = db.prepare('SELECT id, privacy FROM peertube_replays WHERE id = ?').get('legacy-restore');
  assert.deepEqual(restored, { id: 'legacy-restore', privacy: 1 });
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='peertube_recording_sessions'").get(), undefined);
  db.close();
});
