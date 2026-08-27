'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const {
  LIVE_SOURCES_SCHEMA_MIGRATION_ID,
  LIVE_SOURCES_PODIUM_GUEST_MIGRATION_ID,
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

test('live source migration creates the canonical Anpviz, Podium Computer, and Guest Computer identities idempotently', () => {
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
        visibility_policy: 'always',
      },
      {
        id: 'podium-computer',
        source_type: 'guest_computer',
        display_name: 'Podium Computer',
        stream_path: 'podium-computer',
        visibility_policy: 'always',
      },
    ],
  );
  assert.ok(db.prepare(
    'SELECT 1 FROM schema_migrations WHERE id=?',
  ).get(LIVE_SOURCES_SCHEMA_MIGRATION_ID));
  assert.ok(db.prepare(
    'SELECT 1 FROM schema_migrations WHERE id=?',
  ).get(LIVE_SOURCES_PODIUM_GUEST_MIGRATION_ID));

  assert.equal(migrateLiveSourcesSchema(db), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM live_sources').get().count, 3);
  db.close();
});

test('topology migration renames the legacy Zowie source to Podium and preserves only targeted durable references', () => {
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
    CREATE TABLE content (
      id TEXT PRIMARY KEY,
      remote_url TEXT
    );
    CREATE TABLE playlists (
      id TEXT PRIMARY KEY,
      published_snapshot TEXT
    );
    CREATE TABLE activity_asset_placements (
      id TEXT PRIMARY KEY,
      remote_url TEXT
    );
    CREATE TABLE activity_log (
      id TEXT PRIMARY KEY,
      details TEXT
    );
    INSERT INTO live_sources
      (id, source_type, display_name, stream_path, player_path, visibility_policy)
    VALUES
      ('focus-210', 'camera', 'Focus 210', 'kamrui-camera-1', '/old', 'always'),
      ('camera-2', 'camera', 'Camera 2', 'kamrui-camera-2', '/old', 'always'),
      ('guest-computer', 'guest_computer', 'Old guest label', 'old-guest', '/old', 'signal');
    INSERT INTO content (id, remote_url)
      VALUES ('legacy-content', '/player/live-source.html?source=guest-computer&layout=old');
    INSERT INTO playlists (id, published_snapshot)
      VALUES ('legacy-playlist', '[{"remote_url":"/player/live-source.html?source=guest-computer","live_source_id":"guest-computer"}]');
    INSERT INTO activity_asset_placements (id, remote_url)
      VALUES ('legacy-placement', '/player/live-source.html?source=guest-computer');
    INSERT INTO activity_log (id, details)
      VALUES ('historical', 'guest-computer was the old ZowieBox source');
  `);

  migrateLiveSourcesSchema(db);

  assert.deepEqual(
    db.prepare('SELECT id FROM live_sources ORDER BY id').all().map((row) => row.id),
    ['anpviz', 'guest-computer', 'podium-computer'],
  );
  assert.equal(
    db.prepare('SELECT display_name FROM live_sources WHERE id=?').get('podium-computer').display_name,
    'Podium Computer',
  );
  assert.equal(
    db.prepare('SELECT remote_url FROM content WHERE id=?').get('legacy-content').remote_url,
    '/player/live-source.html?source=podium-computer&layout=old',
  );
  assert.deepEqual(
    JSON.parse(db.prepare('SELECT published_snapshot FROM playlists WHERE id=?').get('legacy-playlist').published_snapshot),
    [{
      remote_url: '/player/live-source.html?source=podium-computer',
      live_source_id: 'podium-computer',
    }],
  );
  assert.equal(
    db.prepare('SELECT remote_url FROM activity_asset_placements WHERE id=?').get('legacy-placement').remote_url,
    '/player/live-source.html?source=podium-computer',
  );
  assert.equal(
    db.prepare('SELECT details FROM activity_log WHERE id=?').get('historical').details,
    'guest-computer was the old ZowieBox source',
    'historical/audit text is deliberately retained rather than globally replaced',
  );

  assert.equal(
    require('../db/migrations/live-sources').rewriteLegacyPlayerUrl(
      'https://example.invalid/player/live-source.html?source=guest-computer',
    ),
    'https://example.invalid/player/live-source.html?source=guest-computer',
    'an unrelated absolute URL cannot be silently repurposed',
  );

  migrateLiveSourcesSchema(db);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM live_sources').get().count, 3);
  assert.equal(
    db.prepare('SELECT remote_url FROM content WHERE id=?').get('legacy-content').remote_url,
    '/player/live-source.html?source=podium-computer&layout=old',
    'the one-time legacy migration cannot repurpose old Podium state on a later startup',
  );
  db.close();
});
