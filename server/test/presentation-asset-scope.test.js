'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const {
  MIGRATION_ID,
  migratePresentationAssetScope,
  validatePresentationAssetScope,
} = require('../db/migrations/presentation-asset-scope');

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE schema_migrations (id TEXT PRIMARY KEY);
    CREATE TABLE content (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      archived_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT 0,
      content_type TEXT
    );
    INSERT INTO content(id, content_type) VALUES
      ('ordinary', 'video'),
      ('converted', 'presentation_asset'),
      ('studio-upload', 'presentation_image'),
      ('converter-source', 'presentation_source');
  `);
  return db;
}

test('presentation asset scope migration is additive, idempotent, and backfills definite internals', (t) => {
  const db = makeDb();
  t.after(() => db.close());
  migratePresentationAssetScope(db);
  migratePresentationAssetScope(db);
  assert.equal(validatePresentationAssetScope(db), true);
  assert.equal(db.prepare("SELECT library_scope FROM content WHERE id='ordinary'").get().library_scope, 'library');
  assert.equal(db.prepare("SELECT library_scope FROM content WHERE id='converted'").get().library_scope, 'internal');
  assert.equal(db.prepare("SELECT library_scope FROM content WHERE id='studio-upload'").get().library_scope, 'internal');
  assert.equal(db.prepare("SELECT library_scope FROM content WHERE id='converter-source'").get().library_scope, 'internal');
  assert.ok(db.prepare('SELECT 1 FROM schema_migrations WHERE id=?').get(MIGRATION_ID));
});

test('older insert statements continue to create ordinary library content', (t) => {
  const db = makeDb();
  t.after(() => db.close());
  migratePresentationAssetScope(db);
  db.prepare("INSERT INTO content(id,content_type) VALUES ('old-image-upload','image')").run();
  assert.equal(db.prepare("SELECT library_scope FROM content WHERE id='old-image-upload'").get().library_scope, 'library');
});
