'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const {
  CONTENT_LIBRARY_OPERATIONS_MIGRATION_ID,
  ensureMediaOperationsSchema,
} = require('../db/migrations/media-operations');

const ROOT = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('media operations migration persists favorites and private saved views idempotently', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`
      CREATE TABLE schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
      CREATE TABLE users (id TEXT PRIMARY KEY);
      CREATE TABLE workspaces (id TEXT PRIMARY KEY);
      CREATE TABLE content (id TEXT PRIMARY KEY);
      INSERT INTO users VALUES ('u1');
      INSERT INTO workspaces VALUES ('w1');
      INSERT INTO content VALUES ('c1');
    `);

    assert.equal(ensureMediaOperationsSchema(db), true);
    assert.equal(ensureMediaOperationsSchema(db), true);
    db.prepare('INSERT INTO content_favorites (user_id, content_id, created_at) VALUES (?, ?, ?)').run(
      'u1', 'c1', 100,
    );
    db.prepare(`
      INSERT INTO content_saved_views
        (id, workspace_id, user_id, name, query_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('sv1', 'w1', 'u1', 'Ready videos', '{"type":"video"}', 100, 100);

    assert.deepEqual(
      db.prepare('SELECT user_id, content_id FROM content_favorites').get(),
      { user_id: 'u1', content_id: 'c1' },
    );
    assert.equal(
      db.prepare('SELECT query_json FROM content_saved_views WHERE id=?').get('sv1').query_json,
      '{"type":"video"}',
    );
    assert.ok(
      db.prepare('SELECT 1 FROM schema_migrations WHERE id=?').get(
        CONTENT_LIBRARY_OPERATIONS_MIGRATION_ID,
      ),
    );
  } finally {
    db.close();
  }
});

test('Media Library exposes the complete operational information architecture', () => {
  const source = read('frontend/js/views/content-library.js');
  const api = read('frontend/js/api.js');
  const english = read('frontend/js/i18n/en.js');
  const route = read('server/routes/content.js');

  for (const filter of [
    'processing',
    'codec',
    'dimensions',
    'source',
    'thumbnail',
    'p3',
    'favorite',
  ]) {
    assert.match(source, new RegExp(`${filter}:\\s*''`), `missing ${filter} filter state`);
    assert.match(api, new RegExp(`filters\\.${filter}`), `API does not send ${filter}`);
    assert.match(route, new RegExp(`req\\.query\\.${filter}`), `route does not apply ${filter}`);
  }

  for (const contract of [
    'data-favorite-content',
    'data-saved-view',
    'data-save-view',
    'data-delete-view',
    'data-bulk-tags',
    'data-bulk-restore',
    'content.duplicate_warning',
    'content.retention_original',
    'content.storage_summary',
  ]) {
    assert.match(source, new RegExp(contract.replace('.', '\\.')), `missing UI contract ${contract}`);
  }

  for (const key of [
    'content.filter_processing',
    'content.filter_codec',
    'content.filter_dimensions',
    'content.filter_source',
    'content.filter_thumbnail',
    'content.filter_p3',
    'content.filter_favorites',
    'content.saved_views',
    'content.bulk_tags',
    'content.bulk_restore',
    'content.duplicate_warning',
    'content.retention_original',
    'content.storage_summary',
  ]) {
    assert.match(english, new RegExp(key.replace('.', '\\.')), `English is missing ${key}`);
  }
});
