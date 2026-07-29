'use strict';

const CLASSROOM_PREPARATION_SCHEMA_MIGRATION_ID = 'classroom_preparation_schema_v1';

function migrateClassroomPreparationSchema(db) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('classroom preparation migration requires a SQLite database');
  }

  const migrate = db.transaction(() => {
    const columns = new Set(
      db.prepare('PRAGMA table_info(node_assets)').all().map((column) => column.name),
    );
    if (!columns.size) {
      throw new Error('classroom preparation migration requires node_assets');
    }
    if (!columns.has('generation')) {
      db.exec('ALTER TABLE node_assets ADD COLUMN generation INTEGER');
    }
    if (!columns.has('updated_at')) {
      db.exec('ALTER TABLE node_assets ADD COLUMN updated_at INTEGER');
    }

    const migratedColumns = new Set(
      db.prepare('PRAGMA table_info(node_assets)').all().map((column) => column.name),
    );
    if (!migratedColumns.has('generation') || !migratedColumns.has('updated_at')) {
      throw new Error('classroom preparation node_assets validation failed');
    }
    db.prepare(
      'INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)',
    ).run(CLASSROOM_PREPARATION_SCHEMA_MIGRATION_ID);
  });

  migrate();
  return true;
}

module.exports = {
  CLASSROOM_PREPARATION_SCHEMA_MIGRATION_ID,
  migrateClassroomPreparationSchema,
};
