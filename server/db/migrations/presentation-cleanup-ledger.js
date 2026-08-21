'use strict';

const MIGRATION_ID = 'presentation_cleanup_ledger_v1';

function migratePresentationCleanupLedger(db) {
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS presentation_cleanup_operations (
      id TEXT PRIMARY KEY,
      presentation_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending','cleanup_pending','completed')),
      remaining_content_ids_json TEXT NOT NULL DEFAULT '[]',
      error_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_presentation_cleanup_state
      ON presentation_cleanup_operations(state, updated_at);`);
    db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(MIGRATION_ID);
  })();
}

module.exports = { MIGRATION_ID, migratePresentationCleanupLedger };
