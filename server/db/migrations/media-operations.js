'use strict';

const MEDIA_OPERATIONS_MIGRATION_ID = 'media_operations_v1';
const CONTENT_LIBRARY_OPERATIONS_MIGRATION_ID = 'content_library_operations_v1';

function tableExists(db, table) {
  return !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
  ).get(table);
}

function hasColumns(db, table, required) {
  if (!tableExists(db, table)) return false;
  const columns = new Set(
    db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name),
  );
  return required.every(column => columns.has(column));
}

function ensureMediaOperationsSchema(db) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('media operations migration requires a SQLite database');
  }
  if (!tableExists(db, 'content') || !tableExists(db, 'schema_migrations')) {
    throw new Error('media operations migration prerequisites are missing');
  }

  const migrate = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS content_captions (
        id                  TEXT PRIMARY KEY,
        content_id          TEXT NOT NULL REFERENCES content(id) ON DELETE CASCADE,
        workspace_id        TEXT,
        language_code       TEXT NOT NULL,
        label               TEXT NOT NULL,
        kind                TEXT NOT NULL DEFAULT 'captions'
                            CHECK (kind IN ('captions','subtitles')),
        is_default          INTEGER NOT NULL DEFAULT 0
                            CHECK (is_default IN (0,1)),
        source_type         TEXT NOT NULL DEFAULT 'upload'
                            CHECK (source_type IN ('upload','transcription','import')),
        source_format       TEXT NOT NULL,
        body_vtt            TEXT NOT NULL,
        search_text         TEXT,
        sha256              TEXT,
        cue_count           INTEGER NOT NULL DEFAULT 0 CHECK (cue_count >= 0),
        created_by          TEXT,
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_content_captions_content
      ON content_captions(content_id, language_code, created_at);

      CREATE INDEX IF NOT EXISTS idx_content_captions_workspace_search
      ON content_captions(workspace_id, search_text);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_content_captions_one_default
      ON content_captions(content_id)
      WHERE is_default=1;

      CREATE TABLE IF NOT EXISTS content_favorites (
        user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content_id          TEXT NOT NULL REFERENCES content(id) ON DELETE CASCADE,
        created_at          INTEGER NOT NULL,
        PRIMARY KEY (user_id, content_id)
      );

      CREATE INDEX IF NOT EXISTS idx_content_favorites_content
      ON content_favorites(content_id, user_id);

      CREATE TABLE IF NOT EXISTS content_saved_views (
        id                  TEXT PRIMARY KEY,
        workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name                TEXT NOT NULL,
        query_json          TEXT NOT NULL,
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_content_saved_views_owner
      ON content_saved_views(workspace_id, user_id, name COLLATE NOCASE);
    `);

    if (!hasColumns(db, 'content_captions', [
      'id', 'content_id', 'workspace_id', 'language_code', 'label', 'kind',
      'is_default', 'source_type', 'source_format', 'body_vtt', 'search_text',
      'sha256', 'cue_count', 'created_by', 'created_at', 'updated_at',
    ])) {
      throw new Error('media operations caption schema validation failed');
    }
    if (!hasColumns(db, 'content_favorites', [
      'user_id', 'content_id', 'created_at',
    ])) {
      throw new Error('media operations favorites schema validation failed');
    }
    if (!hasColumns(db, 'content_saved_views', [
      'id', 'workspace_id', 'user_id', 'name', 'query_json',
      'created_at', 'updated_at',
    ])) {
      throw new Error('media operations saved view schema validation failed');
    }
    db.prepare(
      'INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)',
    ).run(MEDIA_OPERATIONS_MIGRATION_ID);
    db.prepare(
      'INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)',
    ).run(CONTENT_LIBRARY_OPERATIONS_MIGRATION_ID);
  });

  migrate();
  return true;
}

module.exports = {
  MEDIA_OPERATIONS_MIGRATION_ID,
  CONTENT_LIBRARY_OPERATIONS_MIGRATION_ID,
  ensureMediaOperationsSchema,
};
