'use strict';

const MIGRATION_ID = 'content_erase_ledger_v1';

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function validateContentEraseLedger(db) {
  if (!tableExists(db, 'content_erase_operations')) return false;
  const columns = new Set(db.prepare("SELECT name FROM pragma_table_info('content_erase_operations')").all().map((row) => row.name));
  return ['id', 'content_id', 'state', 'file_manifest_json', 'error', 'created_at', 'updated_at', 'catalog_committed_at', 'completed_at']
    .every((column) => columns.has(column));
}

function migrateContentEraseLedger(db) {
  if (!db || typeof db.prepare !== 'function') throw new Error('content erase ledger migration requires SQLite');
  for (const table of ['schema_migrations', 'content']) {
    if (!tableExists(db, table)) throw new Error(`content erase ledger prerequisite missing: ${table}`);
  }
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS content_erase_operations (
      id TEXT PRIMARY KEY,
      content_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN (
        'prepared','staged','catalog_committed','cleanup_pending','completed','rolled_back','recovery_failed'
      )),
      file_manifest_json TEXT NOT NULL DEFAULT '[]',
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      catalog_committed_at INTEGER,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_content_erase_operations_state
      ON content_erase_operations(state, updated_at);
    CREATE INDEX IF NOT EXISTS idx_content_erase_operations_content
      ON content_erase_operations(content_id, created_at DESC);`);
    if (!validateContentEraseLedger(db)) throw new Error('content erase ledger schema validation failed');
    db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(MIGRATION_ID);
  })();
  return true;
}

module.exports = {
  MIGRATION_ID,
  migrateContentEraseLedger,
  validateContentEraseLedger,
};
