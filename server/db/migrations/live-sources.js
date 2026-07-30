'use strict';

const LIVE_SOURCES_SCHEMA_MIGRATION_ID = 'live_sources_schema_v1';

const CANONICAL_SOURCES = [
  {
    id: 'anpviz',
    sourceType: 'camera',
    displayName: 'Anpviz Camera',
    streamPath: 'anpviz-main',
    playerPath: '/player/live-source.html?source=anpviz',
    visibilityPolicy: 'always',
  },
  {
    id: 'guest-computer',
    sourceType: 'guest_computer',
    displayName: 'Guest Computer',
    streamPath: 'guest-computer',
    playerPath: '/player/live-source.html?source=guest-computer',
    visibilityPolicy: 'signal',
  },
];

function migrateLiveSourcesSchema(db) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('live sources migration requires a SQLite database');
  }

  const migrate = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS live_sources (
        id                TEXT PRIMARY KEY,
        source_type       TEXT NOT NULL CHECK (source_type IN ('camera', 'guest_computer')),
        display_name      TEXT NOT NULL,
        stream_path       TEXT NOT NULL UNIQUE,
        player_path       TEXT NOT NULL,
        visibility_policy TEXT NOT NULL CHECK (visibility_policy IN ('always', 'signal')),
        enabled           INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        availability      TEXT NOT NULL DEFAULT 'unknown'
          CHECK (availability IN ('unknown', 'available', 'unavailable', 'degraded')),
        signal_json       TEXT,
        last_seen_at      INTEGER,
        created_at        INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        updated_at        INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_live_sources_type
        ON live_sources(source_type, enabled);
    `);

    // A camera row represents physical camera hardware. The installation has
    // exactly one such device, so stale camera identities are removed
    // transactionally before the canonical row is asserted.
    db.prepare(`
      DELETE FROM live_sources
      WHERE source_type = 'camera' AND id <> 'anpviz'
    `).run();

    const upsert = db.prepare(`
      INSERT INTO live_sources (
        id, source_type, display_name, stream_path, player_path,
        visibility_policy, enabled
      ) VALUES (?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(id) DO UPDATE SET
        source_type = excluded.source_type,
        display_name = excluded.display_name,
        stream_path = excluded.stream_path,
        player_path = excluded.player_path,
        visibility_policy = excluded.visibility_policy,
        enabled = 1,
        updated_at = strftime('%s','now')
    `);
    for (const source of CANONICAL_SOURCES) {
      upsert.run(
        source.id,
        source.sourceType,
        source.displayName,
        source.streamPath,
        source.playerPath,
        source.visibilityPolicy,
      );
    }

    // No non-canonical source is allowed to persist in this installation.
    db.prepare(`
      DELETE FROM live_sources
      WHERE id NOT IN ('anpviz', 'guest-computer')
    `).run();

    db.prepare(
      'INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)',
    ).run(LIVE_SOURCES_SCHEMA_MIGRATION_ID);
  });

  migrate();
  return true;
}

module.exports = {
  CANONICAL_SOURCES,
  LIVE_SOURCES_SCHEMA_MIGRATION_ID,
  migrateLiveSourcesSchema,
};
