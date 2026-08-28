'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const {
  LIVE_SOURCES_SCHEMA_MIGRATION_ID,
  LIVE_SOURCES_PODIUM_GUEST_MIGRATION_ID,
  migrateLiveSourcesSchema,
} = require('../db/migrations/live-sources');

function encodeGridCells(cells) {
  return Buffer.from(JSON.stringify(cells), 'utf8').toString('base64url');
}

function decodeGridCells(url) {
  const encoded = new URL(url, 'http://media-control.local').searchParams.get('cells');
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
}

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
    CREATE TABLE advanced_canvas_layers (
      id TEXT PRIMARY KEY,
      endpoint_id TEXT NOT NULL,
      source_json TEXT NOT NULL,
      render_json TEXT NOT NULL
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
      VALUES
        ('legacy-content', '/player/live-source.html?source=guest-computer&layout=old'),
        ('legacy-absolute-content', 'https://media.mbfdhub.com/player/live-source.html?source=guest-computer&layout=old'),
        ('legacy-grid', '/player/grid.html?cells=${encodeGridCells({
          L1: { u: '/player/live-source.html?source=guest-computer', l: 'Zowie', k: 'i' },
          R1: { u: 'https://example.invalid/player/live-source.html?source=guest-computer', l: 'Foreign', k: 'i' },
        })}&layout=wall'),
        ('foreign-content', 'https://example.invalid/player/live-source.html?source=guest-computer');
    INSERT INTO playlists (id, published_snapshot)
      VALUES ('legacy-playlist', '[{"remote_url":"/player/live-source.html?source=guest-computer","live_source_id":"guest-computer"},{"player_url":"https://media-control.mbfdhub.com/player/live-source.html?source=guest-computer"},{"url":"https://example.invalid/player/live-source.html?source=guest-computer"}]');
    INSERT INTO activity_asset_placements (id, remote_url)
      VALUES ('legacy-placement', '/player/live-source.html?source=guest-computer');
    INSERT INTO advanced_canvas_layers (id, endpoint_id, source_json, render_json)
      VALUES
        ('legacy-canvas-layer', 'canvas-1',
          '{"live_source_id":"guest-computer","remote_url":"/player/live-source.html?source=guest-computer&fit=fill","foreign_url":"https://example.invalid/player/live-source.html?source=guest-computer"}',
          '{"kind":"frame","live_source_id":"guest-computer","url":"https://media.mbfdhub.com/player/live-source.html?source=guest-computer&fit=fill","fallback_url":"https://example.invalid/player/live-source.html?source=guest-computer"}');
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
  assert.equal(
    db.prepare('SELECT remote_url FROM content WHERE id=?').get('legacy-absolute-content').remote_url,
    '/player/live-source.html?source=podium-computer&layout=old',
    'a known app-origin durable player URL is normalized and preserves the Zowie-to-Podium meaning',
  );
  assert.equal(
    db.prepare('SELECT remote_url FROM content WHERE id=?').get('foreign-content').remote_url,
    'https://example.invalid/player/live-source.html?source=guest-computer',
    'a foreign absolute URL is preserved rather than being repurposed',
  );
  const migratedGridUrl = db.prepare('SELECT remote_url FROM content WHERE id=?').get('legacy-grid').remote_url;
  assert.equal(new URL(migratedGridUrl, 'http://media-control.local').searchParams.get('layout'), 'wall');
  assert.deepEqual(
    decodeGridCells(migratedGridUrl),
    {
      L1: { u: '/player/live-source.html?source=podium-computer', l: 'Zowie', k: 'i' },
      R1: { u: 'https://example.invalid/player/live-source.html?source=guest-computer', l: 'Foreign', k: 'i' },
    },
    'only allowlisted embedded live-source cells retain the old Zowie-to-Podium meaning',
  );
  assert.deepEqual(
    JSON.parse(db.prepare('SELECT published_snapshot FROM playlists WHERE id=?').get('legacy-playlist').published_snapshot),
    [
      {
        remote_url: '/player/live-source.html?source=podium-computer',
        live_source_id: 'podium-computer',
      },
      {
        player_url: '/player/live-source.html?source=podium-computer',
      },
      {
        url: 'https://example.invalid/player/live-source.html?source=guest-computer',
      },
    ],
  );
  assert.equal(
    db.prepare('SELECT remote_url FROM activity_asset_placements WHERE id=?').get('legacy-placement').remote_url,
    '/player/live-source.html?source=podium-computer',
  );
  assert.deepEqual(
    JSON.parse(db.prepare('SELECT source_json FROM advanced_canvas_layers WHERE id=?').get('legacy-canvas-layer').source_json),
    {
      live_source_id: 'podium-computer',
      remote_url: '/player/live-source.html?source=podium-computer&fit=fill',
      foreign_url: 'https://example.invalid/player/live-source.html?source=guest-computer',
    },
    'the persisted canvas source descriptor retains the old Zowie meaning only for canonical managed references',
  );
  assert.deepEqual(
    JSON.parse(db.prepare('SELECT render_json FROM advanced_canvas_layers WHERE id=?').get('legacy-canvas-layer').render_json),
    {
      kind: 'frame',
      live_source_id: 'podium-computer',
      url: '/player/live-source.html?source=podium-computer&fit=fill',
      fallback_url: 'https://example.invalid/player/live-source.html?source=guest-computer',
    },
    'the persisted canvas render descriptor is rewritten before reconnect can re-emit it',
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
  db.prepare(`
    INSERT INTO advanced_canvas_layers (id, endpoint_id, source_json, render_json)
    VALUES (?, ?, ?, ?)
  `).run(
    'current-guest-canvas-layer',
    'canvas-1',
    JSON.stringify({ remote_url: '/player/live-source.html?source=guest-computer' }),
    JSON.stringify({ kind: 'frame', url: '/player/live-source.html?source=guest-computer' }),
  );
  migrateLiveSourcesSchema(db);
  assert.deepEqual(
    JSON.parse(db.prepare('SELECT source_json FROM advanced_canvas_layers WHERE id=?').get('current-guest-canvas-layer').source_json),
    { remote_url: '/player/live-source.html?source=guest-computer' },
    'a new Guest Computer canvas source written after the topology migration is preserved',
  );
  assert.deepEqual(
    JSON.parse(db.prepare('SELECT render_json FROM advanced_canvas_layers WHERE id=?').get('current-guest-canvas-layer').render_json),
    { kind: 'frame', url: '/player/live-source.html?source=guest-computer' },
    'a new Guest Computer canvas render descriptor is preserved',
  );
  db.close();
});

