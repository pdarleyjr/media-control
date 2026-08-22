'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const {
  beginPresentationCleanup,
  processPresentationCleanup,
  reconcilePresentationCleanupOperations,
} = require('../services/presentation-cleanup');

function buildDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  db.exec(`
    CREATE TABLE schema_migrations (id TEXT PRIMARY KEY);
    CREATE TABLE presentations (id TEXT PRIMARY KEY, workspace_id TEXT);
    CREATE TABLE content (id TEXT PRIMARY KEY, workspace_id TEXT, library_scope TEXT);
    CREATE TABLE presentation_assets (
      presentation_id TEXT REFERENCES presentations(id) ON DELETE CASCADE,
      content_id TEXT
    );
    CREATE TABLE presentation_conversion_runs (
      presentation_id TEXT REFERENCES presentations(id) ON DELETE CASCADE,
      source_content_id TEXT
    );
    CREATE TABLE content_erase_operations (
      id TEXT PRIMARY KEY,
      content_id TEXT,
      state TEXT,
      created_at INTEGER
    );
    CREATE TABLE playlists (id TEXT PRIMARY KEY);
    CREATE TABLE playlist_items (id TEXT PRIMARY KEY, playlist_id TEXT, content_id TEXT);
    CREATE TABLE widgets (id TEXT PRIMARY KEY, name TEXT, config TEXT);
    INSERT INTO presentations VALUES ('deck-a','ws'),('deck-b','ws');
    INSERT INTO content VALUES
      ('unique-asset','ws','internal'),
      ('shared-asset','ws','internal'),
      ('source','ws','internal');
    INSERT INTO presentation_assets VALUES
      ('deck-a','unique-asset'),('deck-a','shared-asset'),('deck-b','shared-asset');
    INSERT INTO presentation_conversion_runs VALUES ('deck-a','source');
  `);
  return db;
}

test('presentation deletion is ledgered atomically and cleanup failure survives for startup retry', (t) => {
  const db = buildDb();
  t.after(() => db.close());
  const operationId = beginPresentationCleanup(db, {
    presentationId: 'deck-a', workspaceId: 'ws', operationId: 'cleanup-a',
  });
  assert.equal(db.prepare("SELECT COUNT(*) count FROM presentations WHERE id='deck-a'").get().count, 0);
  assert.equal(db.prepare("SELECT state FROM presentation_cleanup_operations WHERE id='cleanup-a'").get().state, 'pending');

  const first = processPresentationCleanup(db, operationId, {
    contentDir: '.',
    eraseContent(database, contentId) {
      if (contentId === 'source') {
        const error = new Error('forced byte failure');
        error.code = 'ERASE_BYTE_CLEANUP_FAILED';
        throw error;
      }
      database.prepare('DELETE FROM content WHERE id=?').run(contentId);
      return { success: true, impact: { cache: { asset_id: contentId, generation: 1, node_ids: [] } } };
    },
  });
  assert.equal(first.state, 'cleanup_pending');
  assert.deepEqual(first.skipped_shared, ['shared-asset']);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM content WHERE id='unique-asset'").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM content WHERE id='shared-asset'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM content WHERE id='source'").get().count, 1);

  const recovered = reconcilePresentationCleanupOperations(db, {
    contentDir: '.',
    eraseContent(database, contentId) {
      database.prepare('DELETE FROM content WHERE id=?').run(contentId);
      return { success: true, impact: { cache: { asset_id: contentId, generation: 1, node_ids: [] } } };
    },
  });
  assert.equal(recovered[0].state, 'completed');
  assert.equal(db.prepare("SELECT COUNT(*) count FROM content WHERE id='source'").get().count, 0);
  assert.equal(db.prepare("SELECT state FROM presentation_cleanup_operations WHERE id='cleanup-a'").get().state, 'completed');
});

