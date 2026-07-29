'use strict';

const MEDIA_PIPELINE_MIGRATION_ID = 'media_pipeline_v1';

const MEDIA_JOB_STATUS = Object.freeze([
  'queued',
  'running',
  'retry_wait',
  'completed',
  'failed',
  'cancelled',
]);

const MEDIA_JOB_STAGES = Object.freeze([
  'received',
  'validating',
  'probing',
  'optimizing',
  'thumbnail',
  'checksum',
  'preparing',
  'ready',
  'failed',
  'cancelled',
]);

function quotedList(values) {
  return values.map((value) => `'${value}'`).join(',');
}

function hasRequiredColumns(db, table, required) {
  const columns = new Set(
    db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name),
  );
  return required.every((column) => columns.has(column));
}

function addColumnIfMissing(db, table, column, definition) {
  if (!hasRequiredColumns(db, table, [column])) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function validateMediaPipelineSchema(db) {
  return hasRequiredColumns(db, 'media_jobs', [
    'id', 'content_id', 'workspace_id', 'job_type', 'status', 'stage',
    'progress_pct', 'attempts', 'max_attempts', 'lease_owner',
    'lease_expires_at', 'reserved_bytes', 'expected_version', 'expected_filepath',
  ]) && hasRequiredColumns(db, 'content_media_metadata', [
    'content_id', 'source_type', 'source_identity', 'detected_mime_type',
    'thumbnail_generation', 'remote_health_status', 'remote_source_kind',
    'updated_at',
  ]);
}

function migrateContentSearch(db) {
  const hasUsers = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'",
  ).get();
  if (!hasUsers || !hasRequiredColumns(db, 'content', [
    'id', 'user_id', 'filename', 'tags_json', 'metadata_json',
  ])) return false;
  try {
    const migrate = db.transaction(() => db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS content_fts USING fts5(
        content_id UNINDEXED,
        filename,
        tags,
        description,
        owner,
        tokenize='unicode61 remove_diacritics 2'
      );

      DELETE FROM content_fts;
      INSERT INTO content_fts (content_id, filename, tags, description, owner)
      SELECT
        c.id,
        COALESCE(c.filename, ''),
        COALESCE(c.tags_json, ''),
        CASE
          WHEN json_valid(c.metadata_json)
            THEN COALESCE(json_extract(c.metadata_json, '$.description'), '')
          ELSE COALESCE(c.metadata_json, '')
        END,
        TRIM(COALESCE(u.name, '') || ' ' || COALESCE(u.email, ''))
      FROM content c
      LEFT JOIN users u ON u.id=c.user_id;

      CREATE TRIGGER IF NOT EXISTS content_fts_insert
      AFTER INSERT ON content
      BEGIN
        INSERT INTO content_fts (content_id, filename, tags, description, owner)
        VALUES (
          NEW.id,
          COALESCE(NEW.filename, ''),
          COALESCE(NEW.tags_json, ''),
          CASE
            WHEN json_valid(NEW.metadata_json)
              THEN COALESCE(json_extract(NEW.metadata_json, '$.description'), '')
            ELSE COALESCE(NEW.metadata_json, '')
          END,
          COALESCE((
            SELECT TRIM(COALESCE(name, '') || ' ' || COALESCE(email, ''))
            FROM users WHERE id=NEW.user_id
          ), '')
        );
      END;

      CREATE TRIGGER IF NOT EXISTS content_fts_update
      AFTER UPDATE OF filename, tags_json, metadata_json, user_id ON content
      BEGIN
        DELETE FROM content_fts WHERE content_id=OLD.id;
        INSERT INTO content_fts (content_id, filename, tags, description, owner)
        VALUES (
          NEW.id,
          COALESCE(NEW.filename, ''),
          COALESCE(NEW.tags_json, ''),
          CASE
            WHEN json_valid(NEW.metadata_json)
              THEN COALESCE(json_extract(NEW.metadata_json, '$.description'), '')
            ELSE COALESCE(NEW.metadata_json, '')
          END,
          COALESCE((
            SELECT TRIM(COALESCE(name, '') || ' ' || COALESCE(email, ''))
            FROM users WHERE id=NEW.user_id
          ), '')
        );
      END;

      CREATE TRIGGER IF NOT EXISTS content_fts_delete
      AFTER DELETE ON content
      BEGIN
        DELETE FROM content_fts WHERE content_id=OLD.id;
      END;

      CREATE TRIGGER IF NOT EXISTS content_fts_user_update
      AFTER UPDATE OF name, email ON users
      BEGIN
        UPDATE content_fts
        SET owner=TRIM(COALESCE(NEW.name, '') || ' ' || COALESCE(NEW.email, ''))
        WHERE content_id IN (SELECT id FROM content WHERE user_id=NEW.id);
      END;
    `));
    migrate();
    return true;
  } catch (error) {
    // FTS5 is optional in SQLite builds. Listing retains a parameterized LIKE
    // fallback, so the media migration must remain deployable without it.
    if (/no such module: fts5|no such function: json_/i.test(error.message)) return false;
    throw error;
  }
}

function migrateMediaPipeline(db) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('media pipeline migration requires a SQLite database');
  }
  for (const table of ['schema_migrations', 'content']) {
    if (!db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
    ).get(table)) {
      throw new Error(`media pipeline migration prerequisite missing: ${table}`);
    }
  }

  const migrate = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS media_jobs (
        id                TEXT PRIMARY KEY,
        content_id        TEXT REFERENCES content(id) ON DELETE CASCADE,
        workspace_id      TEXT NOT NULL,
        user_id           TEXT,
        job_type          TEXT NOT NULL,
        source_type       TEXT,
        source_identity   TEXT,
        idempotency_key   TEXT,
        expected_version  INTEGER,
        expected_filepath TEXT,
        expected_sha256   TEXT,
        status            TEXT NOT NULL DEFAULT 'queued'
                          CHECK (status IN (${quotedList(MEDIA_JOB_STATUS)})),
        stage             TEXT NOT NULL DEFAULT 'received'
                          CHECK (stage IN (${quotedList(MEDIA_JOB_STAGES)})),
        progress_pct      INTEGER NOT NULL DEFAULT 0
                          CHECK (progress_pct BETWEEN 0 AND 100),
        attempts          INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        max_attempts      INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 20),
        reserved_bytes    INTEGER NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
        available_at      INTEGER NOT NULL,
        lease_owner       TEXT,
        lease_expires_at  INTEGER,
        cancel_requested  INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0,1)),
        error_code        TEXT,
        error_message     TEXT,
        retryable         INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0,1)),
        payload_json      TEXT,
        result_json       TEXT,
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL,
        started_at        INTEGER,
        completed_at      INTEGER
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_media_jobs_idempotency
      ON media_jobs(workspace_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_media_jobs_claim
      ON media_jobs(status, available_at, lease_expires_at, created_at);

      CREATE INDEX IF NOT EXISTS idx_media_jobs_content
      ON media_jobs(content_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS media_job_events (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id       TEXT NOT NULL REFERENCES media_jobs(id) ON DELETE CASCADE,
        status       TEXT NOT NULL,
        stage        TEXT NOT NULL,
        progress_pct INTEGER NOT NULL,
        detail_json  TEXT,
        created_at   INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_media_job_events_job
      ON media_job_events(job_id, id);

      CREATE TABLE IF NOT EXISTS content_media_metadata (
        content_id                TEXT PRIMARY KEY REFERENCES content(id) ON DELETE CASCADE,
        workspace_id              TEXT,
        source_type               TEXT,
        source_identity           TEXT,
        source_url                TEXT,
        detected_mime_type        TEXT,
        detected_extension        TEXT,
        source_sha256             TEXT,
        container                 TEXT,
        video_codec               TEXT,
        video_profile             TEXT,
        pixel_format              TEXT,
        color_transfer            TEXT,
        audio_codec               TEXT,
        audio_profile             TEXT,
        audio_sample_format       TEXT,
        audio_channels            INTEGER,
        audio_channel_layout      TEXT,
        duration_sec              REAL,
        bitrate_bps               INTEGER,
        frame_rate                REAL,
        thumbnail_generation      INTEGER,
        thumbnail_source_sha256   TEXT,
        thumbnail_source_filepath TEXT,
        thumbnail_provenance      TEXT,
        remote_health_status      TEXT,
        remote_source_kind        TEXT,
        remote_last_validated_at  INTEGER,
        remote_error_code         TEXT,
        remote_final_url          TEXT,
        remote_content_length     INTEGER,
        remote_range_supported    INTEGER,
        remote_cors_allowed       INTEGER,
        remote_etag               TEXT,
        remote_last_modified      TEXT,
        created_at                INTEGER NOT NULL,
        updated_at                INTEGER NOT NULL
      );

      DROP INDEX IF EXISTS idx_content_media_source_identity;
      UPDATE content_media_metadata
      SET source_identity=NULL
      WHERE source_type='youtube'
        AND source_identity IS NOT NULL
        AND rowid NOT IN (
          SELECT MIN(rowid)
          FROM content_media_metadata
          WHERE source_type='youtube' AND source_identity IS NOT NULL
          GROUP BY workspace_id, source_type, source_identity
        );
      CREATE UNIQUE INDEX idx_content_media_source_identity
      ON content_media_metadata(workspace_id, source_type, source_identity)
      WHERE source_identity IS NOT NULL AND source_type='youtube';

      CREATE INDEX IF NOT EXISTS idx_content_media_remote_health
      ON content_media_metadata(workspace_id, remote_health_status, remote_last_validated_at);
    `);

    addColumnIfMissing(
      db,
      'media_jobs',
      'reserved_bytes',
      'INTEGER NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0)',
    );
    addColumnIfMissing(db, 'content_media_metadata', 'remote_source_kind', 'TEXT');
    addColumnIfMissing(db, 'content_media_metadata', 'remote_etag', 'TEXT');
    addColumnIfMissing(db, 'content_media_metadata', 'remote_last_modified', 'TEXT');

    if (!validateMediaPipelineSchema(db)) {
      throw new Error('media pipeline schema validation failed');
    }
    db.prepare(
      'INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)',
    ).run(MEDIA_PIPELINE_MIGRATION_ID);
  });

  migrate();
  migrateContentSearch(db);
  return true;
}

module.exports = {
  MEDIA_JOB_STATUS,
  MEDIA_JOB_STAGES,
  MEDIA_PIPELINE_MIGRATION_ID,
  migrateMediaPipeline,
  migrateContentSearch,
  validateMediaPipelineSchema,
};