test('topology migration fails closed rather than guessing durable Guest semantics after a partial manual rename', () => {
  const db = baseDb();
  migrateLiveSourcesSchema(db);
  db.exec(`
    CREATE TABLE content (
      id TEXT PRIMARY KEY,
      remote_url TEXT
    );
  `);
  db.prepare('DELETE FROM schema_migrations WHERE id = ?').run(LIVE_SOURCES_PODIUM_GUEST_MIGRATION_ID);
  db.prepare('DELETE FROM live_sources WHERE id = ?').run('guest-computer');
  db.prepare('INSERT INTO content (id, remote_url) VALUES (?, ?)').run(
    'ambiguous-old-player',
    '/player/live-source.html?source=guest-computer',
  );

  assert.throws(
    () => migrateLiveSourcesSchema(db),
    /topology is ambiguous/i,
  );
  assert.equal(
    db.prepare('SELECT remote_url FROM content WHERE id = ?').get('ambiguous-old-player').remote_url,
    '/player/live-source.html?source=guest-computer',
    'a failed migration does not silently assign an old Zowie URL to the new Guest source',
  );
  assert.equal(
    db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(LIVE_SOURCES_PODIUM_GUEST_MIGRATION_ID),
    undefined,
  );
  assert.equal(db.prepare('SELECT id FROM live_sources WHERE id = ?').get('guest-computer'), undefined);
  db.close();
});
