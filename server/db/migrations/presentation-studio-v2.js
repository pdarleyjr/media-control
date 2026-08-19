'use strict';

const MIGRATION_ID = 'presentation_studio_v2';

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function columns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

function addColumn(db, table, name, definition) {
  if (!columns(db, table).has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

function validatePresentationStudioV2Schema(db) {
  if (!tableExists(db, 'presentation_exports') || !tableExists(db, 'presentation_conversion_runs')) return false;
  const required = ['content_id', 'workspace_id', 'user_id', 'wall_profile', 'source_revision', 'generated_at'];
  return required.every((column) => columns(db, 'presentation_exports').has(column));
}

function migratePresentationStudioV2(db) {
  if (!db || typeof db.prepare !== 'function') throw new Error('presentation studio v2 migration requires SQLite');
  for (const table of ['schema_migrations', 'presentations', 'presentation_exports', 'content', 'media_jobs']) {
    if (!tableExists(db, table)) throw new Error(`presentation studio v2 migration prerequisite missing: ${table}`);
  }
  const migrate = db.transaction(() => {
    addColumn(db, 'presentation_exports', 'content_id', 'TEXT REFERENCES content(id) ON DELETE SET NULL');
    addColumn(db, 'presentation_exports', 'workspace_id', 'TEXT REFERENCES workspaces(id) ON DELETE CASCADE');
    addColumn(db, 'presentation_exports', 'user_id', 'TEXT REFERENCES users(id) ON DELETE SET NULL');
    addColumn(db, 'presentation_exports', 'wall_profile', 'TEXT');
    addColumn(db, 'presentation_exports', 'source_revision', 'INTEGER');
    addColumn(db, 'presentation_exports', 'generated_at', 'INTEGER');
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_presentation_exports_presentation
      ON presentation_exports(presentation_id, export_format, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_presentation_exports_content
      ON presentation_exports(content_id) WHERE content_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_presentation_exports_workspace
      ON presentation_exports(workspace_id, user_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS presentation_conversion_runs (
        job_id            TEXT PRIMARY KEY REFERENCES media_jobs(id) ON DELETE CASCADE,
        presentation_id   TEXT UNIQUE REFERENCES presentations(id) ON DELETE SET NULL,
        source_content_id TEXT REFERENCES content(id) ON DELETE SET NULL,
        workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at        INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_presentation_conversion_runs_owner
      ON presentation_conversion_runs(workspace_id, user_id, created_at DESC);
    `);
    if (!validatePresentationStudioV2Schema(db)) throw new Error('presentation studio v2 schema validation failed');
    db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(MIGRATION_ID);
  });
  migrate();
  return true;
}

module.exports = { MIGRATION_ID, migratePresentationStudioV2, validatePresentationStudioV2Schema };
