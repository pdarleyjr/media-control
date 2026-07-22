'use strict';

const MIGRATION_ID = 'peertube_replay_enterprise_v2';
const LEGACY_TABLE = 'peertube_replays_legacy_v1';

const REQUIRED_TABLES = Object.freeze([
  'peertube_recording_sessions',
  'peertube_replays',
  'peertube_replay_quarantine',
  'peertube_replay_revisions',
  'peertube_replay_worker_leases',
  'peertube_replay_worker_status',
]);

function object(db, name) {
  return db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name = ?").get(name);
}

function tableColumns(db, name) {
  if (!object(db, name) || object(db, name).type !== 'table') return [];
  return db.prepare(`PRAGMA table_info(${name})`).all().map((row) => row.name);
}

function hasAll(values, expected) {
  const set = new Set(values);
  return expected.every((value) => set.has(value));
}

function validatePeerTubeReplaySchema(db) {
  for (const table of REQUIRED_TABLES) {
    const found = object(db, table);
    if (!found || found.type !== 'table') return false;
  }
  if (!hasAll(tableColumns(db, 'peertube_recording_sessions'), [
    'id', 'workspace_id', 'stream_session_id', 'live_video_uuid', 'obs_recording_id',
    'started_at', 'ended_at', 'status',
  ])) return false;
  if (!hasAll(tableColumns(db, 'peertube_replays'), [
    'id', 'recording_session_id', 'workspace_id', 'peertube_video_uuid',
    'processing_state', 'peertube_privacy', 'library_visibility',
    'publication_status', 'playback_url', 'content_id', 'added_by',
  ])) return false;

  const replaySql = String(object(db, 'peertube_replays').sql || '');
  return /FOREIGN KEY\s*\(recording_session_id, workspace_id\)/i.test(replaySql)
    && /CHECK\s*\(processing_state IN/i.test(replaySql)
    && /CHECK\s*\(library_visibility IN/i.test(replaySql);
}

function requirePrerequisites(db) {
  for (const table of ['schema_migrations', 'users', 'workspaces', 'content']) {
    const found = object(db, table);
    if (!found || found.type !== 'table') {
      throw new Error(`PeerTube replay migration prerequisite missing: ${table}`);
    }
  }
}

function classifyExisting(db) {
  const existing = REQUIRED_TABLES.filter((name) => object(db, name));
  const replay = object(db, 'peertube_replays');
  const prototype = replay && replay.type === 'table'
    && hasAll(tableColumns(db, 'peertube_replays'), ['privacy', 'recording_session_id'])
    && !tableColumns(db, 'peertube_replays').includes('library_visibility');

  if (existing.length === 0) return 'fresh';
  if (existing.length === 1 && prototype) return 'prototype';
  if (validatePeerTubeReplaySchema(db)) return 'v2';
  throw new Error('PeerTube replay partial migration contains data or conflicting objects; manual recovery required');
}

function createSchema(db) {
  db.exec(`
    CREATE TABLE peertube_recording_sessions (
      id                    TEXT PRIMARY KEY,
      workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      instructor_user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
      title                 TEXT NOT NULL,
      room_id               TEXT,
      room_name             TEXT,
      live_video_uuid       TEXT,
      stream_session_id     TEXT,
      obs_recording_id      TEXT,
      expected_replay_uuid  TEXT,
      started_at            INTEGER NOT NULL,
      ended_at              INTEGER,
      status                TEXT NOT NULL DEFAULT 'recording'
                              CHECK (status IN ('recording','awaiting_replay','linked','closed','cancelled')),
      metadata_json         TEXT,
      created_at            INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at            INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      UNIQUE (id, workspace_id),
      CHECK (ended_at IS NULL OR ended_at >= started_at)
    );

    CREATE UNIQUE INDEX idx_peertube_recording_stream_session
      ON peertube_recording_sessions(workspace_id, stream_session_id)
      WHERE stream_session_id IS NOT NULL;
    CREATE UNIQUE INDEX idx_peertube_recording_live_uuid
      ON peertube_recording_sessions(workspace_id, live_video_uuid)
      WHERE live_video_uuid IS NOT NULL;
    CREATE UNIQUE INDEX idx_peertube_recording_obs_id
      ON peertube_recording_sessions(workspace_id, obs_recording_id)
      WHERE obs_recording_id IS NOT NULL;
    CREATE UNIQUE INDEX idx_peertube_recording_expected_replay
      ON peertube_recording_sessions(expected_replay_uuid)
      WHERE expected_replay_uuid IS NOT NULL;

    CREATE TABLE peertube_replays (
      id                    TEXT PRIMARY KEY,
      recording_session_id TEXT NOT NULL,
      workspace_id          TEXT NOT NULL,
      peertube_video_uuid   TEXT NOT NULL UNIQUE,
      peertube_video_id     INTEGER,
      title                 TEXT NOT NULL DEFAULT '',
      description           TEXT NOT NULL DEFAULT '',
      duration_sec          REAL,
      thumbnail_url         TEXT,
      watch_url             TEXT,
      embed_url             TEXT,
      playback_url          TEXT,
      processing_state      TEXT NOT NULL DEFAULT 'discovering'
                              CHECK (processing_state IN ('discovering','processing','ready','failed','added','discarded','archived')),
      peertube_privacy      INTEGER NOT NULL DEFAULT 1 CHECK (peertube_privacy IN (1,2,3,4)),
      library_visibility    TEXT NOT NULL DEFAULT 'PRIVATE'
                              CHECK (library_visibility IN ('PRIVATE','WORKSPACE_SHARED','ORGANIZATION_SHARED','PLATFORM_TEMPLATE')),
      publication_status    TEXT NOT NULL DEFAULT 'not_requested'
                              CHECK (publication_status IN ('not_requested','pending','approved','rejected')),
      media_validation      TEXT NOT NULL DEFAULT 'unknown'
                              CHECK (media_validation IN ('unknown','valid','invalid')),
      content_id            TEXT REFERENCES content(id) ON DELETE SET NULL,
      error_message         TEXT,
      retry_count           INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
      discovered_at         INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      ready_at              INTEGER,
      added_at              INTEGER,
      added_by              TEXT REFERENCES users(id) ON DELETE SET NULL,
      updated_at            INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      FOREIGN KEY (recording_session_id, workspace_id)
        REFERENCES peertube_recording_sessions(id, workspace_id) ON DELETE RESTRICT
    );

    CREATE INDEX idx_peertube_replays_workspace_state
      ON peertube_replays(workspace_id, processing_state, discovered_at DESC);
    CREATE UNIQUE INDEX idx_peertube_replays_content
      ON peertube_replays(content_id) WHERE content_id IS NOT NULL;

    CREATE TABLE peertube_replay_quarantine (
      id                    TEXT PRIMARY KEY,
      peertube_video_uuid   TEXT NOT NULL UNIQUE,
      peertube_video_id     INTEGER,
      title                 TEXT NOT NULL DEFAULT '',
      reason_code           TEXT NOT NULL,
      metadata_json         TEXT,
      first_seen_at         INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      last_seen_at          INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE peertube_replay_revisions (
      workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE peertube_replay_worker_leases (
      lease_name TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      heartbeat_at INTEGER NOT NULL
    );

    CREATE TABLE peertube_replay_worker_status (
      worker_name TEXT PRIMARY KEY,
      owner_id TEXT,
      running INTEGER NOT NULL DEFAULT 0 CHECK (running IN (0,1)),
      last_poll_at INTEGER,
      last_success_at INTEGER,
      last_error_code TEXT,
      backoff_ms INTEGER NOT NULL DEFAULT 0 CHECK (backoff_ms >= 0),
      discovered_count INTEGER NOT NULL DEFAULT 0 CHECK (discovered_count >= 0),
      quarantined_count INTEGER NOT NULL DEFAULT 0 CHECK (quarantined_count >= 0),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
  `);
}

function migrateLegacyRowsToQuarantine(db) {
  const columns = new Set(tableColumns(db, LEGACY_TABLE));
  if (!columns.has('peertube_video_uuid')) return;
  const rows = db.prepare(`
    SELECT id, peertube_video_uuid,
           ${columns.has('peertube_video_id') ? 'peertube_video_id' : 'NULL'} AS peertube_video_id,
           ${columns.has('title') ? 'title' : "''"} AS title,
           ${columns.has('recording_session_id') ? 'recording_session_id' : 'NULL'} AS recording_session_id,
           ${columns.has('workspace_id') ? 'workspace_id' : 'NULL'} AS workspace_id,
           ${columns.has('processing_state') ? 'processing_state' : 'NULL'} AS processing_state
      FROM ${LEGACY_TABLE}
     WHERE peertube_video_uuid IS NOT NULL
  `).all();
  const insert = db.prepare(`
    INSERT INTO peertube_replay_quarantine
      (id, peertube_video_uuid, peertube_video_id, title, reason_code, metadata_json)
    VALUES (?, ?, ?, ?, 'legacy_uncorrelated', ?)
    ON CONFLICT(peertube_video_uuid) DO UPDATE SET
      title=excluded.title, last_seen_at=strftime('%s','now')
  `);
  for (const row of rows) {
    insert.run(
      `legacy:${row.id}`,
      row.peertube_video_uuid,
      row.peertube_video_id,
      row.title || '',
      JSON.stringify({
        legacy_id: row.id,
        recording_session_id: row.recording_session_id,
        workspace_id: row.workspace_id,
        processing_state: row.processing_state,
      })
    );
  }
}

function movePrototypeIndexes(db) {
  // SQLite keeps index names when a table is renamed. The prototype used an
  // index name that v2 also needs, so preserve equivalent legacy indexes under
  // unambiguous names before creating the new schema.
  db.exec(`
    DROP INDEX IF EXISTS idx_peertube_replays_session_uuid;
    DROP INDEX IF EXISTS idx_peertube_replays_state;
    DROP INDEX IF EXISTS idx_peertube_replays_content;
  `);
  const columns = new Set(tableColumns(db, LEGACY_TABLE));
  if (columns.has('recording_session_id') && columns.has('peertube_video_uuid')) {
    db.exec(`CREATE UNIQUE INDEX idx_peertube_replays_legacy_session_uuid
      ON ${LEGACY_TABLE}(recording_session_id, peertube_video_uuid)`);
  }
  if (columns.has('processing_state')) {
    db.exec(`CREATE INDEX idx_peertube_replays_legacy_state ON ${LEGACY_TABLE}(processing_state)`);
  }
  if (columns.has('content_id')) {
    db.exec(`CREATE INDEX idx_peertube_replays_legacy_content ON ${LEGACY_TABLE}(content_id)`);
  }
}

function restorePrototypeIndexes(db) {
  db.exec(`
    DROP INDEX IF EXISTS idx_peertube_replays_legacy_session_uuid;
    DROP INDEX IF EXISTS idx_peertube_replays_legacy_state;
    DROP INDEX IF EXISTS idx_peertube_replays_legacy_content;
  `);
  const columns = new Set(tableColumns(db, 'peertube_replays'));
  if (columns.has('recording_session_id') && columns.has('peertube_video_uuid')) {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_peertube_replays_session_uuid
      ON peertube_replays(recording_session_id, peertube_video_uuid)`);
  }
  if (columns.has('processing_state')) {
    db.exec('CREATE INDEX IF NOT EXISTS idx_peertube_replays_state ON peertube_replays(processing_state)');
  }
  if (columns.has('content_id')) {
    db.exec('CREATE INDEX IF NOT EXISTS idx_peertube_replays_content ON peertube_replays(content_id)');
  }
}

function migratePeerTubeReplay(db) {
  requirePrerequisites(db);
  const stamped = db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(MIGRATION_ID);
  if (stamped) {
    if (!validatePeerTubeReplaySchema(db)) {
      throw new Error('PeerTube replay migration is stamped but schema validation failed');
    }
    return { migrated: false, alreadyApplied: true };
  }

  const kind = classifyExisting(db);
  if (kind === 'v2') {
    const stampOnly = db.transaction(() => {
      if (!validatePeerTubeReplaySchema(db)) throw new Error('PeerTube replay schema validation failed');
      db.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(MIGRATION_ID);
    });
    stampOnly();
    return { migrated: false, stamped: true };
  }

  const migrate = db.transaction(() => {
    if (kind === 'prototype') {
      if (object(db, LEGACY_TABLE)) throw new Error(`PeerTube replay legacy backup already exists: ${LEGACY_TABLE}`);
      db.exec(`ALTER TABLE peertube_replays RENAME TO ${LEGACY_TABLE}`);
      movePrototypeIndexes(db);
    }
    createSchema(db);
    if (kind === 'prototype') migrateLegacyRowsToQuarantine(db);
    if (!validatePeerTubeReplaySchema(db)) throw new Error('PeerTube replay schema validation failed');
    db.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(MIGRATION_ID);
  });
  migrate();
  return { migrated: true, legacyPreserved: kind === 'prototype' };
}

function rollbackPeerTubeReplay(db) {
  const rollback = db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS peertube_replay_worker_status');
    db.exec('DROP TABLE IF EXISTS peertube_replay_worker_leases');
    db.exec('DROP TABLE IF EXISTS peertube_replay_revisions');
    db.exec('DROP TABLE IF EXISTS peertube_replay_quarantine');
    db.exec('DROP TABLE IF EXISTS peertube_replays');
    db.exec('DROP TABLE IF EXISTS peertube_recording_sessions');
    if (object(db, LEGACY_TABLE)) {
      db.exec(`ALTER TABLE ${LEGACY_TABLE} RENAME TO peertube_replays`);
      restorePrototypeIndexes(db);
    }
    db.prepare('DELETE FROM schema_migrations WHERE id = ?').run(MIGRATION_ID);
  });
  rollback();
}

module.exports = {
  MIGRATION_ID,
  LEGACY_TABLE,
  migratePeerTubeReplay,
  rollbackPeerTubeReplay,
  validatePeerTubeReplaySchema,
};
