'use strict';

const MIGRATION_ID = 'presentation_asset_scope_v1';
const LIBRARY_SCOPE = Object.freeze({ LIBRARY: 'library', INTERNAL: 'internal' });

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function hasColumn(db, table, name) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((column) => column.name === name);
}

function validatePresentationAssetScope(db) {
  if (!tableExists(db, 'content') || !hasColumn(db, 'content', 'library_scope')) return false;
  const invalid = db.prepare(`SELECT COUNT(*) AS count FROM content
    WHERE library_scope NOT IN ('library','internal') OR library_scope IS NULL`).get();
  return Number(invalid?.count) === 0;
}

function migratePresentationAssetScope(db) {
  if (!db || typeof db.prepare !== 'function') throw new Error('presentation asset scope migration requires SQLite');
  for (const table of ['schema_migrations', 'content']) {
    if (!tableExists(db, table)) throw new Error(`presentation asset scope migration prerequisite missing: ${table}`);
  }
  const migrate = db.transaction(() => {
    if (!hasColumn(db, 'content', 'library_scope')) {
      db.exec("ALTER TABLE content ADD COLUMN library_scope TEXT NOT NULL DEFAULT 'library' CHECK (library_scope IN ('library','internal'))");
    }
    db.prepare(`UPDATE content SET library_scope='internal'
      WHERE content_type IN ('presentation_asset','presentation_image','presentation_source')`).run();
    db.exec(`CREATE INDEX IF NOT EXISTS idx_content_library_scope
      ON content(library_scope, workspace_id, archived_at, created_at DESC)`);
    if (!validatePresentationAssetScope(db)) throw new Error('presentation asset scope schema validation failed');
    db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(MIGRATION_ID);
  });
  migrate();
  return true;
}

module.exports = {
  LIBRARY_SCOPE,
  MIGRATION_ID,
  migratePresentationAssetScope,
  validatePresentationAssetScope,
};

