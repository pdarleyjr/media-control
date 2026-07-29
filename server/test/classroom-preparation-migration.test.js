'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const {
  CLASSROOM_PREPARATION_SCHEMA_MIGRATION_ID,
  migrateClassroomPreparationSchema,
} = require('../db/migrations/classroom-preparation');

function legacyDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE schema_migrations (
      id TEXT PRIMARY KEY,
      ran_at INTEGER DEFAULT (strftime('%s', 'now')),
      checksum TEXT
    );
    CREATE TABLE node_assets (
      asset_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      desired INTEGER NOT NULL DEFAULT 1,
      sync_status TEXT NOT NULL DEFAULT 'pending',
      local_path TEXT,
      checksum_verified INTEGER NOT NULL DEFAULT 0,
      bytes_downloaded INTEGER,
      last_attempt_at INTEGER,
      last_success_at INTEGER,
      error_message TEXT,
      PRIMARY KEY (asset_id, node_id)
    );
  `);
  return db;
}

test('startup migration self-heals legacy node_assets before Content Library queries it', () => {
  const db = legacyDb();

  assert.equal(migrateClassroomPreparationSchema(db), true);
  assert.deepEqual(
    db.prepare('PRAGMA table_info(node_assets)').all()
      .map((column) => column.name)
      .filter((name) => name === 'generation' || name === 'updated_at')
      .sort(),
    ['generation', 'updated_at'],
  );
  assert.ok(db.prepare(
    'SELECT na.generation, na.updated_at FROM node_assets na LIMIT 1',
  ));
  assert.ok(db.prepare(
    'SELECT 1 FROM schema_migrations WHERE id=?',
  ).get(CLASSROOM_PREPARATION_SCHEMA_MIGRATION_ID));

  assert.equal(migrateClassroomPreparationSchema(db), true);
  assert.equal(
    db.prepare(
      'SELECT COUNT(*) AS count FROM schema_migrations WHERE id=?',
    ).get(CLASSROOM_PREPARATION_SCHEMA_MIGRATION_ID).count,
    1,
  );
  db.close();
});
