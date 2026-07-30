'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const {
  LIVE_SOURCES_SCHEMA_MIGRATION_ID,
  migrateLiveSourcesSchema,
} = require('../db/migrations/live-sources');

function baseDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE schema_migrations (
      id TEXT PRIMARY KEY,
      ran_at INTEGER DEFAULT (strftime('%s', 'now')),
      checksum TEXT
    );
  `);
  return db;
}

test('live source migration creates only the canonical Anpviz camera and Guest Computer identities', () => {
  const db = baseDb();

  assert.equal(migrateLiveSourcesSchema(db), true);
  assert.deepEqual(
    db.prepare(`
      SELECT id, source_type, display_name, stream_path, visibility_policy
      FROM live_sources
      ORDER BY id
    `).all(),
    [
      {
        id: 'anpviz',
        source_type: 'camera',
        display_name: 'Anpviz Camera',
        stream_path: 'anpviz-main',
        visibility_policy: 'always',
      },
      {
        id: 'guest-computer',
        source_type: 'guest_computer',
        display_name: 'Guest Computer',
        stream_path: 'guest-computer',
        visibility_policy: 'signal',
      },
    ],
  );
  assert.ok(db.prepare(
    'SELECT 1 FROM schema_migrations WHERE id=?',
  ).get(LIVE_SOURCES_SCHEMA_MIGRATION_ID));

  assert.equal(migrateLiveSourcesSchema(db), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM live_sources').get().count, 2);
  db.close();
});

test('live source migration removes obsolete camera rows without deleting the Guest Computer identity', () => {
  const db = baseDb();
  db.exec(`
    CREATE TABLE live_sources (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      display_name TEXT NOT NULL,
      stream_path TEXT NOT NULL,
      player_path TEXT NOT NULL,
      visibility_policy TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      availability TEXT NOT NULL DEFAULT 'unknown',
      signal_json TEXT,
      last_seen_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    INSERT INTO live_sources
      (id, source_type, display_name, stream_path, player_path, visibility_policy)
    VALUES
      ('focus-210', 'camera', 'Focus 210', 'kamrui-camera-1', '/old', 'always'),
      ('camera-2', 'camera', 'Camera 2', 'kamrui-camera-2', '/old', 'always'),
      ('guest-computer', 'guest_computer', 'Old guest label', 'old-guest', '/old', 'signal');
  `);

  migrateLiveSourcesSchema(db);

  assert.deepEqual(
    db.prepare('SELECT id FROM live_sources ORDER BY id').all().map((row) => row.id),
    ['anpviz', 'guest-computer'],
  );
  assert.equal(
    db.prepare('SELECT display_name FROM live_sources WHERE id=?').get('guest-computer').display_name,
    'Guest Computer',
  );
  db.close();
});