test('cleanup remains pending until a separately ledgered erase completes', (t) => {
  const db = buildDb();
  t.after(() => db.close());
  const operationId = beginPresentationCleanup(db, {
    presentationId: 'deck-a', workspaceId: 'ws', operationId: 'cleanup-pending-erase',
  });

  const first = processPresentationCleanup(db, operationId, {
    contentDir: '.',
    eraseContent(database, contentId) {
      if (contentId === 'unique-asset') {
        database.prepare('DELETE FROM content WHERE id=?').run(contentId);
        database.prepare(`INSERT INTO content_erase_operations (id,content_id,state,created_at)
          VALUES ('erase-unique',?,'recovery_failed',1)`).run(contentId);
        return { success: false, operation_id: 'erase-unique' };
      }
      database.prepare('DELETE FROM content WHERE id=?').run(contentId);
      return { success: true, impact: { cache: { asset_id: contentId, generation: 1, node_ids: [] } } };
    },
  });
  assert.equal(first.state, 'cleanup_pending');
  assert.deepEqual(first.errors, [{
    content_id: 'unique-asset',
    code: 'PRESENTATION_ASSET_ERASE_PENDING',
    erase_operation_id: 'erase-unique',
  }]);

  db.prepare("UPDATE content_erase_operations SET state='completed' WHERE id='erase-unique'").run();
  const recovered = reconcilePresentationCleanupOperations(db, {
    contentDir: '.',
    eraseContent(database, contentId) {
      database.prepare('DELETE FROM content WHERE id=?').run(contentId);
      return { success: true, impact: { cache: { asset_id: contentId, generation: 1, node_ids: [] } } };
    },
  });
  assert.equal(recovered[0].state, 'completed');
  assert.equal(db.prepare("SELECT state FROM presentation_cleanup_operations WHERE id='cleanup-pending-erase'").get().state, 'completed');
});

test('a repeated delete cannot create an unbound cleanup operation after the presentation is gone', (t) => {
  const db = buildDb();
  t.after(() => db.close());
  beginPresentationCleanup(db, { presentationId: 'deck-a', workspaceId: 'ws', operationId: 'first' });
  assert.throws(() => beginPresentationCleanup(db, {
    presentationId: 'deck-a', workspaceId: 'ws', operationId: 'second',
  }), /changed before deletion/);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM presentation_cleanup_operations WHERE id='second'").get().count, 0);
});

test('a legacy internal image shared by a playlist or widget survives presentation cleanup unchanged', (t) => {
  const db = buildDb();
  t.after(() => db.close());
  db.prepare("INSERT INTO presentations VALUES ('deck-legacy','ws')").run();
  db.prepare("INSERT INTO content VALUES ('legacy-shared','ws','internal')").run();
  db.prepare("INSERT INTO presentation_assets VALUES ('deck-legacy','legacy-shared')").run();
  db.prepare("INSERT INTO playlists VALUES ('training')").run();
  db.prepare("INSERT INTO playlist_items VALUES ('item','training','legacy-shared')").run();
  const widgetConfig = JSON.stringify({ background: '/api/content/legacy-shared/file' });
  db.prepare("INSERT INTO widgets VALUES ('widget','Shared image',?)").run(widgetConfig);

  const operationId = beginPresentationCleanup(db, {
    presentationId: 'deck-legacy', workspaceId: 'ws', operationId: 'cleanup-legacy-shared',
  });
  const result = processPresentationCleanup(db, operationId, {
    contentDir: '.',
    eraseContent() { throw new Error('shared content must not enter permanent erase'); },
  });

  assert.equal(result.state, 'completed');
  assert.deepEqual(result.skipped_shared, ['legacy-shared']);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM content WHERE id='legacy-shared'").get().count, 1);
  assert.equal(db.prepare("SELECT content_id FROM playlist_items WHERE id='item'").get().content_id, 'legacy-shared');
  assert.equal(db.prepare("SELECT config FROM widgets WHERE id='widget'").get().config, widgetConfig);
});
