'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { migratePresentationStudioV2, validatePresentationStudioV2Schema, MIGRATION_ID } = require('../db/migrations/presentation-studio-v2');

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE schema_migrations (id TEXT PRIMARY KEY);
    CREATE TABLE workspaces (id TEXT PRIMARY KEY);
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE content (id TEXT PRIMARY KEY);
    CREATE TABLE media_jobs (id TEXT PRIMARY KEY);
    CREATE TABLE presentations (id TEXT PRIMARY KEY);
    CREATE TABLE presentation_exports (
      id TEXT PRIMARY KEY,
      presentation_id TEXT NOT NULL REFERENCES presentations(id) ON DELETE CASCADE,
      export_format TEXT NOT NULL,
      file_path TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      error_msg TEXT,
      created_at INTEGER NOT NULL DEFAULT 0,
      completed_at INTEGER
    );
  `);
  return db;
}

test('presentation studio v2 migration is additive and idempotent', (t) => {
  const db = makeDb();
  t.after(() => db.close());
  db.prepare("INSERT INTO presentations(id) VALUES ('legacy-deck')").run();
  db.prepare("INSERT INTO presentation_exports(id,presentation_id,export_format) VALUES ('legacy-export','legacy-deck','pptx')").run();
  migratePresentationStudioV2(db);
  migratePresentationStudioV2(db);
  assert.equal(validatePresentationStudioV2Schema(db), true);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='presentation_conversion_runs'").get());
  assert.ok(db.prepare('SELECT 1 FROM schema_migrations WHERE id=?').get(MIGRATION_ID));
  assert.equal(db.prepare("SELECT COUNT(*) count FROM presentations WHERE id='legacy-deck'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM presentation_exports WHERE id='legacy-export'").get().count, 1);
  for (const column of ['content_id', 'workspace_id', 'user_id', 'wall_profile', 'source_revision', 'generated_at']) {
    assert.ok(db.prepare('PRAGMA table_info(presentation_exports)').all().some((item) => item.name === column), column);
  }
});

test('old image can ignore additive presentation export columns', (t) => {
  const db = makeDb();
  t.after(() => db.close());
  migratePresentationStudioV2(db);
  db.prepare("INSERT INTO presentations(id) VALUES ('deck')").run();
  db.prepare("INSERT INTO presentation_exports(id,presentation_id,export_format,status) VALUES ('export','deck','pptx','pending')").run();
  assert.equal(db.prepare("SELECT export_format,status FROM presentation_exports WHERE id='export'").get().export_format, 'pptx');
});
